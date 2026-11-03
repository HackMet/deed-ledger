import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { dispatchOutbox, type SendOutcome } from "../src/application/dispatch";
import { placeholderHandler } from "../src/application/placeholder-handler";
import type { JobHandler } from "../src/application/ports";
import { runSweep } from "../src/application/sweep";
import { couldNotProcess, RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { CLAIM_CONFIRM_MAX_MS, SEND_CLAIM_MS } from "../src/domain/outbox";
import { splitText } from "../src/domain/text";
import { WhatsAppCloudChannel } from "../src/integrations/whatsapp/client";
import { FakeClock, failWritesMatching, hookDb } from "./helpers/fakes";
import { conversationOf, expireClaims, type Harness, harness, OUTLIVES_TEST_MS, rows } from "./helpers/harness";
import { newPhone, seedIntroducedCustomer, seedStore } from "./helpers/seed";
import { statusUpdate, textMessage, wamid, webhook } from "./helpers/whatsapp";

const HOUR = 60 * 60 * 1000;
const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

const lasting = (body = "Respuesta"): JobHandler => ({
  async handle({ isNewestOfBurst }) {
    return { replies: isNewestOfBurst ? [{ body, ttlMs: OUTLIVES_TEST_MS }] : [] };
  },
});

async function storeWithOwner() {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  return { store, phone };
}

/** A member message processed into its queued replies, not yet sent. */
async function queuedReply(h: Harness) {
  const { store, phone } = await storeWithOwner();
  await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
  h.clock.advance(4_000);
  h.channel.configured = false;
  await h.deliver(h.takeRingsFor(store.businessId));
  h.channel.configured = true;
  return { store, phone, conversation: await conversationOf(store.businessId) };
}

/** The store's outbox in send order. */
async function outboxOf(businessId: string) {
  return rows<{ status: string; attempts: number; body_text: string; last_error: string | null }>(
    `SELECT status, attempts, body_text, last_error FROM outbound_messages WHERE business_id = ? ORDER BY seq`,
    businessId,
  );
}

describe("at most once (F12)", () => {
  it("two dispatchers racing for one reply send it once", async () => {
    const h = harness({ jobHandler: lasting() });
    const { phone, conversation } = await queuedReply(h);
    // A row being sent is never claimed a second time.
    const [row] = await h.deps.outbox.listDispatchable(h.clock.now(), 10, conversation);
    expect(await h.deps.outbox.claim(conversation, row!.id, "first", SEND_CLAIM_MS, h.clock.now())).not.toBeNull();
    expect(await h.deps.outbox.claim(conversation, row!.id, "second", SEND_CLAIM_MS, h.clock.now())).toBeNull();
    expect(await h.deps.outbox.markWaitingWindow(conversation, row!.id, "first", h.clock.now())).toBe(true);

    await Promise.all([dispatchOutbox(h.deps, { limit: 10, conversation }), dispatchOutbox(h.deps, { limit: 10, conversation })]);
    expect(h.sentTo(phone)).toEqual(["Respuesta"]);
  });

  it("never resends a reply whose send was accepted but whose result wasn't stored", async () => {
    const clock = new FakeClock();
    const crashing = harness({ clock, jobHandler: lasting(), db: failWritesMatching(env.DB, /SET status = 'sent'/) });
    const { store, phone, conversation } = await queuedReply(crashing);
    await dispatchOutbox(crashing.deps, { limit: 10, conversation }); // accepted by WhatsApp, then the Worker dies
    expect(crashing.sentTo(phone)).toEqual(["Respuesta"]);
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "sending", attempts: 1 }]);

    const h = harness({ clock, jobHandler: lasting() });
    clock.advance(SEND_CLAIM_MS + 1);
    await expireClaims(store.businessId); // claims end by the database's clock
    await h.runCron();
    await dispatchOutbox(h.deps, { limit: 10, conversation });
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "unknown_delivery", attempts: 1 }]);
    expect(h.sentTo(phone)).toEqual([]); // not sent a second time
  });

  it("marks a send whose outcome is unknown and never resends it", async () => {
    const h = harness({ jobHandler: lasting() });
    const { store, phone, conversation } = await queuedReply(h);
    h.channel.nextResults.push({ ok: false, disposition: "unknown", errorCode: "timeout" });
    await dispatchOutbox(h.deps, { limit: 10, conversation });
    h.clock.advance(HOUR);
    await h.runCron();
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "unknown_delivery", attempts: 1 }]);
    expect(h.sentTo(phone)).toEqual([]);
  });

  it("treats a server error as an unknown outcome: neither the next dispatch nor the sweep resends it (G1)", async () => {
    const h = harness({ jobHandler: lasting() });
    const { store, conversation } = await queuedReply(h);
    let calls = 0;
    // The real WhatsApp client, over a fake network: Meta may have accepted the message and then answered 500.
    const whatsapp = new WhatsAppCloudChannel({
      token: "fake-token",
      apiVersion: "v26.0",
      timeoutMs: 10_000,
      fetch: async () => {
        calls++;
        return calls === 1 ? new Response("{}", { status: 500 }) : Response.json({ messages: [{ id: "wamid.TEST-AGAIN" }] });
      },
    });
    const deps = { ...h.deps, channel: whatsapp };

    expect(await dispatchOutbox(deps, { limit: 10, conversation })).toEqual(["unknown_delivery"]);
    await dispatchOutbox(deps, { limit: 10, conversation });
    h.clock.advance(HOUR);
    await runSweep(deps);
    expect(calls).toBe(1);
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "unknown_delivery", attempts: 1, last_error: "http_500" }]);
  });
});

describe("a dispatcher sends only while it holds the claim (G4)", () => {
  it("doesn't send when maintenance settled the row while the dispatcher was blocked in its reads", async () => {
    let businessId = "";
    let h!: Harness;
    // The dispatcher is stuck reading the customer's phone past its claim; the sweep settles the row meanwhile.
    const db = hookDb(env.DB, /SELECT cu\.phone FROM conversations/, async () => {
      await expireClaims(businessId);
      await h.runCron();
    });
    h = harness({ db, jobHandler: lasting() });
    const { store, phone, conversation } = await queuedReply(h);
    businessId = store.businessId;

    expect(await dispatchOutbox(h.deps, { limit: 10, conversation })).toEqual(["claim_lost"]);
    expect(h.sentTo(phone)).toEqual([]);
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "unknown_delivery", last_error: "claim_expired_mid_send" }]);
    expect(h.log.fields("outbox_claim_lost")).toEqual([
      { level: "warn", event: "outbox_claim_lost", businessId: store.businessId, outboxId: expect.any(String), outcome: "not_sent" },
    ]);
  });

  it("writes nothing else when the claim is lost before the result is stored, early statuses included", async () => {
    const h = harness({ jobHandler: lasting() });
    const { store, phone, conversation } = await queuedReply(h);
    // While the send is in flight, its delivery status arrives early, and the claim runs out: the
    // sweep settles the row before the dispatcher can store the result. (Once only: if the sweep
    // ever re-sent the row, this must not recurse.)
    let interleaved = false;
    h.channel.onSend = async (_message, providerMessageId) => {
      if (interleaved) return;
      interleaved = true;
      await h.post(webhook(store.phoneNumberId, { statuses: [statusUpdate({ id: providerMessageId, status: "delivered", timestampS: nowS(h) })] }));
      await expireClaims(store.businessId);
      await h.runCron();
    };

    expect(await dispatchOutbox(h.deps, { limit: 10, conversation })).toEqual(["claim_lost"]);
    expect(h.sentTo(phone)).toHaveLength(1);
    expect(
      await rows(`SELECT status, provider_message_id, provider_status FROM outbound_messages WHERE business_id = ?`, store.businessId),
    ).toEqual([{ status: "unknown_delivery", provider_message_id: null, provider_status: null }]);
    expect(await rows(`SELECT provider_status FROM early_statuses WHERE business_id = ?`, store.businessId)).toEqual([
      { provider_status: "delivered" },
    ]);
    expect(h.log.fields("outbox_claim_lost").map((line) => line.outcome)).toEqual(["sent"]);
  });
});

describe("a claim's writes depend on its own transition (H5)", () => {
  it("a repeated markSent writes nothing: no early status is applied or cleared", async () => {
    const h = harness({ jobHandler: lasting() });
    const { store, conversation } = await queuedReply(h);
    const [row] = await h.deps.outbox.listDispatchable(h.clock.now(), 10, conversation);
    expect(await h.deps.outbox.claim(conversation, row!.id, "claim-1", SEND_CLAIM_MS, h.clock.now())).not.toBeNull();
    const providerMessageId = "wamid.TEST-OUT-REPEATED";
    const statusHash = await h.deps.hasher.hash("status", providerMessageId);
    expect(await h.deps.outbox.markSent(conversation, row!.id, "claim-1", providerMessageId, statusHash, h.clock.now())).toBe(true);

    // An early status can sit beside a stored result (it arrived mid-send and hashing failed); this
    // one is planted so that a stray write from the repeated call would show.
    await env.DB.prepare(
      `INSERT INTO early_statuses (business_id, message_hash, provider_status, provider_status_rank, provider_status_at_s, received_at_ms)
       VALUES (?, ?, 'read', 3, ?, ?)`,
    )
      .bind(store.businessId, statusHash, nowS(h), h.clock.now())
      .run();

    expect(await h.deps.outbox.markSent(conversation, row!.id, "claim-1", providerMessageId, statusHash, h.clock.now())).toBe(false);
    expect(await rows(`SELECT status, provider_status FROM outbound_messages WHERE business_id = ?`, store.businessId)).toEqual([
      { status: "sent", provider_status: null },
    ]);
    expect(await rows(`SELECT provider_status FROM early_statuses WHERE business_id = ?`, store.businessId)).toEqual([
      { provider_status: "read" },
    ]);
    expect(await rows(`SELECT guard_id FROM batch_guards`)).toEqual([]);
  });

  it("a stale settle writes nothing: it stops no group", async () => {
    const h = harness({
      jobHandler: {
        async handle() {
          return { replies: [{ body: "Borrador", ttlMs: HOUR }, { body: "¿Lo confirmo?", ttlMs: HOUR }] };
        },
      },
    });
    const { store, conversation } = await queuedReply(h);
    const [draft] = await h.deps.outbox.listDispatchable(h.clock.now(), 10, conversation);
    expect(await h.deps.outbox.claim(conversation, draft!.id, "claim-1", SEND_CLAIM_MS, h.clock.now())).not.toBeNull();
    // The claim is lost: the row was settled by someone else. Planted without stopping the rest of
    // its group, so that a stray group stop from the stale calls would show.
    await env.DB.prepare(`UPDATE outbound_messages SET status = 'unknown_delivery', claim_id = NULL, claim_until_ms = NULL WHERE id = ?`)
      .bind(draft!.id)
      .run();

    expect(await h.deps.outbox.markExpired(conversation, draft!.id, "claim-1", h.clock.now())).toBe(false);
    expect(await h.deps.outbox.release(conversation, draft!.id, "claim-1", "http_400", true, h.clock.now())).toBe(false);
    expect(await h.deps.outbox.markUnknownDelivery(conversation, draft!.id, "claim-1", "timeout", h.clock.now())).toBe(false);
    expect(await outboxOf(store.businessId)).toMatchObject([
      { status: "unknown_delivery", body_text: "Borrador", last_error: null },
      { status: "pending", body_text: "¿Lo confirmo?", last_error: null },
    ]);
    expect(await rows(`SELECT guard_id FROM batch_guards`)).toEqual([]);
  });
});

describe("reply order (G2)", () => {
  const long = `${"palabra ".repeat(700)}fin`; // 5,603 characters: two parts

  it("sends a split reply and the job's next reply in order, with two dispatchers racing", async () => {
    const h = harness({
      jobHandler: {
        async handle() {
          return { replies: [{ body: long, ttlMs: HOUR }, { body: "¿Lo anoto así?", ttlMs: HOUR }] };
        },
      },
    });
    const { store, phone, conversation } = await queuedReply(h);
    const finished: string[] = [];
    let racer: Promise<SendOutcome[]> | undefined;
    h.channel.onSend = async (message) => {
      // While the first part is in flight, a second dispatcher runs to the end.
      if (racer === undefined) {
        racer = dispatchOutbox(h.deps, { limit: 10, conversation });
        await racer;
      }
      finished.push(message.body);
    };
    await dispatchOutbox(h.deps, { limit: 10, conversation });

    const expected = [...splitText(long, 4096), "¿Lo anoto así?"];
    expect(expected).toHaveLength(3);
    expect(finished).toEqual(expected);
    expect(h.sentTo(phone)).toEqual(expected);
    expect(await racer).toEqual([]); // nothing it could send while the first part was in flight
    expect((await outboxOf(store.businessId)).map((row) => row.status)).toEqual(["sent", "sent", "sent"]);
  });

  it("stops the rest of a group when its first part fails, but not the next job's replies", async () => {
    const h = harness({
      jobHandler: {
        async handle({ job }) {
          return { replies: [{ body: job.textBody === "uno" ? long : "Respuesta a dos", ttlMs: HOUR }] };
        },
      },
    });
    const { store, phone } = await storeWithOwner();
    const t = nowS(h);
    await h.post(
      webhook(store.phoneNumberId, {
        messages: [
          textMessage({ from: phone, id: wamid(), timestampS: t, body: "uno" }),
          textMessage({ from: phone, id: wamid(), timestampS: t + 1, body: "dos" }),
        ],
      }),
    );
    h.clock.advance(4_000);
    h.channel.configured = false;
    await h.deliver(h.takeRingsFor(store.businessId));
    h.channel.configured = true;

    h.channel.nextResults.push({ ok: false, disposition: "permanent", errorCode: "http_400" });
    await dispatchOutbox(h.deps, { limit: 10, conversation: await conversationOf(store.businessId) });
    expect(h.sentTo(phone)).toEqual(["Respuesta a dos"]);
    expect(await outboxOf(store.businessId)).toMatchObject([
      { status: "failed", last_error: "http_400" },
      { status: "failed", last_error: "predecessor_not_sent" },
      { status: "sent", body_text: "Respuesta a dos" },
    ]);
  });

  it("never sends a confirmation whose draft expired before it", async () => {
    const h = harness({
      jobHandler: {
        async handle() {
          return { replies: [{ body: "Borrador", ttlMs: HOUR }, { body: "¿Lo confirmo?", ttlMs: 2 * HOUR }] };
        },
      },
    });
    const { store, phone } = await queuedReply(h);
    h.clock.advance(HOUR);
    await h.runCron();
    expect(h.sentTo(phone)).toEqual([]);
    expect(await outboxOf(store.businessId)).toMatchObject([
      { status: "expired", body_text: "Borrador" },
      { status: "failed", body_text: "¿Lo confirmo?", last_error: "predecessor_not_sent" },
    ]);
  });
});

describe("the 24-hour window at send time (F13)", () => {
  it("uses a time sampled after the dispatcher's reads", async () => {
    const clock = new FakeClock();
    let h!: Harness;
    // While the dispatcher reads the customer's phone, time moves past the window.
    const db = hookDb(env.DB, /SELECT cu\.phone FROM conversations/, async () => {
      clock.advance(2 * 60 * 1000);
    });
    h = harness({ clock, db, jobHandler: lasting() });
    const { store, phone, conversation } = await queuedReply(h);
    clock.advance(24 * HOUR - 60 * 1000); // one minute left in the window
    await dispatchOutbox(h.deps, { limit: 10, conversation });
    expect(h.sentTo(phone)).toEqual([]);
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "waiting_window", attempts: 0 }]);
  });
});

describe("the claim's confirmation, right before the send (H4)", () => {
  /** A D1 binding on which the claim's confirmation takes `ms` of the Worker's time to come back. */
  const confirmationTaking = (clock: FakeClock, ms: number, times = 1) =>
    hookDb(
      env.DB,
      /UPDATE outbound_messages SET claim_until_ms/,
      async () => {
        clock.advance(ms);
      },
      times,
    );

  it("judges the 24-hour window after the confirmation: it closes while the confirmation is in flight", async () => {
    const clock = new FakeClock();
    const h = harness({ clock, db: confirmationTaking(clock, 2_000), jobHandler: lasting() });
    const { store, phone, conversation } = await queuedReply(h);
    clock.advance(24 * HOUR - 5_000); // one second left in the window when the dispatcher starts
    expect(await dispatchOutbox(h.deps, { limit: 10, conversation })).toEqual(["waiting_window"]);
    expect(h.sentTo(phone)).toEqual([]);
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "waiting_window", attempts: 0 }]);
  });

  it("judges the expiry after the confirmation: the reply expires while the confirmation is in flight", async () => {
    const clock = new FakeClock();
    const h = harness({
      clock,
      db: confirmationTaking(clock, 2_000),
      jobHandler: {
        async handle() {
          return { replies: [{ body: "Respuesta", ttlMs: HOUR }] };
        },
      },
    });
    const { store, phone, conversation } = await queuedReply(h);
    clock.advance(HOUR - 1_000); // one second left before the reply expires
    expect(await dispatchOutbox(h.deps, { limit: 10, conversation })).toEqual(["expired"]);
    expect(h.sentTo(phone)).toEqual([]);
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "expired", attempts: 0 }]);
  });

  it("doesn't send after a slow confirmation, whose claim may not outlast the send: the row waits for a later pass", async () => {
    const clock = new FakeClock();
    const h = harness({ clock, db: confirmationTaking(clock, CLAIM_CONFIRM_MAX_MS + 1), jobHandler: lasting() });
    const { store, phone, conversation } = await queuedReply(h);
    expect(await dispatchOutbox(h.deps, { limit: 10, conversation })).toEqual(["retry_later"]);
    expect(h.sentTo(phone)).toEqual([]);
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "pending", last_error: "claim_confirm_slow" }]);

    // The next pass confirms in time and sends it, once.
    expect(await dispatchOutbox(h.deps, { limit: 10, conversation })).toEqual(["sent"]);
    expect(h.sentTo(phone)).toEqual(["Respuesta"]);
  });
});

describe("expiry (F15)", () => {
  it("expires the placeholder after an hour instead of sending it late", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    // A returning customer, already introduced (#30): this test counts replies.
    await seedIntroducedCustomer(store, phone);
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
    h.clock.advance(4_000);
    h.channel.nextResults.push({ ok: false, disposition: "retry", errorCode: "http_429" });
    await h.deliver(h.takeRingsFor(store.businessId));

    h.clock.advance(HOUR);
    await h.runCron();
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "expired", body_text: RECEIVED_PLACEHOLDER }]);

    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "¿Y?" })] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]); // only the new one
    expect((await outboxOf(store.businessId)).map((row) => row.status).sort()).toEqual(["expired", "sent"]);
  });

  it("expires a failure reply queued while the window is closed, instead of sending it when the member writes again (G3)", async () => {
    const h = harness({
      jobHandler: {
        async handle(input) {
          if (input.job.textBody === "Hola") throw new Error("provider outage");
          return placeholderHandler.handle(input);
        },
      },
    });
    const { store, phone } = await storeWithOwner();
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId)); // attempt 1 fails: retried later
    h.clock.advance(25 * HOUR); // the member's window closes meanwhile
    for (let attempt = 2; attempt <= 3; attempt++) {
      await h.deliver(h.takeRingsFor(store.businessId).slice(0, 1));
      h.clock.advance(60_000);
    }
    // The last attempt failed for good: its reply was queued while the window was closed.
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "pending", body_text: couldNotProcess("text") }]);

    h.clock.advance(HOUR);
    await h.runCron();
    expect(await outboxOf(store.businessId)).toMatchObject([{ status: "expired" }]);

    // The member writes again: the window reopens, and only the new message gets a reply.
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "¿Y?" })] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
  });
});

describe("reply length (F16)", () => {
  it("splits a long reply before the batch and drops a blank one", async () => {
    const long = `${"palabra ".repeat(700)}fin`; // 5,603 characters
    const h = harness({
      jobHandler: {
        async handle() {
          return { replies: [{ body: long, ttlMs: OUTLIVES_TEST_MS }, { body: "   ", ttlMs: OUTLIVES_TEST_MS }] };
        },
      },
    });
    const { store, phone } = await storeWithOwner();
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));

    expect(await rows(`SELECT job_state FROM inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([{ job_state: "done" }]);
    const sent = h.sentTo(phone);
    expect(sent).toHaveLength(2);
    expect(sent.every((part) => part.length <= 4096 && part.length > 0)).toBe(true);
    expect(sent.join(" ")).toBe(long);
  });
});

describe("early delivery statuses (F17)", () => {
  it("are kept and applied when the send result is stored", async () => {
    const h = harness({ jobHandler: lasting() });
    const { store, conversation } = await queuedReply(h);
    // The status webhook lands while the send is still in flight, before its result is stored.
    h.channel.onSend = async (_message, providerMessageId) => {
      await h.post(webhook(store.phoneNumberId, { statuses: [statusUpdate({ id: providerMessageId, status: "delivered", timestampS: nowS(h) })] }));
    };
    await dispatchOutbox(h.deps, { limit: 10, conversation });

    const [row] = await rows<{ status: string; provider_status: string | null }>(
      `SELECT status, provider_status FROM outbound_messages WHERE business_id = ?`,
      store.businessId,
    );
    expect(row).toEqual({ status: "sent", provider_status: "delivered" });
    expect(await rows(`SELECT 1 FROM early_statuses WHERE business_id = ?`, store.businessId)).toEqual([]);
  });
});
