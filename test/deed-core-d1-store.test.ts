import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PermanentWriteError, FactRefusedError } from "../src/application/errors";
import { guardedBatch } from "../src/infrastructure/d1/fence";
import { D1FactLedger, STORE_LEDGER } from "../src/infrastructure/d1/fact-ledger";
import { compileEvidence, D1LedgerStore, planEntry } from "../src/deed-core/d1-store";
import type { Entry, Evidence } from "../src/deed-core/types";
import type { FactCommit, FactKind } from "../src/domain/facts";
import { STORE_POLICY } from "../src/domain/store-policy";

const T = Date.UTC(2026, 10, 2);

/**
 * The evidence check as it was before the policy: copied from fact-ledger.ts at 0028, kept here to prove the
 * compiled policy gives the same answer over the matrix below. Do not edit it to match the policy.
 */
const OLD_EVIDENCE_COMPLETE = `WITH
    f AS (SELECT kind FROM facts WHERE business_id = ? AND id = ?),
    e AS (SELECT kind FROM fact_evidence WHERE business_id = ? AND fact_id = ?)
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM f) THEN 1
    WHEN NOT EXISTS (SELECT 1 FROM e) THEN NULL
    WHEN (SELECT kind FROM f) IN ('order_version', 'order_confirm', 'order_cancel', 'change_request') THEN
      CASE WHEN EXISTS (SELECT 1 FROM e WHERE kind = 'inbound_message') THEN 1 END
    WHEN (SELECT kind FROM f) IN ('order_status', 'change_review', 'business_info', 'receipt_review') THEN
      CASE WHEN (SELECT count(*) FROM e WHERE kind = 'member') = 1 THEN 1 END
    WHEN (SELECT kind FROM f) = 'receipt' AND EXISTS (SELECT 1 FROM e WHERE kind = 'member') THEN
      CASE WHEN (SELECT count(*) FROM e WHERE kind = 'member') = 1 AND EXISTS (SELECT 1 FROM e WHERE kind = 'media_asset') THEN 1 END
    WHEN (SELECT kind FROM f) = 'cancellation' AND EXISTS (SELECT 1 FROM e WHERE kind = 'member') THEN
      CASE WHEN (SELECT count(*) FROM e WHERE kind = 'member') = 1 THEN 1 END
    WHEN (SELECT kind FROM f) = 'price' AND (SELECT count(*) FROM e WHERE kind = 'member') = 1 THEN 1
    WHEN (SELECT count(*) FROM e WHERE kind = 'confirmation') = 1
      AND EXISTS (SELECT 1 FROM e WHERE kind = 'inbound_message') THEN 1
  END`;

const ALL_KINDS: FactKind[] = [
  "receipt",
  "cancellation",
  "price",
  "order_version",
  "order_confirm",
  "order_cancel",
  "order_status",
  "business_info",
  "change_request",
  "change_review",
  "receipt_review",
];
const EVIDENCE_KINDS = ["inbound_message", "media_asset", "confirmation", "stock_movement", "fact", "member", "session"] as const;

async function seedBusiness(): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO businesses (id, name, created_at_ms) VALUES (?, 'Tienda', ?)`).bind(id, T).run();
  return id;
}

function entry(overrides: Partial<Entry> & { readonly kind: string }): Entry {
  return {
    factId: crypto.randomUUID(),
    operationKey: crypto.randomUUID(),
    actor: "u",
    validFromMs: T,
    body: {},
    evidence: [],
    dependsOn: [],
    closes: null,
    ...overrides,
  };
}

const member = (refId = crypto.randomUUID()): Evidence => ({ kind: "member", refId, contentSha256: null });
const confirmation = (refId = crypto.randomUUID()): Evidence => ({ kind: "confirmation", refId, contentSha256: null });
const inbound = (refId = crypto.randomUUID()): Evidence => ({ kind: "inbound_message", refId, contentSha256: null });

async function factCount(businessId: string, operationKey: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM facts WHERE business_id = ? AND operation_key = ?`)
    .bind(businessId, operationKey)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("the compiled evidence policy against the evidence check it replaces", () => {
  it("agrees with the old check on every kind and every evidence count of 0, 1 and 2, and on an absent fact", async () => {
    const businessId = await seedBusiness();
    const compiled = compileEvidence(STORE_POLICY, STORE_LEDGER);
    const factIds = new Map<FactKind, string>();
    for (const kind of ALL_KINDS) {
      const id = crypto.randomUUID();
      factIds.set(kind, id);
      await env.DB.prepare(
        `INSERT INTO facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json)
         VALUES (?, ?, ?, ?, 'u', ?, ?, '{}')`,
      )
        .bind(id, businessId, kind, `key:${kind}`, T, T)
        .run();
    }

    // The four kinds the old check reads by count take 0, 1 or 2 (3^4 = 81). The other three are read only as
    // present or absent, so they take 0 or 1 (2^3 = 8): every distinct answer the checks can give, 648 cases a kind.
    // The full 3^7 matrix is 2187 a kind and ran past the suite's time budget.
    const counted = ["confirmation", "inbound_message", "member", "media_asset"] as const;
    const presence = ["stock_movement", "fact", "session"] as const;
    const combinations: Record<string, number>[] = [];
    for (let n = 0; n < 3 ** counted.length; n++) {
      for (let p = 0; p < 2 ** presence.length; p++) {
        const counts: Record<string, number> = {};
        counted.forEach((kind, position) => (counts[kind] = Math.floor(n / 3 ** position) % 3));
        presence.forEach((kind, position) => (counts[kind] = Math.floor(p / 2 ** position) % 2));
        combinations.push(counts);
      }
    }
    const mismatches: string[] = [];
    let cases = 0;
    const compare = async (factId: string, counts: Record<string, number>): Promise<void> => {
      const statements: D1PreparedStatement[] = [
        env.DB.prepare(`DELETE FROM fact_evidence WHERE business_id = ? AND fact_id = ?`).bind(businessId, factId),
      ];
      for (const evidenceKind of EVIDENCE_KINDS) {
        for (let i = 0; i < (counts[evidenceKind] ?? 0); i++) {
          statements.push(
            env.DB.prepare(`INSERT INTO fact_evidence (business_id, fact_id, kind, ref_id, content_sha256) VALUES (?, ?, ?, ?, NULL)`).bind(
              businessId,
              factId,
              evidenceKind,
              `r${i}`,
            ),
          );
        }
      }
      const params = [businessId, factId, businessId, factId];
      statements.push(env.DB.prepare(`SELECT (${OLD_EVIDENCE_COMPLETE}) AS verdict`).bind(...params));
      statements.push(env.DB.prepare(`SELECT (${compiled}) AS verdict`).bind(...params));
      const results = await env.DB.batch(statements);
      const [old, next] = results.slice(-2).map((result) => (result.results[0] as { verdict: number | null }).verdict ?? null);
      cases++;
      if (old !== next) mismatches.push(`${factId} ${JSON.stringify(counts)}: old ${old} compiled ${next}`);
    };
    for (const kind of ALL_KINDS) {
      for (const counts of combinations) await compare(factIds.get(kind)!, counts);
    }
    // The absent fact holds under both: the fence's re-check after a rolled-back batch depends on it.
    const absent = crypto.randomUUID();
    await compare(absent, {});
    expect(mismatches).toEqual([]);
    expect(cases).toBe(ALL_KINDS.length * combinations.length + 1);
  }, 120_000);

  it("refuses a kind the policy doesn't name, and zero evidence, inside the batch, with nothing written", async () => {
    const businessId = await seedBusiness();
    const refuse = (reason: string) => new PermanentWriteError(reason);
    for (const [kind, evidence] of [
      ["made_up", [confirmation(), inbound()]],
      ["price", []],
    ] as const) {
      const e = entry({ kind, evidence: [...evidence] });
      const plan = planEntry(env.DB, STORE_LEDGER, STORE_POLICY, businessId, e, T, refuse);
      await expect(guardedBatch(env.DB, plan.guards, plan.statements, plan.post)).rejects.toBeInstanceOf(PermanentWriteError);
      expect(await factCount(businessId, e.operationKey)).toBe(0);
    }
  });
});

describe("the store's D1 ledger on the core (D1LedgerStore)", () => {
  it("admits what the policy holds, and refuses in the judge's order with nothing written", async () => {
    const businessId = await seedBusiness();
    const store = new D1LedgerStore(env.DB, STORE_LEDGER, STORE_POLICY);

    const kept = entry({ kind: "price", evidence: [member()] });
    expect(await store.admit(businessId, kept, T)).toEqual({ admitted: true, factId: kept.factId });
    expect(await store.admit(businessId, entry({ kind: "price", operationKey: kept.operationKey, evidence: [member()] }), T)).toEqual({
      admitted: false,
      reason: "duplicate",
    });
    expect(await store.admit(businessId, entry({ kind: "made_up", evidence: [member()] }), T)).toEqual({
      admitted: false,
      reason: "unknown_kind",
    });
    const incomplete = entry({ kind: "receipt", evidence: [confirmation()] });
    expect(await store.admit(businessId, incomplete, T)).toEqual({ admitted: false, reason: "evidence_incomplete" });
    expect(await factCount(businessId, incomplete.operationKey)).toBe(0);

    const cancel = entry({ kind: "cancellation", evidence: [member()], closes: { factId: kept.factId, reason: "cancelled" } });
    expect(await store.admit(businessId, cancel, T)).toEqual({ admitted: true, factId: cancel.factId });
    expect(
      await store.admit(businessId, entry({ kind: "price", evidence: [member()], dependsOn: [kept.factId] }), T),
    ).toEqual({ admitted: false, reason: "dependency_not_live" });
    expect(
      await store.admit(businessId, entry({ kind: "cancellation", evidence: [member()], closes: { factId: kept.factId, reason: "cancelled" } }), T),
    ).toEqual({ admitted: false, reason: "closes_not_live" });
    expect(
      await store.admit(businessId, entry({ kind: "cancellation", evidence: [member()], closes: { factId: crypto.randomUUID(), reason: "cancelled" } }), T),
    ).toEqual({ admitted: false, reason: "closes_not_live" });
  });

  it("keeps scopes apart: a key, a dependency or a closure in another store is not this store's", async () => {
    const ours = await seedBusiness();
    const theirs = await seedBusiness();
    const store = new D1LedgerStore(env.DB, STORE_LEDGER, STORE_POLICY);
    const sharedKey = crypto.randomUUID();
    const foreign = entry({ kind: "price", evidence: [member()], operationKey: sharedKey });
    expect(await store.admit(theirs, foreign, T)).toEqual({ admitted: true, factId: foreign.factId });
    // The same key in another scope is a new operation, not a duplicate.
    const mine = entry({ kind: "price", evidence: [member()], operationKey: sharedKey });
    expect(await store.admit(ours, mine, T)).toEqual({ admitted: true, factId: mine.factId });
    expect(await store.admit(ours, entry({ kind: "price", evidence: [member()], dependsOn: [foreign.factId] }), T)).toEqual({
      admitted: false,
      reason: "dependency_not_live",
    });
    expect(
      await store.admit(ours, entry({ kind: "cancellation", evidence: [member()], closes: { factId: foreign.factId, reason: "cancelled" } }), T),
    ).toEqual({ admitted: false, reason: "closes_not_live" });
  });

  it("keeps the guard order: the draft, then the dependency gate, then the closure; the evidence rule after", () => {
    const businessId = "business-order";
    const commit: FactCommit = {
      factId: crypto.randomUUID(),
      kind: "receipt",
      operationKey: crypto.randomUUID(),
      draft: { id: crypto.randomUUID(), revision: 1 },
      actorUserId: "u",
      validFromMs: T,
      body: {},
      evidence: [{ kind: "confirmation", refId: "c", contentSha256: null }, { kind: "inbound_message", refId: "i", contentSha256: null }],
      dependsOn: [crypto.randomUUID()],
      sameBatch: [],
      closes: { factId: crypto.randomUUID(), reason: "cancelled" },
      movements: [],
    };
    const batch = new D1FactLedger(env.DB).statementsFor({ businessId }, commit, T);
    // G3 (no conversation), then G4, then G5; P1 after the statements, as before.
    expect(batch.guards.map((guard) => guard.error())).toEqual([
      new FactRefusedError("draft_not_pending"),
      new FactRefusedError("dependency_not_live"),
      new FactRefusedError("closes_not_live"),
    ]);
    expect(batch.guards.map((guard) => guard.error().message)).toEqual([
      "fact refused: draft_not_pending",
      "fact refused: dependency_not_live",
      "fact refused: closes_not_live",
    ]);
    expect(batch.post?.map((guard) => guard.error().name)).toEqual(["PermanentWriteError"]);
    expect(batch.post?.map((guard) => guard.error().message)).toEqual(["fact admitted without its evidence"]);
  });
});

describe("the policy is data the core reads, not a store word", () => {
  it("gives every store kind a rule, so an unnamed kind is refused", () => {
    expect(Object.keys(STORE_POLICY.kinds).sort()).toEqual([...ALL_KINDS].sort());
    for (const kind of ALL_KINDS) expect(STORE_POLICY.kinds[kind]!.evidence.length).toBeGreaterThan(0);
  });
});
