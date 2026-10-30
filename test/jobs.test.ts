import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { JobConflictError, LeaseLostError } from "../src/application/errors";
import { placeholderHandler } from "../src/application/placeholder-handler";
import type { JobHandler, Lease, OutboxDraft } from "../src/application/ports";
import { RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { hookDb, stallingDb } from "./helpers/fakes";
import { conversationOf, expireLease, type Harness, harness, OUTLIVES_TEST_MS, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

function reply(id = crypto.randomUUID()): OutboxDraft {
  return {
    id,
    kind: "reply",
    body: "Hola",
    dedupeKey: `test:${id}`,
    replyIndex: 0,
    partIndex: 0,
    expiresAtMs: Date.now() + OUTLIVES_TEST_MS,
  };
}

async function jobsOf(businessId: string) {
  return rows<{ id: string; job_state: string; attempts: number; job_lease_id: string | null; text_body: string }>(
    `SELECT id, job_state, attempts, job_lease_id, text_body FROM inbound_messages WHERE business_id = ? ORDER BY order_ts_s, received_at_ms`,
    businessId,
  );
}

async function repliesOf(businessId: string): Promise<string[]> {
  return (await rows<{ dedupe_key: string }>(`SELECT dedupe_key FROM outbound_messages WHERE business_id = ?`, businessId)).map(
    (row) => row.dedupe_key,
  );
}

/** A store with one member message, its conversation leased by `leaseId`. */
async function leasedJob(h: Harness, leaseId = crypto.randomUUID()) {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
  const lease: Lease = { ...(await conversationOf(store.businessId)), leaseId };
  expect(await h.deps.jobs.claimLease(lease, leaseId, 60_000)).toBe("claimed");
  const [job] = await jobsOf(store.businessId);
  return { store, phone, lease, job: job! };
}

describe("job transitions check the job inside the batch (F1)", () => {
  it("refuse a job from another conversation of the same store", async () => {
    const h = harness();
    const owner = newPhone();
    const staff = newPhone();
    const store = await seedStore({ members: [{ phone: owner, role: "owner" }, { phone: staff, role: "staff" }] });
    for (const from of [owner, staff]) {
      await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from, id: wamid(), timestampS: nowS(h), body: from })] }));
    }
    const conversations = await rows<{ id: string; phone: string }>(
      `SELECT c.id, u.phone FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.business_id = ?`,
      store.businessId,
    );
    const ownerConversation = conversations.find((c) => c.phone === owner)!.id;
    const staffJob = (await jobsOf(store.businessId)).find((job) => job.text_body === staff)!;
    const lease: Lease = { businessId: store.businessId, conversationId: ownerConversation, leaseId: "lease-owner" };
    expect(await h.deps.jobs.claimLease(lease, lease.leaseId, 60_000)).toBe("claimed");

    await expect(h.deps.jobs.startJob(lease, staffJob.id, h.clock.now())).rejects.toBeInstanceOf(JobConflictError);
    expect((await jobsOf(store.businessId)).find((job) => job.id === staffJob.id)).toMatchObject({ job_state: "pending", attempts: 0 });
  });

  it("refuse completing a job that wasn't started under this lease, and insert no reply", async () => {
    const h = harness();
    const { store, lease, job } = await leasedJob(h);
    await expect(h.deps.jobs.completeJob(lease, job.id, h.clock.now(), [reply()], false)).rejects.toBeInstanceOf(JobConflictError);
    await expect(h.deps.jobs.failJob(lease, job.id, "x", h.clock.now(), [reply()])).rejects.toBeInstanceOf(JobConflictError);
    await expect(h.deps.jobs.deferJob(lease, job.id, "x", h.clock.now())).rejects.toBeInstanceOf(JobConflictError);
    expect(await jobsOf(store.businessId)).toMatchObject([{ job_state: "pending", attempts: 0 }]);
    expect(await repliesOf(store.businessId)).toEqual([]);
  });

  it("refuse a stale completion: it writes nothing", async () => {
    const h = harness();
    const { store, lease: a, job } = await leasedJob(h, "lease-a");
    await h.deps.jobs.startJob(a, job.id, h.clock.now());

    // A's lease expires; B takes over, restarts and completes the job.
    await expireLease(a.conversationId);
    const b: Lease = { ...a, leaseId: "lease-b" };
    expect(await h.deps.jobs.claimLease(b, b.leaseId, 60_000)).toBe("claimed");
    await h.deps.jobs.startJob(b, job.id, h.clock.now());
    await h.deps.jobs.completeJob(b, job.id, h.clock.now(), [reply("from-b")], false);

    // A's late completion and B's own repeated completion are both refused, with new reply keys.
    await expect(h.deps.jobs.completeJob(a, job.id, h.clock.now(), [reply("late-a")], false)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(h.deps.jobs.completeJob(b, job.id, h.clock.now(), [reply("again-b")], false)).rejects.toBeInstanceOf(JobConflictError);
    expect(await jobsOf(store.businessId)).toMatchObject([{ job_state: "done", attempts: 2, job_lease_id: "lease-b" }]);
    expect(await repliesOf(store.businessId)).toEqual(["test:from-b"]);
    expect(await rows(`SELECT guard_id FROM batch_guards`)).toEqual([]);
  });
});

describe("lease expiry uses the database's clock (F2)", () => {
  it("refuses a write sampled before the lease expired but executed after", async () => {
    const stalling = stallingDb(env.DB);
    const h = harness({ db: stalling.db });
    const { store, lease, job } = await leasedJob(h);
    expect(await h.deps.jobs.claimLease({ ...lease }, lease.leaseId, 60_000)).toBe("busy");
    await h.deps.jobs.startJob(lease, job.id, h.clock.now());
    // Re-lease for one second of database time.
    await env.DB.prepare(
      `UPDATE conversations SET lease_until_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) + 1000 WHERE id = ?`,
    )
      .bind(lease.conversationId)
      .run();
    // The Worker builds the completion while the lease is live; D1 runs it 1.3 s later.
    stalling.stallNextBatch(1_300);
    await expect(h.deps.jobs.completeJob(lease, job.id, h.clock.now(), [reply()], false)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await jobsOf(store.businessId)).toMatchObject([{ job_state: "processing", attempts: 1 }]);
    expect(await repliesOf(store.businessId)).toEqual([]);
  });
});

describe("deferred jobs persist their retry time (F4)", () => {
  function failingFirst(texts: string[]): JobHandler & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async handle(input) {
        calls.push(input.job.textBody ?? "");
        if (texts.includes(input.job.textBody ?? "") && calls.filter((c) => c === input.job.textBody).length === 1) {
          throw new Error("provider outage");
        }
        return placeholderHandler.handle(input);
      },
    };
  }

  it("duplicate doorbells before the retry time don't burn attempts", async () => {
    const handler = failingFirst(["uno"]);
    const h = harness({ jobHandler: handler });
    const phone = newPhone();
    const store = await seedStore({ members: [{ phone, role: "owner" }] });
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "uno" })] }));
    h.clock.advance(4_000);
    await h.deliver(); // attempt 1 fails: deferred for 5 s
    const [retryRing] = h.doorbell.take();
    expect(retryRing?.delaySeconds).toBe(5);

    await h.deliver([retryRing!, retryRing!, retryRing!]); // early duplicates, clock unchanged
    expect(await jobsOf(store.businessId)).toMatchObject([{ job_state: "pending", attempts: 1 }]);
    expect(handler.calls).toEqual(["uno"]);

    h.clock.advance(5_000);
    await h.deliver(h.doorbell.take().slice(0, 1));
    expect(await jobsOf(store.businessId)).toMatchObject([{ job_state: "done", attempts: 2 }]);
  });

  it("later jobs in the conversation wait behind a deferred earlier job", async () => {
    const handler = failingFirst(["primero"]);
    const h = harness({ jobHandler: handler });
    const phone = newPhone();
    const store = await seedStore({ members: [{ phone, role: "owner" }] });
    const t = nowS(h);
    await h.post(
      webhook(store.phoneNumberId, {
        messages: [
          textMessage({ from: phone, id: wamid(), timestampS: t, body: "primero" }),
          textMessage({ from: phone, id: wamid(), timestampS: t + 1, body: "segundo" }),
        ],
      }),
    );
    h.clock.advance(4_000);
    await h.deliver();
    // An early doorbell (before primero's retry time) must not run segundo ahead of it. It doesn't even
    // try segundo: it rings again for primero's retry time, 5 s away.
    await h.deliver(h.doorbell.take().slice(0, 1));
    expect((await jobsOf(store.businessId)).map((job) => [job.text_body, job.job_state])).toEqual([
      ["primero", "pending"],
      ["segundo", "pending"],
    ]);
    expect(handler.calls).toEqual(["primero"]);
    expect(h.doorbell.rings.map((ring) => ring.delaySeconds)).toEqual([5]);
    expect(h.log.fields("job_start_refused")).toEqual([]);

    h.clock.advance(5_000);
    await h.deliver(h.doorbell.take().slice(0, 1));
    expect(handler.calls).toEqual(["primero", "primero", "segundo"]);
  });
});

describe("the settle decision and the job list are one snapshot (F5)", () => {
  it("doesn't process a message that arrives between the settle check and the job list", async () => {
    const phone = newPhone();
    const store = await seedStore({ members: [{ phone, role: "owner" }] });
    const arrival = wamid();
    let h!: Harness;
    const db = hookDb(env.DB, /MAX\(received_at_ms\)/, async () => {
      // A new message lands right after the processor's first read of the round.
      await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: arrival, timestampS: nowS(h), body: "nuevo" })] }));
    });
    h = harness({ db });
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h) - 10, body: "viejo" })] }));
    h.clock.advance(4_000);
    await h.deliver(h.doorbell.take());

    // The round starts no job once a message arrived after its snapshot, not even the first (H3),
    // and the new message waits to settle.
    const jobs = await jobsOf(store.businessId);
    expect(jobs.map((job) => [job.text_body, job.job_state, job.attempts])).toEqual([
      ["viejo", "pending", 0],
      ["nuevo", "pending", 0], // not yet settled: left for a later round
    ]);
    expect(h.ringsFor(store.businessId).some((ring) => ring.delaySeconds === 3)).toBe(true);

    // Once it has settled, both are processed, in order.
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId).slice(0, 1));
    expect((await jobsOf(store.businessId)).map((job) => [job.text_body, job.job_state])).toEqual([
      ["viejo", "done"],
      ["nuevo", "done"],
    ]);
  });

  it("stops a round when a message arrives during handling, then handles everything in order", async () => {
    const phone = newPhone();
    const store = await seedStore({ members: [{ phone, role: "owner" }] });
    const handled: string[] = [];
    let h!: Harness;
    const t = 1_793_196_000;
    h = harness({
      jobHandler: {
        async handle(input) {
          handled.push(input.job.textBody ?? "");
          if (input.job.textBody === "A") {
            // C arrives while A is being handled. By the provider's clock it was sent after B, so B
            // could still run in order: the round stops anyway, to let C settle into the burst.
            await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: t + 3, body: "C" })] }));
          }
          return placeholderHandler.handle(input);
        },
      },
    });
    await h.post(
      webhook(store.phoneNumberId, {
        messages: [
          textMessage({ from: phone, id: wamid(), timestampS: t, body: "A" }),
          textMessage({ from: phone, id: wamid(), timestampS: t + 2, body: "B" }),
        ],
      }),
    );
    h.clock.advance(4_000);
    await h.deliver(h.doorbell.take());
    expect(handled).toEqual(["A"]); // the round stopped before B

    h.clock.advance(4_000);
    await h.deliver(h.doorbell.take().slice(0, 1));
    expect(handled).toEqual(["A", "B", "C"]);
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]); // one acknowledgement for the whole burst
  });
});

describe("arrivals before a job starts (H3)", () => {
  /**
   * A burst A, B, and a message C that the provider's clock puts before A. C arrives once the
   * statement matching `when` has run: right after the snapshot, or right after the arrival check
   * that precedes A's start.
   */
  async function earlierMessageArriving(when: RegExp) {
    const phone = newPhone();
    const store = await seedStore({ members: [{ phone, role: "owner" }] });
    const t = 1_793_196_000;
    const handled: string[] = [];
    let h!: Harness;
    const db = hookDb(env.DB, when, async () => {
      await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: t - 1, body: "C" })] }));
    });
    h = harness({
      db,
      jobHandler: {
        async handle(input) {
          handled.push(input.job.textBody ?? "");
          return placeholderHandler.handle(input);
        },
      },
    });
    await h.post(
      webhook(store.phoneNumberId, {
        messages: [
          textMessage({ from: phone, id: wamid(), timestampS: t, body: "A" }),
          textMessage({ from: phone, id: wamid(), timestampS: t + 1, body: "B" }),
        ],
      }),
    );
    h.clock.advance(4_000);
    return { h, store, phone, handled };
  }

  it("processes a message that arrives between the snapshot and the first job's start, and sorts first, before that job", async () => {
    const { h, store, phone, handled } = await earlierMessageArriving(/WITH open AS/);
    await h.deliver(h.takeRingsFor(store.businessId));
    expect(handled).toEqual([]); // the round stopped before A

    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId).slice(0, 1));
    expect(handled).toEqual(["C", "A", "B"]);
    expect((await jobsOf(store.businessId)).map((job) => [job.text_body, job.job_state, job.attempts])).toEqual([
      ["C", "done", 1],
      ["A", "done", 1],
      ["B", "done", 1],
    ]);
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
  });

  it("refuses to start a job when a message that sorts before it arrived after the arrival check", async () => {
    const { h, store, phone, handled } = await earlierMessageArriving(/SELECT 1 AS found FROM inbound_messages/);
    await h.deliver(h.takeRingsFor(store.businessId));
    // A's start batch saw C and wrote nothing: no attempt used, no reply.
    expect(handled).toEqual([]);
    expect(h.log.fields("job_start_refused").map((line) => line.reason)).toEqual(["stale_snapshot"]);
    expect((await jobsOf(store.businessId)).map((job) => [job.text_body, job.job_state, job.attempts])).toEqual([
      ["C", "pending", 0],
      ["A", "pending", 0],
      ["B", "pending", 0],
    ]);
    expect(await rows(`SELECT guard_id FROM batch_guards`)).toEqual([]);

    // A new snapshot, once C has settled, takes them in order.
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId).slice(0, 1));
    expect(handled).toEqual(["C", "A", "B"]);
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
  });
});

describe("the burst's closing reply (G5)", () => {
  it("is withheld when a message arrives during the round's last job, so the burst gets one reply, not two", async () => {
    const phone = newPhone();
    const store = await seedStore({ members: [{ phone, role: "owner" }] });
    const handled: string[] = [];
    let h!: Harness;
    const t = 1_793_196_000;
    h = harness({
      jobHandler: {
        async handle(input) {
          handled.push(input.job.textBody ?? "");
          if (input.job.textBody === "B") {
            // C arrives while B, the last job of the round, is being handled.
            await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: t + 2, body: "C" })] }));
          }
          return placeholderHandler.handle(input);
        },
      },
    });
    await h.post(
      webhook(store.phoneNumberId, {
        messages: [
          textMessage({ from: phone, id: wamid(), timestampS: t, body: "A" }),
          textMessage({ from: phone, id: wamid(), timestampS: t + 1, body: "B" }),
        ],
      }),
    );
    h.clock.advance(4_000);
    await h.deliver(h.doorbell.take());
    expect(handled).toEqual(["A", "B"]);
    expect(h.sentTo(phone)).toEqual([]); // B finished, but the burst wasn't over
    expect(h.log.fields("burst_reply_withheld")).toHaveLength(1);

    h.clock.advance(4_000);
    await h.deliver(h.doorbell.take().slice(0, 1));
    expect(handled).toEqual(["A", "B", "C"]);
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
    expect(await jobsOf(store.businessId)).toMatchObject([{ job_state: "done" }, { job_state: "done" }, { job_state: "done" }]);
  });
});

describe("a burst longer than a round (H1)", () => {
  /** 26 settled messages in one burst: one more than a round takes. */
  async function longBurst(h: Harness) {
    const phone = newPhone();
    const store = await seedStore({ members: [{ phone, role: "owner" }] });
    const t = 1_793_196_000;
    const texts = Array.from({ length: 26 }, (_, n) => `m${String(n + 1).padStart(2, "0")}`);
    await h.post(
      webhook(store.phoneNumberId, {
        messages: texts.map((body, n) => textMessage({ from: phone, id: wamid(), timestampS: t + n, body })),
      }),
    );
    h.clock.advance(4_000);
    return { store, phone };
  }

  it("gets exactly one closing reply from 26 settled messages, across rounds and processor invocations", async () => {
    const toldNewest: string[] = [];
    let lastJobFailedOnce = false;
    const h = harness({
      jobHandler: {
        async handle(input) {
          if (input.isNewestOfBurst) toldNewest.push(input.job.textBody ?? "");
          if (input.job.textBody === "m26" && !lastJobFailedOnce) {
            lastJobFailedOnce = true;
            throw new Error("provider outage"); // retried by a later invocation
          }
          return placeholderHandler.handle(input);
        },
      },
    });
    const { store, phone } = await longBurst(h);

    // Round 1 takes 25 jobs, none of them the burst's newest; round 2 takes m26, whose first attempt
    // fails and is handed to a later invocation.
    await h.deliver(h.takeRingsFor(store.businessId));
    expect((await jobsOf(store.businessId)).map((job) => job.job_state)).toEqual([...Array(25).fill("done"), "pending"]);
    expect(await repliesOf(store.businessId)).toEqual([]);

    h.clock.advance(5_000);
    await h.deliver(h.takeRingsFor(store.businessId).slice(0, 1));
    expect((await jobsOf(store.businessId)).every((job) => job.job_state === "done")).toBe(true);
    expect(toldNewest).toEqual(["m26", "m26"]); // only the last open job, on both of its attempts
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
    expect(h.log.fields("burst_reply_withheld")).toEqual([]);
  });

  it("writes a closing reply only from the burst's last open job, whatever the handler marks", async () => {
    // A handler that closes the burst from every job: only the completion batch's check stops it.
    const h = harness({
      jobHandler: {
        async handle({ job }) {
          return { replies: [{ body: `Cierre ${job.textBody}`, ttlMs: OUTLIVES_TEST_MS, closesBurst: true }] };
        },
      },
    });
    const { store, phone } = await longBurst(h);
    await h.deliver(h.takeRingsFor(store.businessId));
    expect(h.sentTo(phone)).toEqual(["Cierre m26"]);
    expect(h.log.fields("burst_reply_withheld")).toHaveLength(25);
  });
});

describe("a job's replies close the burst together (H2)", () => {
  it("writes neither a closing draft nor the confirmation after it when a newer message arrived, and leaves other jobs' replies alone", async () => {
    const phone = newPhone();
    const store = await seedStore({ members: [{ phone, role: "owner" }] });
    const t = 1_793_196_000;
    let h!: Harness;
    h = harness({
      jobHandler: {
        async handle({ job }) {
          if (job.textBody === "A") return { replies: [{ body: "Respuesta a A", ttlMs: OUTLIVES_TEST_MS }] };
          if (job.textBody === "B") {
            // C arrives while B, the burst's newest job so far, is handled.
            await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: t + 2, body: "C" })] }));
          }
          // A draft that closes the burst, and its confirmation, which isn't flagged itself.
          return {
            replies: [
              { body: `Borrador de ${job.textBody}`, ttlMs: OUTLIVES_TEST_MS, closesBurst: true },
              { body: `¿Confirmo ${job.textBody}?`, ttlMs: OUTLIVES_TEST_MS },
            ],
          };
        },
      },
    });
    await h.post(
      webhook(store.phoneNumberId, {
        messages: [
          textMessage({ from: phone, id: wamid(), timestampS: t, body: "A" }),
          textMessage({ from: phone, id: wamid(), timestampS: t + 1, body: "B" }),
        ],
      }),
    );
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
    // B's group closes the burst, but C arrived: none of it is written. A's own reply is.
    expect(h.sentTo(phone)).toEqual(["Respuesta a A"]);
    expect(h.log.fields("burst_reply_withheld").map((line) => line.count)).toEqual([2]);

    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId).slice(0, 1));
    expect(h.sentTo(phone)).toEqual(["Respuesta a A", "Borrador de C", "¿Confirmo C?"]);
  });
});
