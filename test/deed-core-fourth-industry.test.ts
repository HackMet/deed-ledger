/**
 * A fourth industry, insurance claims, adopted by writing a policy and nothing else: no extension, no edit to the
 * core. The same steps run on the memory store and on D1 with schema.sql alone on a blank database.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  D1LedgerStore,
  DEFAULT_LEDGER_CONFIG,
  type Entry,
  type EntryJudge,
  type Evidence,
  type LedgerStore,
  MalformedEntry,
  MemoryLedgerStore,
  type Policy,
  type Verdict,
  entryFile,
  recheck,
} from "../src/deed-core";
import schemaSql from "../src/deed-core/schema.sql?raw";

const NOW = Date.UTC(2026, 10, 4);

const claimsPolicy: Policy = {
  kinds: {
    claim_filed: { evidence: [{ require: [{ kind: "policyholder_statement", min: 1, max: 1 }] }] },
    loss_assessed: { evidence: [{ require: [{ kind: "adjuster_report", min: 1, max: 1 }, { kind: "site_photo", min: 1 }] }] },
    // A large loss needs the underwriter's single sign-off; anything else needs two adjusters.
    settlement_issued: {
      evidence: [
        { when: { kind: "underwriter_signoff", min: 1 }, require: [{ kind: "underwriter_signoff", max: 1 }, { kind: "adjuster_report", min: 1 }] },
        { require: [{ kind: "adjuster_report", min: 2 }] },
      ],
    },
    claim_withdrawn: { evidence: [{ require: [{ kind: "policyholder_statement", min: 1 }] }] },
  },
};

const ev = (kind: string, refId: string): Evidence => ({ kind, refId, contentSha256: null });
const statement = (refId: string) => ev("policyholder_statement", refId);
const report = (refId: string) => ev("adjuster_report", refId);
const photo = (refId: string) => ev("site_photo", refId);
const signoff = (refId: string) => ev("underwriter_signoff", refId);

function claimEntry(factId: string, kind: string, evidence: readonly Evidence[], rest: Partial<Entry> = {}): Entry {
  return { factId, kind, operationKey: `op-${factId}`, actor: "adjuster-1", validFromMs: NOW, body: { factId }, evidence, dependsOn: [], closes: null, ...rest };
}

const filed = claimEntry("claim", "claim_filed", [statement("st-1")]);
const assessed = claimEntry("assess-1", "loss_assessed", [report("rp-1"), photo("ph-1")], { dependsOn: ["claim"] });

/** One scenario: the entries in order, and the verdict each must get. */
const scenarios: readonly { readonly name: string; readonly steps: readonly (readonly [Entry, string])[] }[] = [
  { name: "admits a claim with its statement", steps: [[filed, "admitted"]] },
  {
    name: "admits a large-loss settlement on the first rule and a small one on the second",
    steps: [
      [filed, "admitted"],
      [assessed, "admitted"],
      [claimEntry("large", "settlement_issued", [signoff("uw-1"), report("rp-2")], { dependsOn: ["assess-1"] }), "admitted"],
      [claimEntry("small", "settlement_issued", [report("rp-3"), report("rp-4")], { dependsOn: ["assess-1"] }), "admitted"],
    ],
  },
  {
    name: "refuses missing evidence: none at all, the wrong source, a rule half met, a bound passed",
    steps: [
      [claimEntry("none", "claim_filed", []), "evidence_incomplete"],
      [claimEntry("wrong", "claim_filed", [report("rp-1")]), "evidence_incomplete"],
      [claimEntry("half", "loss_assessed", [report("rp-1")]), "evidence_incomplete"],
      [claimEntry("two", "claim_filed", [statement("st-1"), statement("st-2")]), "evidence_incomplete"],
      [claimEntry("two-signoffs", "settlement_issued", [signoff("uw-1"), signoff("uw-2"), report("rp-1")]), "evidence_incomplete"],
      // A sign-off selects the first rule, so a second adjuster can't rescue a settlement that lacks the first rule's report.
      [claimEntry("signoff-only", "settlement_issued", [signoff("uw-1")]), "evidence_incomplete"],
    ],
  },
  { name: "refuses a kind the policy doesn't name", steps: [[claimEntry("odd", "claim_reopened", [statement("st-1")]), "unknown_kind"]] },
  {
    name: "refuses a used key, and a used fact id under a new key",
    steps: [
      [filed, "admitted"],
      [claimEntry("again", "claim_filed", [statement("st-2")], { operationKey: filed.operationKey }), "duplicate"],
      [claimEntry("claim", "claim_filed", [statement("st-3")], { operationKey: "op-new" }), "duplicate"],
    ],
  },
  {
    name: "a withdrawn claim blocks every descendant, however deep",
    steps: [
      [filed, "admitted"],
      [assessed, "admitted"],
      [claimEntry("withdrawn", "claim_withdrawn", [statement("st-2")], { closes: { factId: "claim", reason: "cancelled" } }), "admitted"],
      [claimEntry("direct", "loss_assessed", [report("rp-2"), photo("ph-2")], { dependsOn: ["claim"] }), "dependency_not_live"],
      [claimEntry("descendant", "settlement_issued", [report("rp-3"), report("rp-4")], { dependsOn: ["assess-1"] }), "dependency_not_live"],
      [claimEntry("withdrawn-twice", "claim_withdrawn", [statement("st-3")], { closes: { factId: "claim", reason: "cancelled" } }), "closes_not_live"],
    ],
  },
  {
    name: "a reassessment supersedes the first: what rests on both stays live, what rests on the old one alone dies",
    steps: [
      [filed, "admitted"],
      [assessed, "admitted"],
      [claimEntry("assess-2", "loss_assessed", [report("rp-2"), photo("ph-2")], { dependsOn: ["assess-1"], closes: { factId: "assess-1", reason: "superseded" } }), "admitted"],
      [claimEntry("on-new", "settlement_issued", [report("rp-3"), report("rp-4")], { dependsOn: ["assess-2"] }), "admitted"],
      [claimEntry("on-both", "settlement_issued", [report("rp-5"), report("rp-6")], { dependsOn: ["assess-1", "assess-2"] }), "admitted"],
      [claimEntry("on-old", "settlement_issued", [report("rp-7"), report("rp-8")], { dependsOn: ["assess-1"] }), "dependency_not_live"],
    ],
  },
];

const reasonOf = (verdict: Verdict): string => (verdict.admitted ? "admitted" : verdict.reason);

/** schema.sql as statements: each top-level statement starts with CREATE; D1 refuses the file's comments in a batch. */
const schemaStatements = schemaSql
  .replace(/--.*$/gm, "")
  .split(/;\n(?=CREATE\b)/)
  .map((statement_) => statement_.trim().replace(/;$/, ""))
  .filter((statement_) => statement_.length > 0);

beforeAll(async () => {
  await env.MIGRATION_TEST_DB.batch(schemaStatements.map((sql) => env.MIGRATION_TEST_DB.prepare(sql)));
});

/** The judge a third party re-runs from the file alone: the entries, in order, on a fresh memory store. */
const claimsJudge: EntryJudge<readonly Entry[], string> = {
  domain: "insurance-claims",
  states: ["admitted", "duplicate", "unknown_kind", "evidence_incomplete", "dependency_not_live", "closes_not_live"],
  parse: (raw) => {
    if (!Array.isArray(raw)) throw new MalformedEntry("input must list the entries");
    return raw as readonly Entry[];
  },
  rows: (entries) => {
    const store = new MemoryLedgerStore(claimsPolicy);
    return entries.map((item, index) => ({ rowKey: String(index), state: reasonOf(store.admitNow("file", item)) }));
  },
};

const stores: readonly { readonly name: string; readonly make: () => LedgerStore }[] = [
  { name: "memory", make: () => new MemoryLedgerStore(claimsPolicy) },
  { name: "D1 on schema.sql alone", make: () => new D1LedgerStore(env.MIGRATION_TEST_DB, DEFAULT_LEDGER_CONFIG, claimsPolicy) },
];

describe.each(stores)("insurance claims on $name", ({ name, make }) => {
  it.each(scenarios.map((item, index) => ({ ...item, index })))("$name", async ({ steps, index }) => {
    const store = make();
    const scope = `${name}-${index}`;
    for (const [item, expected] of steps) {
      expect(reasonOf(await store.admit(scope, item, NOW)), item.factId).toBe(expected);
    }
  });

  it("keeps insurers apart: a key, a dependency and a closure in another scope are not this one's", async () => {
    const store = make();
    expect(reasonOf(await store.admit(`${name}-insurer-a`, filed, NOW))).toBe("admitted");
    expect(reasonOf(await store.admit(`${name}-insurer-b`, assessed, NOW))).toBe("dependency_not_live");
    const closing = claimEntry("withdrawn", "claim_withdrawn", [statement("st-2")], { closes: { factId: "claim", reason: "cancelled" } });
    expect(reasonOf(await store.admit(`${name}-insurer-b`, closing, NOW))).toBe("closes_not_live");
    expect(reasonOf(await store.admit(`${name}-insurer-b`, filed, NOW))).toBe("admitted");
  });

  it.each(scenarios.map((item, index) => ({ ...item, index })))("re-checks the verdicts it issued from the file alone: $name", async ({ steps, index }) => {
    const store = make();
    const scope = `${name}-file-${index}`;
    const verdicts: { rowKey: string; state: string }[] = [];
    for (const [n, [item]] of steps.entries()) {
      verdicts.push({ rowKey: String(n), state: reasonOf(await store.admit(scope, item, NOW)) });
    }
    const entries = steps.map(([item]) => item);
    const file = JSON.parse(JSON.stringify({ ...entryFile(claimsJudge, entries), verdicts })) as unknown;
    expect(recheck(claimsJudge, file)).toEqual({ ok: true, pairs: steps.length, same: steps.length, differ: [] });
    const tampered = { ...(file as object), verdicts: verdicts.map((row, n) => (n === 0 ? { ...row, state: "duplicate" } : row)) };
    const result = recheck(claimsJudge, tampered);
    expect(result.ok && result.differ.map((row) => row.rowKey)).toEqual(["0"]);
  });
});

describe("insurance claims leave nothing behind on a refusal", () => {
  it("writes the admitted rows and no row of a refused entry, on schema.sql's tables", async () => {
    const db = env.MIGRATION_TEST_DB;
    const store = new D1LedgerStore(db, DEFAULT_LEDGER_CONFIG, claimsPolicy);
    const scope = "rows";
    await store.admit(scope, filed, NOW);
    await store.admit(scope, claimEntry("half", "loss_assessed", [report("rp-1")], { dependsOn: ["claim"] }), NOW);
    await store.admit(scope, claimEntry("odd", "claim_reopened", [statement("st-1")], { dependsOn: ["claim"] }), NOW);
    const count = async (table: string): Promise<number | undefined> =>
      (await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE scope_id = ?`).bind(scope).first<{ n: number }>())?.n;
    expect(await count("facts")).toBe(1);
    expect(await count("fact_evidence")).toBe(1);
    expect(await count("fact_dependencies")).toBe(0);
    expect((await db.prepare(`SELECT count(*) AS n FROM batch_guards`).first<{ n: number }>())?.n).toBe(0);
  });

  it("refuses to update or delete what it admitted", async () => {
    const db = env.MIGRATION_TEST_DB;
    const store = new D1LedgerStore(db, DEFAULT_LEDGER_CONFIG, claimsPolicy);
    await store.admit("append-only", filed, NOW);
    await expect(db.prepare(`UPDATE facts SET kind = 'claim_withdrawn' WHERE scope_id = 'append-only'`).run()).rejects.toThrow(/append-only/);
    await expect(db.prepare(`DELETE FROM fact_evidence WHERE scope_id = 'append-only'`).run()).rejects.toThrow(/append-only/);
  });
});
