import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FactRefusedError, PermanentWriteError } from "../src/application/errors";
import type { Commit, Lease, OutboxDraft } from "../src/application/ports";
import { D1FactLedger } from "../src/infrastructure/d1/fact-ledger";
import type { EvidenceRef, FactCommit } from "../src/domain/facts";
import { conversationOf, type Harness, harness, OUTLIVES_TEST_MS, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

/**
 * The seam under test: the engine returns domain `FactCommit`s and the ledger turns each one into
 * the `Commit` that `completeJob` runs in the job's batch. Production wires this the same way.
 */
const toCommit = (h: Harness, lease: Lease, commit: FactCommit): Commit =>
  new D1FactLedger(env.DB).statementsFor(lease, commit, h.clock.now());

function reply(): OutboxDraft {
  const id = crypto.randomUUID();
  return { id, kind: "reply", body: "Guardado", dedupeKey: `test:${id}`, replyIndex: 0, partIndex: 0, expiresAtMs: Date.now() + OUTLIVES_TEST_MS };
}

/** A store whose owner's conversation is leased, with one pending receipt draft at `revision`. */
async function storeWithDraft(h: Harness, revision = 1) {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  const leaseId = crypto.randomUUID();
  const send = (body: string) =>
    h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body })] }));
  await send("foto de factura");
  const lease: Lease = { ...(await conversationOf(store.businessId)), leaseId };
  expect(await h.deps.jobs.claimLease(lease, leaseId, 60_000)).toBe("claimed");
  const draftId = crypto.randomUUID();
  const productId = crypto.randomUUID();
  const now = h.clock.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) VALUES (?, ?, 'Coca-Cola 600 ml', ?)`).bind(
      productId,
      store.businessId,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO drafts (id, business_id, conversation_id, kind, revision, state, payload_json, source_inbound_id,
         expires_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'receipt', ?, 'pending', '{}', 'inbound-photo', ?, ?, ?)`,
    ).bind(draftId, store.businessId, lease.conversationId, revision, now + 3_600_000, now, now),
  ]);

  // The photo's job proposed the draft; it is done before any tap.
  const [photo] = await rows<{ id: string }>(`SELECT id FROM inbound_messages WHERE business_id = ?`, store.businessId);
  await h.deps.jobs.startJob(lease, photo!.id, now);
  await h.deps.jobs.completeJob(lease, photo!.id, now, [], false);

  /** Delivers one more owner message and starts it: the confirming tap's job. */
  async function nextJob(body = "confirmar"): Promise<string> {
    await send(body);
    const [job] = await rows<{ id: string }>(
      `SELECT id FROM inbound_messages WHERE business_id = ? AND job_state = 'pending' ORDER BY received_at_ms, id`,
      store.businessId,
    );
    await h.deps.jobs.startJob(lease, job!.id, h.clock.now());
    return job!.id;
  }

  /** A receipt confirmation of the draft at `rev`: one fact, one movement of `qtyMilli`. */
  function confirmation(jobId: string, rev = revision, qtyMilli = 12_000, evidence?: EvidenceRef[]): FactCommit {
    return {
      factId: crypto.randomUUID(),
      kind: "receipt",
      operationKey: `receipt:${draftId}`,
      draft: { id: draftId, revision: rev },
      actorUserId: store.members[0]!.userId,
      validFromMs: h.clock.now(),
      body: { lines: 1 },
      evidence: evidence ?? [
        { kind: "inbound_message", refId: jobId, contentSha256: null },
        { kind: "confirmation", refId: crypto.randomUUID(), contentSha256: null },
      ],
      dependsOn: [],
      closes: null,
      movements: [{ id: crypto.randomUUID(), productId, qtyMilli, unitCostCentavos: 1500 }],
    };
  }

  return { store, lease, draftId, productId, nextJob, confirmation };
}

async function ledgerOf(businessId: string) {
  const count = async (table: string) =>
    (await rows<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE business_id = ?`, businessId))[0]!.n;
  return {
    facts: await count("facts"),
    confirmations: await count("draft_confirmations"),
    evidence: await count("fact_evidence"),
    movements: await count("stock_movements"),
    balances: await rows<{ qty_milli: number }>(`SELECT qty_milli FROM stock_balances WHERE business_id = ?`, businessId),
    replies: await count("outbound_messages"),
    draft: (await rows<{ state: string }>(`SELECT state FROM drafts WHERE business_id = ?`, businessId))[0]!.state,
  };
}

async function jobState(jobId: string): Promise<string> {
  return (await rows<{ job_state: string }>(`SELECT job_state FROM inbound_messages WHERE id = ?`, jobId))[0]!.job_state;
}

describe("completeJob admits facts in its one batch (spec §5)", () => {
  it("commits the fact, its movement, the job and the reply together", async () => {
    const h = harness();
    const s = await storeWithDraft(h);
    const tap = await s.nextJob();

    expect(await h.deps.jobs.completeJob(s.lease, tap, h.clock.now(), [reply()], false, [toCommit(h, s.lease, s.confirmation(tap))])).toBe(1);

    expect(await ledgerOf(s.store.businessId)).toEqual({
      facts: 1,
      confirmations: 1,
      evidence: 2,
      movements: 1,
      balances: [{ qty_milli: 12_000 }],
      replies: 1,
      draft: "committed",
    });
    expect(await jobState(tap)).toBe("done");
  });

  it("the same confirmation delivered twice writes exactly one fact", async () => {
    const h = harness();
    const s = await storeWithDraft(h);
    const first = await s.nextJob();
    await h.deps.jobs.completeJob(s.lease, first, h.clock.now(), [reply()], false, [toCommit(h, s.lease, s.confirmation(first))]);
    const second = await s.nextJob();

    await expect(
      h.deps.jobs.completeJob(s.lease, second, h.clock.now(), [reply()], false, [toCommit(h, s.lease, s.confirmation(second))]),
    ).rejects.toEqual(new FactRefusedError("draft_not_pending"));

    expect(await ledgerOf(s.store.businessId)).toEqual({
      facts: 1,
      confirmations: 1,
      evidence: 2,
      movements: 1,
      balances: [{ qty_milli: 12_000 }],
      replies: 1,
      draft: "committed",
    });
    expect(await jobState(second)).toBe("processing");
  });

  it("a confirmation of a stale draft revision writes nothing", async () => {
    const h = harness();
    const s = await storeWithDraft(h, 2); // corrected to revision 2 after the owner saw revision 1
    const tap = await s.nextJob();

    await expect(
      h.deps.jobs.completeJob(s.lease, tap, h.clock.now(), [reply()], false, [toCommit(h, s.lease, s.confirmation(tap, 1))]),
    ).rejects.toEqual(new FactRefusedError("draft_not_pending"));

    expect(await ledgerOf(s.store.businessId)).toEqual({
      facts: 0,
      confirmations: 0,
      evidence: 0,
      movements: 0,
      balances: [],
      replies: 0,
      draft: "pending",
    });
    expect(await jobState(tap)).toBe("processing");
  });

  it("a negative balance writes no fact, no reply, and leaves the job not done", async () => {
    const h = harness();
    const s = await storeWithDraft(h);
    const tap = await s.nextJob();

    await expect(
      h.deps.jobs.completeJob(s.lease, tap, h.clock.now(), [reply()], false, [toCommit(h, s.lease, s.confirmation(tap, 1, -5_000))]),
    ).rejects.toBeInstanceOf(PermanentWriteError);

    expect(await ledgerOf(s.store.businessId)).toEqual({
      facts: 0,
      confirmations: 0,
      evidence: 0,
      movements: 0,
      balances: [],
      replies: 0,
      draft: "pending",
    });
    expect(await jobState(tap)).toBe("processing");
  });

  it("a fact without confirmation evidence is refused by the post-guard", async () => {
    const h = harness();
    const s = await storeWithDraft(h);
    const tap = await s.nextJob();
    const unconfirmed = s.confirmation(tap, 1, 12_000, [{ kind: "inbound_message", refId: tap, contentSha256: null }]);

    await expect(h.deps.jobs.completeJob(s.lease, tap, h.clock.now(), [reply()], false, [toCommit(h, s.lease, unconfirmed)])).rejects.toBeInstanceOf(
      PermanentWriteError,
    );

    expect(await ledgerOf(s.store.businessId)).toEqual({
      facts: 0,
      confirmations: 0,
      evidence: 0,
      movements: 0,
      balances: [],
      replies: 0,
      draft: "pending",
    });
    expect(await jobState(tap)).toBe("processing");
  });
});

describe("a cancellation closes a fact and blocks everything that depends on it (spec §2, §3, §5)", () => {
  type Store = Awaited<ReturnType<typeof storeWithDraft>>;

  /** A fact with no draft and no movement, resting on `tap`: one link of a dependency chain. */
  function linkOf(h: Harness, s: Store, tap: string, over: Partial<FactCommit> = {}): FactCommit {
    return {
      factId: crypto.randomUUID(),
      kind: "price",
      operationKey: `link:${crypto.randomUUID()}`,
      draft: null,
      actorUserId: s.store.members[0]!.userId,
      validFromMs: h.clock.now(),
      body: null,
      evidence: [
        { kind: "inbound_message", refId: tap, contentSha256: null },
        { kind: "confirmation", refId: crypto.randomUUID(), contentSha256: null },
      ],
      dependsOn: [],
      closes: null,
      movements: [],
      ...over,
    };
  }

  /** Admits `fact` through its own job, one tap at a time. */
  async function admit(h: Harness, s: Store, fact: (tap: string) => FactCommit): Promise<FactCommit> {
    const tap = await s.nextJob();
    const commit = fact(tap);
    await h.deps.jobs.completeJob(s.lease, tap, h.clock.now(), [], false, [toCommit(h, s.lease, commit)]);
    return commit;
  }

  /** Admits a cancellation of `target` through its own job. */
  function cancel(h: Harness, s: Store, target: string): Promise<FactCommit> {
    return admit(h, s, (tap) => linkOf(h, s, tap, { kind: "cancellation", closes: { factId: target, reason: "cancelled" } }));
  }

  it("a second cancellation of the same fact fails on its primary key, and the first restores its stock", async () => {
    const h = harness();
    const s = await storeWithDraft(h);
    const tap = await s.nextJob();
    const receipt = s.confirmation(tap);
    await h.deps.jobs.completeJob(s.lease, tap, h.clock.now(), [reply()], false, [toCommit(h, s.lease, receipt)]);

    const first = await cancel(h, s, receipt.factId);
    const [movement] = await rows<{ qty_milli: number }>(
      `SELECT qty_milli FROM stock_movements WHERE business_id = ? AND fact_id = ?`,
      s.store.businessId,
      first.factId,
    );
    expect(movement).toEqual({ qty_milli: -12_000 });
    expect(await ledgerOf(s.store.businessId)).toMatchObject({ facts: 2, movements: 2, balances: [{ qty_milli: 0 }] });
    // The original receipt is untouched: append-only, its movement still stands.
    expect(await rows(`SELECT qty_milli FROM stock_movements WHERE business_id = ? AND fact_id = ?`, s.store.businessId, receipt.factId)).toEqual([
      { qty_milli: 12_000 },
    ]);

    const before = await ledgerOf(s.store.businessId);
    const again = await s.nextJob();
    await expect(
      h.deps.jobs.completeJob(s.lease, again, h.clock.now(), [], false, [
        toCommit(h, s.lease, linkOf(h, s, again, { kind: "cancellation", closes: { factId: receipt.factId, reason: "cancelled" } })),
      ]),
    ).rejects.toThrow(/UNIQUE constraint failed: fact_closures/);
    expect(await ledgerOf(s.store.businessId)).toEqual(before);
    expect(await jobState(again)).toBe("processing");
  });

  it("a dependent of a cancelled ancestor, at depth 1, is refused", async () => {
    const h = harness();
    const s = await storeWithDraft(h);
    const ancestor = await admit(h, s, (tap) => linkOf(h, s, tap));
    await cancel(h, s, ancestor.factId);

    const tap = await s.nextJob();
    await expect(
      h.deps.jobs.completeJob(s.lease, tap, h.clock.now(), [], false, [toCommit(h, s.lease, linkOf(h, s, tap, { dependsOn: [ancestor.factId] }))]),
    ).rejects.toEqual(new FactRefusedError("dependency_not_live"));
    expect(await jobState(tap)).toBe("processing");
  });

  it("a dependent of a cancelled ancestor, at depth 3, is refused", async () => {
    const h = harness();
    const s = await storeWithDraft(h);
    const a = await admit(h, s, (tap) => linkOf(h, s, tap));
    const b = await admit(h, s, (tap) => linkOf(h, s, tap, { dependsOn: [a.factId] }));
    const c = await admit(h, s, (tap) => linkOf(h, s, tap, { dependsOn: [b.factId] }));
    await cancel(h, s, a.factId);

    const tap = await s.nextJob();
    await expect(
      h.deps.jobs.completeJob(s.lease, tap, h.clock.now(), [], false, [toCommit(h, s.lease, linkOf(h, s, tap, { dependsOn: [c.factId] }))]),
    ).rejects.toEqual(new FactRefusedError("dependency_not_live"));
    expect((await ledgerOf(s.store.businessId)).facts).toBe(4);
  });

  it("a dependent of a live ancestor commits", async () => {
    const h = harness();
    const s = await storeWithDraft(h);
    const ancestor = await admit(h, s, (tap) => linkOf(h, s, tap));

    const tap = await s.nextJob();
    expect(
      await h.deps.jobs.completeJob(s.lease, tap, h.clock.now(), [reply()], false, [toCommit(h, s.lease, linkOf(h, s, tap, { dependsOn: [ancestor.factId] }))]),
    ).toBe(1);
    expect((await ledgerOf(s.store.businessId)).facts).toBe(2);
    expect(await jobState(tap)).toBe("done");
  });

  it("a dependency that belongs to another store is refused", async () => {
    const h = harness();
    const ours = await storeWithDraft(h);
    const theirs = await storeWithDraft(h);
    const foreign = await admit(h, theirs, (tap) => linkOf(h, theirs, tap));

    const tap = await ours.nextJob();
    await expect(
      h.deps.jobs.completeJob(ours.lease, tap, h.clock.now(), [], false, [toCommit(h, ours.lease, linkOf(h, ours, tap, { dependsOn: [foreign.factId] }))]),
    ).rejects.toEqual(new FactRefusedError("dependency_not_live"));
    expect((await ledgerOf(ours.store.businessId)).facts).toBe(0);
  });
});
