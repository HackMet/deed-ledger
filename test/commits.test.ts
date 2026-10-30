import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { JobConflictError, LeaseLostError } from "../src/application/errors";
import { placeholderHandler } from "../src/application/placeholder-handler";
import type { Commit, JobHandler, JobInput, Lease } from "../src/application/ports";
import { couldNotProcess, RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { conversationOf, expireLease, type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

/** Stands in for an engine table: one row per operation key, like the real commit batch. */
beforeAll(async () => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS test_facts (
       business_id TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL)`,
  ).run();
});

class RecordsMovedError extends Error {
  override readonly name = "RecordsMovedError";
}

/** A commit that saves one fact, guarded by `holds` the way a version check would be. */
function factCommit(input: JobInput, operationKey: string, holds = true): Commit {
  return {
    guards: [{ holdsSql: `SELECT 1 WHERE ? = 1`, params: [holds ? 1 : 0], error: () => new RecordsMovedError() }],
    statements: [
      env.DB.prepare(`INSERT INTO test_facts (business_id, operation_key, job_id) VALUES (?, ?, ?)`).bind(
        input.lease.businessId,
        operationKey,
        input.job.id,
      ),
    ],
  };
}

/** Replies like the placeholder and saves one fact per job, keyed by the message text. */
function savingHandler(options: { guardHoldsFrom?: number } = {}): JobHandler & { calls: number } {
  const handler = {
    calls: 0,
    async handle(input: JobInput) {
      handler.calls++;
      const holds = handler.calls >= (options.guardHoldsFrom ?? 1);
      const { replies } = await placeholderHandler.handle(input);
      return { replies, commits: [factCommit(input, `op:${input.job.textBody}`, holds)] };
    },
  };
  return handler;
}

const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

async function factsOf(businessId: string): Promise<string[]> {
  return (
    await rows<{ operation_key: string }>(
      `SELECT operation_key FROM test_facts WHERE business_id = ? ORDER BY operation_key`,
      businessId,
    )
  ).map((row) => row.operation_key);
}

async function jobsOf(businessId: string) {
  return rows<{ job_state: string; attempts: number; last_error: string | null }>(
    `SELECT job_state, attempts, last_error FROM inbound_messages WHERE business_id = ? ORDER BY order_ts_s, received_at_ms`,
    businessId,
  );
}

async function outboxOf(businessId: string) {
  return rows<{ kind: string; body_text: string }>(
    `SELECT kind, body_text FROM outbound_messages WHERE business_id = ? ORDER BY created_at_ms`,
    businessId,
  );
}

async function sendText(h: Harness, body: string) {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body })] }));
  h.clock.advance(4_000);
  return { store, phone };
}

describe("a job's commits save with the job (JobOutcome.commits)", () => {
  it("saves the commits, completes the job and writes its reply in one batch", async () => {
    const h = harness({ jobHandler: savingHandler() });
    const { store, phone } = await sendText(h, "dos leches");
    await h.deliver();

    expect(await factsOf(store.businessId)).toEqual(["op:dos leches"]);
    expect(await jobsOf(store.businessId)).toMatchObject([{ job_state: "done", attempts: 1 }]);
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
  });

  it("saves nothing when a commit guard doesn't hold, and retries the job", async () => {
    const handler = savingHandler({ guardHoldsFrom: 2 });
    const h = harness({ jobHandler: handler });
    const { store, phone } = await sendText(h, "tres panes");
    await h.deliver();

    expect(await factsOf(store.businessId)).toEqual([]);
    expect(await outboxOf(store.businessId)).toEqual([]);
    expect(await jobsOf(store.businessId)).toMatchObject([{ job_state: "pending", attempts: 1, last_error: "commit_refused" }]);
    expect(h.log.fields("job_commit_refused")).toMatchObject([{ reason: "RecordsMovedError" }]);

    h.clock.advance(5_000);
    await h.deliver(h.doorbell.take().slice(0, 1));
    expect(handler.calls).toBe(2);
    expect(await factsOf(store.businessId)).toEqual(["op:tres panes"]);
    expect(await jobsOf(store.businessId)).toMatchObject([{ job_state: "done", attempts: 2 }]);
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
  });

  it("rolls back every commit on a constraint violation and fails the job visibly", async () => {
    const h = harness({
      jobHandler: {
        async handle(input) {
          const { replies } = await placeholderHandler.handle(input);
          // The second fact reuses the first one's operation key.
          return { replies, commits: [factCommit(input, `dup:${input.job.id}`), factCommit(input, `dup:${input.job.id}`)] };
        },
      },
    });
    const { store, phone } = await sendText(h, "una caja");
    await h.deliver();

    expect(await factsOf(store.businessId)).toEqual([]);
    expect(await jobsOf(store.businessId)).toMatchObject([{ job_state: "failed", last_error: "commit_rejected" }]);
    expect(await outboxOf(store.businessId)).toEqual([{ kind: "job_failed", body_text: couldNotProcess("text") }]);
    expect(h.sentTo(phone)).toEqual([couldNotProcess("text")]);
  });

  it("saves the commits even when the closing reply is withheld for a newer message", async () => {
    const phone = newPhone();
    const store = await seedStore({ members: [{ phone, role: "owner" }] });
    const t = 1_793_196_000;
    let h!: Harness;
    const saving = savingHandler();
    h = harness({
      jobHandler: {
        async handle(input) {
          if (input.job.textBody === "A") {
            // B arrives while A, the burst's last job so far, is being handled.
            await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: t + 1, body: "B" })] }));
          }
          return saving.handle(input);
        },
      },
    });
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: t, body: "A" })] }));
    h.clock.advance(4_000);
    await h.deliver(h.doorbell.take());

    expect(await factsOf(store.businessId)).toEqual(["op:A"]);
    expect(h.sentTo(phone)).toEqual([]);
    expect(h.log.fields("burst_reply_withheld")).toHaveLength(1);

    h.clock.advance(4_000);
    await h.deliver(h.doorbell.take().slice(0, 1));
    expect(await factsOf(store.businessId)).toEqual(["op:A", "op:B"]);
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
  });

  it("refuses a stale writer's commits with LeaseLostError, before any commit guard", async () => {
    const h = harness();
    const { store } = await sendText(h, "cuatro jugos");
    const leaseId = crypto.randomUUID();
    const lease: Lease = { ...(await conversationOf(store.businessId)), leaseId };
    expect(await h.deps.jobs.claimLease(lease, leaseId, 60_000)).toBe("claimed");
    const [job] = await rows<{ id: string }>(`SELECT id FROM inbound_messages WHERE business_id = ?`, store.businessId);
    await h.deps.jobs.startJob(lease, job!.id, h.clock.now());
    await expireLease(lease.conversationId);

    const input = { lease, job: { id: job!.id } } as JobInput;
    await expect(
      h.deps.jobs.completeJob(lease, job!.id, h.clock.now(), [], false, [factCommit(input, "op:stale", false)]),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await factsOf(store.businessId)).toEqual([]);
  });

  it("refuses commits for a job not running under the lease with JobConflictError, before any commit guard", async () => {
    const h = harness();
    const { store } = await sendText(h, "cinco sodas");
    const leaseId = crypto.randomUUID();
    const lease: Lease = { ...(await conversationOf(store.businessId)), leaseId };
    expect(await h.deps.jobs.claimLease(lease, leaseId, 60_000)).toBe("claimed");
    const [job] = await rows<{ id: string }>(`SELECT id FROM inbound_messages WHERE business_id = ?`, store.businessId);

    // Never started: the job is still pending.
    const input = { lease, job: { id: job!.id } } as JobInput;
    await expect(
      h.deps.jobs.completeJob(lease, job!.id, h.clock.now(), [], false, [factCommit(input, "op:unstarted", false)]),
    ).rejects.toBeInstanceOf(JobConflictError);
    expect(await factsOf(store.businessId)).toEqual([]);
  });
});
