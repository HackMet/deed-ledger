import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { couldNotProcess, RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { MAX_JOB_ATTEMPTS, STRANDED_AFTER_MS } from "../src/domain/processing";
import { conversationOf, expireLease, type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedIntroducedCustomer, seedStore } from "./helpers/seed";
import { audioMessage, textMessage, wamid, webhook } from "./helpers/whatsapp";

// The sweep spans every store and storage is shared within this file, so every assertion is
// scoped to the store under test.

const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);
const HOUR = 60 * 60 * 1000;

async function storeWithOwner() {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  return { store, phone };
}

describe("cron sweep", () => {
  it("recovers a crash between saving and ringing, and the message is processed once", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    // A returning customer, already introduced (#30): this test counts replies.
    await seedIntroducedCustomer(store, phone);
    h.doorbell.failNext = 1; // the save succeeds, the ring is lost
    const response = await h.post(
      webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }),
    );
    expect(response.status).toBe(200);
    expect(h.ringsFor(store.businessId)).toEqual([]);
    expect(h.log.events()).toContain("doorbell_ring_failed");

    // Too early: a doorbell may still be on its way.
    h.clock.advance(STRANDED_AFTER_MS - 1_000);
    await h.runCron();
    expect(h.ringsFor(store.businessId)).toEqual([]);

    // Stranded: the sweep re-rings and the job is processed.
    h.clock.advance(2_000);
    await h.runCron();
    const rings = h.takeRingsFor(store.businessId);
    expect(rings).toHaveLength(1);
    await h.deliver(rings);

    // Later sweeps and a duplicate doorbell change nothing.
    h.clock.advance(STRANDED_AFTER_MS * 2);
    await h.runCron();
    expect(h.ringsFor(store.businessId)).toEqual([]);
    await h.deliver(rings);

    const [job] = await rows<{ job_state: string; attempts: number }>(
      `SELECT job_state, attempts FROM inbound_messages WHERE business_id = ?`,
      store.businessId,
    );
    expect(job).toEqual({ job_state: "done", attempts: 1 });
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
  });

  it("re-rings a job whose consumer died mid-way, once its lease has expired", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    // A returning customer, already introduced (#30): this test counts replies.
    await seedIntroducedCustomer(store, phone);
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
    h.doorbell.take();
    // A consumer took the lease, started the job and died.
    const conversation = await conversationOf(store.businessId);
    const lease = { ...conversation, leaseId: "dead-consumer" };
    expect(await h.deps.jobs.claimLease(lease, lease.leaseId, 60_000)).toBe("claimed");
    const [open] = (await h.deps.jobs.snapshot(lease, h.clock.now(), 10)).jobs;
    await h.deps.jobs.startJob(lease, open!.id, h.clock.now());

    h.clock.advance(STRANDED_AFTER_MS + 1_000);
    await h.runCron();
    expect(h.ringsFor(store.businessId)).toEqual([]); // the lease is still live (database clock)

    await expireLease(conversation.conversationId);
    await h.runCron();
    await h.deliver(h.takeRingsFor(store.businessId));
    const [job] = await rows<{ job_state: string; attempts: number }>(
      `SELECT job_state, attempts FROM inbound_messages WHERE business_id = ?`,
      store.businessId,
    );
    expect(job).toEqual({ job_state: "done", attempts: 2 });
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
  });

  it(`fails a job at its attempt ${MAX_JOB_ATTEMPTS} and tells the owner plainly`, async () => {
    const h = harness({
      jobHandler: {
        async handle() {
          throw new Error("provider outage");
        },
      },
    });
    const { store, phone } = await storeWithOwner();
    await h.post(webhook(store.phoneNumberId, { messages: [audioMessage({ from: phone, id: wamid(), timestampS: nowS(h), mediaId: "m-voice" })] }));
    h.clock.advance(4_000);

    const delays: number[] = [];
    let rings = h.takeRingsFor(store.businessId);
    for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt++) {
      await h.deliver(rings);
      rings = h.takeRingsFor(store.businessId);
      delays.push(...rings.map((ring) => ring.delaySeconds));
      h.clock.advance(60_000);
    }
    expect(delays).toEqual([5, 10]); // backoff after attempts 1 and 2; attempt 3 fails for good

    const [job] = await rows<{ job_state: string; attempts: number; last_error: string }>(
      `SELECT job_state, attempts, last_error FROM inbound_messages WHERE business_id = ?`,
      store.businessId,
    );
    expect(job).toEqual({ job_state: "failed", attempts: MAX_JOB_ATTEMPTS, last_error: "attempt_failed" });
    expect(h.sentTo(phone)).toEqual([couldNotProcess("audio")]);

    await h.runCron();
    expect(h.ringsFor(store.businessId)).toEqual([]);
  });

  it("gives up on an old unknown-sender notice left pending by a request that died", async () => {
    const h = harness();
    const { store } = await storeWithOwner();
    const stranger = newPhone();
    // Notices are no longer created (#14), but rows from before can still be left pending.
    await env.DB.prepare(
      `INSERT INTO outbound_messages (id, business_id, channel_account_id, recipient_hash, seq, kind, body_text,
         dedupe_key, status, expires_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'hash-synthetic', (SELECT COALESCE(MAX(seq), 0) + 1 FROM outbound_messages),
         'unknown_sender_notice', 'Aviso', ?, 'pending', ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), store.businessId, store.channelAccountId, `notice:${crypto.randomUUID()}`, h.clock.now() + HOUR, h.clock.now(), h.clock.now())
      .run();
    expect(await rows(`SELECT status FROM outbound_messages WHERE business_id = ?`, store.businessId)).toEqual([{ status: "pending" }]);

    h.channel.configured = true;
    h.clock.advance(16 * 60 * 1000);
    await h.runCron();
    const [notice] = await rows<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM outbound_messages WHERE business_id = ?`,
      store.businessId,
    );
    expect(notice).toEqual({ status: "failed", last_error: "recipient_not_retained" });
    expect(h.sentTo(stranger)).toEqual([]);
  });
});
