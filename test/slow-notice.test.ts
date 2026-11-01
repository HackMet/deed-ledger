import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { JobHandler, PendienteItem, Pendientes, SlowReplyPendiente, Tenant } from "../src/application/ports";
import { COPY } from "../src/domain/replies";
import { SLOW_NOTICE_AFTER_MS, SLOW_NOTICE_LOOKBACK_MS } from "../src/domain/slow-notice";
import { hookDb } from "./helpers/fakes";
import { type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedIntroducedCustomer, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

// The sweep spans every store and storage is shared within this file, so every assertion is
// scoped to the store under test, and every test lets its stalled job finish.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ANSWER = "Respuesta de prueba.";
// No time promise: nobody knows when the answer goes out.
const NOTICE = "Recibimos tu mensaje, lo estamos revisando.";

class RecordingPendientes implements Pendientes {
  items: Array<{ tenant: Tenant; item: PendienteItem | SlowReplyPendiente }> = [];
  async raise(tenant: Tenant, item: PendienteItem | SlowReplyPendiente): Promise<void> {
    this.items.push({ tenant, item });
  }
  of(businessId: string) {
    return this.items.filter((entry) => entry.tenant.businessId === businessId).map((entry) => entry.item);
  }
}

/**
 * Stands in for a model that stalls: every job waits, under its live lease, until released. Then
 * the burst's newest job answers.
 */
function stallingHandler() {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const handler: JobHandler = {
    async handle({ isNewestOfBurst }) {
      entered();
      await gate;
      return { replies: isNewestOfBurst ? [{ body: ANSWER, ttlMs: HOUR, closesBurst: true }] : [] };
    },
  };
  return { handler, release, started };
}

interface Setup {
  readonly h: Harness;
  readonly pendientes: RecordingPendientes;
  readonly stall: ReturnType<typeof stallingHandler>;
  readonly businessId: string;
  readonly phone: string;
  /** Our receive time of the burst's first message. */
  readonly t0: number;
  /** The queue consumer, stuck in the stalled job until released. */
  readonly running: Promise<unknown>;
}

async function stalledBurst(messages: number, db?: (db: D1Database) => D1Database): Promise<Setup> {
  const pendientes = new RecordingPendientes();
  const stall = stallingHandler();
  const h = harness({ jobHandler: stall.handler, pendientes, ...(db === undefined ? {} : { db: db(env.DB) }) });
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  const t0 = h.clock.now();
  for (let n = 0; n < messages; n++) {
    if (n > 0) h.clock.advance(1_000);
    const body = webhook(store.phoneNumberId, {
      messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body: `Mensaje ${n + 1}` })],
    });
    expect((await h.post(body)).status).toBe(200);
  }
  h.clock.advance(4_000); // settled
  const [first] = h.takeRingsFor(store.businessId);
  const running = h.deliver([first!]);
  await stall.started;
  return { h, pendientes, stall, businessId: store.businessId, phone, t0, running };
}

async function finish(setup: Setup): Promise<void> {
  setup.stall.release();
  await setup.running;
}

async function notices(businessId: string) {
  return rows<{ id: string; kind: string; job_id: string | null; claims_json: string | null; status: string }>(
    `SELECT id, kind, job_id, claims_json, status FROM outbound_messages WHERE business_id = ? AND kind = 'slow_notice'`,
    businessId,
  );
}

async function slowBursts(h: Harness, businessId: string) {
  const now = h.clock.now();
  const found = await h.deps.jobs.findSlowBursts(now - SLOW_NOTICE_AFTER_MS, now - HOUR, 1_000);
  return found.filter((burst) => burst.businessId === businessId);
}

async function oldestMessageId(businessId: string): Promise<string> {
  const [row] = await rows<{ id: string }>(
    `SELECT id FROM inbound_messages WHERE business_id = ? ORDER BY received_at_ms, id LIMIT 1`,
    businessId,
  );
  return row!.id;
}

describe("the two-minute message", () => {
  it("tells a burst of three, stalled under a live lease, once; raises it as urgent; then the answer follows", async () => {
    const setup = await stalledBurst(3);
    const { h, businessId, phone, t0, pendientes } = setup;
    expect(COPY.slowNotice).toBe(NOTICE);

    for (const at of [MINUTE, 2 * MINUTE]) {
      h.clock.ms = t0 + at;
      await h.runCron();
    }
    expect(await notices(businessId)).toEqual([]);
    expect(h.sentTo(phone)).toEqual([]);

    h.clock.ms = t0 + 3 * MINUTE;
    await h.runCron();
    // Later sweeps, the job still stalled, add nothing.
    for (const at of [4 * MINUTE, 5 * MINUTE]) {
      h.clock.ms = t0 + at;
      await h.runCron();
    }

    const [notice, ...more] = await notices(businessId);
    expect(more).toEqual([]);
    // No job group, so its fate never stops the answer; no claims, so the claim check passes it
    // (no engine is wired here: a row with any claim would go out as the safe reply instead).
    expect(notice).toMatchObject({ kind: "slow_notice", job_id: null, claims_json: null, status: "sent" });
    expect(h.sentTo(phone)).toEqual([NOTICE]);

    const items = pendientes.of(businessId);
    expect(items).toEqual([
      {
        kind: "slow_reply",
        urgency: "urgent",
        conversationId: expect.any(String),
        inboundId: await oldestMessageId(businessId),
        outboxId: notice!.id,
      },
    ]);

    await finish(setup);
    expect(h.sentTo(phone)).toEqual([NOTICE, ANSWER]);

    // Logs carry IDs only.
    const logged = h.log.lines.join("\n");
    expect(logged).not.toContain(phone);
    expect(logged).not.toContain(NOTICE);
    expect(h.log.fields("slow_notice_queued")).toEqual([
      { level: "warn", event: "slow_notice_queued", businessId, conversationId: expect.any(String), inboundId: expect.any(String), outboxId: notice!.id },
    ]);
  });

  it.each([5_000, 30_000, 59_999])(
    "with the cron's first tick %i ms after the message, the notice lands after 2 minutes and by 3",
    async (offset) => {
      const setup = await stalledBurst(1);
      const { h, businessId, t0 } = setup;
      let queuedAt: number | null = null;
      for (let tick = offset; tick <= 5 * MINUTE && queuedAt === null; tick += MINUTE) {
        h.clock.ms = t0 + tick;
        await h.runCron();
        if ((await notices(businessId)).length > 0) queuedAt = tick;
      }
      expect(queuedAt).not.toBeNull();
      expect(queuedAt!).toBeGreaterThan(SLOW_NOTICE_AFTER_MS);
      expect(queuedAt!).toBeLessThanOrEqual(SLOW_NOTICE_AFTER_MS + MINUTE);
      await finish(setup);
    },
  );

  it("isn't queued when the answer already went", async () => {
    const pendientes = new RecordingPendientes();
    const h = harness({ pendientes });
    const phone = newPhone();
    const store = await seedStore({ members: [{ phone, role: "owner" }] });
    // A returning customer, already introduced (#30): this test counts replies.
    await seedIntroducedCustomer(store, phone);
    const t0 = h.clock.now();
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(t0 / 1000), body: "Hola" })] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
    expect(h.sentTo(phone)).toHaveLength(1);

    h.clock.ms = t0 + 3 * MINUTE;
    await h.runCron();
    expect(await notices(store.businessId)).toEqual([]);
    expect(pendientes.of(store.businessId)).toEqual([]);
  });

  it("isn't queued when the answer is written between the sweep's scan and its write", async () => {
    let setup: Setup | null = null;
    // The answer lands right after the sweep found the burst slow, before it writes the notice.
    const raced = await stalledBurst(2, (db) =>
      hookDb(db, /i\.received_at_ms < \? AND i\.received_at_ms >= \?/, async () => {
        if (setup !== null) await finish(setup);
      }),
    );
    setup = raced;
    const { h, businessId, phone, t0, pendientes } = raced;

    h.clock.ms = t0 + 3 * MINUTE;
    await h.runCron();
    expect(h.log.fields("slow_notice_queued")).toEqual([]);
    expect(await notices(businessId)).toEqual([]);
    expect(pendientes.of(businessId)).toEqual([]);
    expect(h.sentTo(phone)).toEqual([ANSWER]);
  });

  it("is queued once by two sweeps running at the same time", async () => {
    const setup = await stalledBurst(3);
    const { h, businessId, t0, pendientes } = setup;
    h.clock.ms = t0 + 3 * MINUTE;
    await Promise.all([h.runCron(), h.runCron()]);
    expect(await notices(businessId)).toHaveLength(1);
    expect(pendientes.of(businessId)).toHaveLength(1);
    await finish(setup);
  });

  it("is queued once when a second sweep runs between the first one's scan and its write", async () => {
    let other: Harness | null = null;
    const setup = await stalledBurst(3, (db) =>
      hookDb(db, /i\.received_at_ms < \? AND i\.received_at_ms >= \?/, async () => {
        await other?.runCron();
      }),
    );
    const { h, businessId, t0, pendientes } = setup;
    other = harness({ clock: h.clock, pendientes });
    h.clock.ms = t0 + 3 * MINUTE;
    await h.runCron();
    expect(await notices(businessId)).toHaveLength(1);
    expect(pendientes.of(businessId)).toHaveLength(1);
    await finish(setup);
  });

  it("is refused by the dedupe key even when the 'nothing written since' check would let it through", async () => {
    const setup = await stalledBurst(1);
    const { h, businessId, t0 } = setup;
    h.clock.ms = t0 + 3 * MINUTE;
    const [burst] = await slowBursts(h, businessId);
    expect(burst).toBeDefined();
    await h.runCron();
    const [first] = await notices(businessId);
    // Make the first notice look older than the burst, so only the UNIQUE dedupe key stands.
    await env.DB.prepare(`UPDATE outbound_messages SET created_at_ms = ? WHERE id = ?`).bind(t0 - 1, first!.id).run();
    const written = await h.deps.jobs.queueSlowNotice(
      burst!,
      { id: crypto.randomUUID(), kind: "slow_notice", body: NOTICE, dedupeKey: `slow_notice:${burst!.inboundId}`, expiresAtMs: h.clock.now() + HOUR, claims: [] },
      h.clock.now(),
    );
    expect(written).toBe(false);
    expect(await notices(businessId)).toHaveLength(1);
    await finish(setup);
  });

  it("a notice that couldn't be sent doesn't stop the real answer", async () => {
    const setup = await stalledBurst(1);
    const { h, businessId, phone, t0 } = setup;
    h.channel.nextResults.push({ ok: false, disposition: "permanent", errorCode: "test_permanent" });
    h.clock.ms = t0 + 3 * MINUTE;
    await h.runCron();
    expect(await notices(businessId)).toMatchObject([{ status: "failed" }]);
    // Once per burst, even now that the failed notice no longer counts as written: later sweeps
    // neither pick the burst up again nor raise a second item.
    for (const at of [4 * MINUTE, 5 * MINUTE]) {
      h.clock.ms = t0 + at;
      await h.runCron();
    }
    expect(await slowBursts(h, businessId)).toEqual([]);
    expect(await notices(businessId)).toHaveLength(1);
    expect(setup.pendientes.of(businessId)).toHaveLength(1);
    await finish(setup);
    expect(h.sentTo(phone)).toEqual([ANSWER]);
  });

  it.each(["failed to send", "reported failed by WhatsApp"] as const)(
    "is queued, and raised, when the only reply since the burst began %s",
    async (how) => {
      // The first message's job writes a reply; the second stalls. That reply never reaches the
      // customer, so the stalled second message is left with silence.
      const pendientes = new RecordingPendientes();
      const stall = stallingHandler();
      let calls = 0;
      const handler: JobHandler = {
        async handle(input) {
          calls++;
          if (calls === 1) return { replies: [{ body: "Parte uno.", ttlMs: HOUR }] };
          return stall.handler.handle(input);
        },
      };
      const h = harness({ jobHandler: handler, pendientes });
      const phone = newPhone();
      const store = await seedStore({ members: [{ phone, role: "owner" }] });
      const businessId = store.businessId;
      const t0 = h.clock.now();
      for (let n = 0; n < 2; n++) {
        if (n > 0) h.clock.advance(1_000);
        const body = webhook(store.phoneNumberId, {
          messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body: `Mensaje ${n + 1}` })],
        });
        expect((await h.post(body)).status).toBe(200);
      }
      if (how === "failed to send") {
        h.channel.nextResults.push({ ok: false, disposition: "permanent", errorCode: "test_permanent" });
      }
      h.clock.advance(4_000);
      const running = h.deliver(h.takeRingsFor(businessId));
      await stall.started;

      // Whenever the first reply's send settles, by 4 minutes the burst has its notice.
      for (const at of [3 * MINUTE, 4 * MINUTE]) {
        h.clock.ms = t0 + at;
        if (how === "reported failed by WhatsApp") {
          await env.DB.prepare(
            `UPDATE outbound_messages SET provider_status = 'failed', provider_status_rank = 5
             WHERE business_id = ? AND kind <> 'slow_notice' AND status = 'sent'`,
          )
            .bind(businessId)
            .run();
        }
        await h.runCron();
      }

      const replies = await rows<{ kind: string; status: string; provider_status: string | null }>(
        `SELECT kind, status, provider_status FROM outbound_messages WHERE business_id = ? ORDER BY seq`,
        businessId,
      );
      expect(replies[0]).toMatchObject(
        how === "failed to send" ? { status: "failed" } : { status: "sent", provider_status: "failed" },
      );
      const [notice, ...more] = await notices(businessId);
      expect(more).toEqual([]);
      expect(notice).toBeDefined();
      expect(h.sentTo(phone)).toContain(NOTICE);
      expect(pendientes.of(businessId)).toMatchObject([{ kind: "slow_reply", urgency: "urgent", outboxId: notice!.id }]);

      stall.release();
      await running;
    },
  );

  it("isn't queued while the reply since the burst began is still on its way", async () => {
    const setup = await stalledBurst(1);
    const { h, businessId, t0, pendientes } = setup;
    // A row written to the conversation after the burst began; only its status matters here, so it
    // goes in through queueSlowNotice under a key that isn't a slow notice's.
    h.clock.ms = t0 + 3 * MINUTE;
    const [burst] = await slowBursts(h, businessId);
    await h.deps.jobs.queueSlowNotice(
      burst!,
      { id: crypto.randomUUID(), kind: "slow_notice", body: NOTICE, dedupeKey: "test:on-its-way", expiresAtMs: h.clock.now() + HOUR, claims: [] },
      h.clock.now(),
    );
    for (const status of ["pending", "sending", "waiting_window", "sent", "unknown_delivery"] as const) {
      await env.DB.prepare(`UPDATE outbound_messages SET status = ? WHERE dedupe_key = 'test:on-its-way'`).bind(status).run();
      expect(await slowBursts(h, businessId), status).toEqual([]);
    }
    for (const status of ["failed", "expired"] as const) {
      await env.DB.prepare(`UPDATE outbound_messages SET status = ? WHERE dedupe_key = 'test:on-its-way'`).bind(status).run();
      expect(await slowBursts(h, businessId), status).toHaveLength(1);
    }
    expect(pendientes.of(businessId)).toEqual([]);
    await env.DB.prepare(`DELETE FROM outbound_messages WHERE dedupe_key = 'test:on-its-way'`).run();
    await finish(setup);
  });

  it("leaves bursts older than the lookback alone", async () => {
    const setup = await stalledBurst(1);
    const { h, businessId, t0, pendientes } = setup;
    h.clock.ms = t0 + SLOW_NOTICE_LOOKBACK_MS + MINUTE;
    await h.runCron();
    expect(await notices(businessId)).toEqual([]);
    expect(pendientes.of(businessId)).toEqual([]);
    await finish(setup);
  });
});
