/**
 * The core's own SQL on schema.sql, on a blank database: the evidence door, the dependency gate, the scope of its
 * reads, the host's extension, a concurrent duplicate, and the triggers that keep the four tables append-only.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { D1LedgerStore, DEFAULT_LEDGER_CONFIG, type Entry, type HostExtension, type Policy, planEntry } from "../src/deed-core";
import { compileEvidence } from "../src/deed-core/d1-store";
import schemaSql from "../src/deed-core/schema.sql?raw";

const db = env.MIGRATION_TEST_DB;
const T = Date.UTC(2026, 10, 4);
const id = () => crypto.randomUUID();

/** schema.sql as statements: each top-level statement starts with CREATE; D1's exec() refuses the file's comments. */
const schemaStatements = schemaSql
  .replace(/--.*$/gm, "")
  .split(/;\n(?=CREATE\b)/)
  .map((statement) => statement.trim().replace(/;$/, ""))
  .filter((statement) => statement.length > 0);

/** A policy that holds on nothing: "at most five" is true of zero witnesses, so only the core's own refusals can stop a fact. */
const lenient: Policy = { kinds: { free: { evidence: [{ require: [{ kind: "ev", max: 5 }] }] } } };

const ev = (kind: string, refId: string) => ({ kind, refId, contentSha256: null });

function entryOf(init: Pick<Entry, "factId" | "kind"> & Partial<Entry>): Entry {
  return { operationKey: id(), actor: "u", validFromMs: T, body: {}, evidence: [], dependsOn: [], closes: null, ...init };
}

async function seedFact(scope: string, factId: string, kind: string): Promise<string> {
  const operationKey = id();
  await db
    .prepare(`INSERT INTO facts (scope_id, id, kind, operation_key, actor_id, valid_from_ms, recorded_at_ms, body_json) VALUES (?, ?, ?, ?, 'u', ?, ?, '{}')`)
    .bind(scope, factId, kind, operationKey, T, T)
    .run();
  return operationKey;
}

async function seedEvidence(scope: string, factId: string, kind: string, refId: string): Promise<void> {
  await db
    .prepare(`INSERT INTO fact_evidence (scope_id, fact_id, kind, ref_id, content_sha256) VALUES (?, ?, ?, ?, NULL)`)
    .bind(scope, factId, kind, refId)
    .run();
}

async function seedEdge(scope: string, factId: string, dependsOn: string): Promise<void> {
  await db.prepare(`INSERT INTO fact_dependencies (scope_id, fact_id, depends_on_fact_id) VALUES (?, ?, ?)`).bind(scope, factId, dependsOn).run();
}

async function seedClosure(scope: string, factId: string, closedBy: string, reason: string): Promise<void> {
  await db
    .prepare(`INSERT INTO fact_closures (scope_id, fact_id, closed_by_fact_id, reason, closed_at_ms) VALUES (?, ?, ?, ?, ?)`)
    .bind(scope, factId, closedBy, reason, T)
    .run();
}

/** The compiled evidence rule for one fact, as the store's post-guard runs it: 1 when it holds, null when refused. */
async function evidenceVerdict(scope: string, factId: string, policy: Policy): Promise<number | null> {
  const row = await db
    .prepare(`SELECT (${compileEvidence(policy, DEFAULT_LEDGER_CONFIG)}) AS verdict`)
    .bind(scope, factId, scope, factId)
    .first<{ verdict: number | null }>();
  return row?.verdict ?? null;
}

async function countFacts(scope: string, factId: string): Promise<number> {
  const row = await db.prepare(`SELECT count(*) AS n FROM facts WHERE scope_id = ? AND id = ?`).bind(scope, factId).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
});

describe("the SQL door refuses what the judge refuses, on schema.sql alone", () => {
  it("refuses a fact with no evidence, though the rule holds on nothing", async () => {
    const scope = id();
    await seedFact(scope, "f1", "free");
    expect(await evidenceVerdict(scope, "f1", lenient)).toBeNull();
    await seedEvidence(scope, "f1", "ev", "r1");
    expect(await evidenceVerdict(scope, "f1", lenient)).toBe(1);
  });

  it("refuses a kind the policy does not name, even with evidence", async () => {
    const scope = id();
    await seedFact(scope, "f2", "made_up");
    await seedEvidence(scope, "f2", "ev", "r2");
    expect(await evidenceVerdict(scope, "f2", lenient)).toBeNull();
  });
});

describe("the dependency gate and the dependency read see only their own scope", () => {
  it("the gate counts this scope's edges and facts, not another scope's", async () => {
    const mine = id();
    const theirs = id();
    await seedFact(theirs, "y", "free");
    await seedFact(theirs, "z", "free");
    await seedEdge(theirs, "y", "z");
    await seedFact(mine, "y", "free");
    const plan = planEntry(db, DEFAULT_LEDGER_CONFIG, lenient, mine, entryOf({ factId: "e1", kind: "free", dependsOn: ["y"] }), T, (reason) => new Error(reason));
    const gate = plan.guards[0]!;
    const row = await db.prepare(`SELECT (${gate.holdsSql}) AS ok`).bind(...gate.params).first<{ ok: number | null }>();
    expect(row?.ok).toBe(1);
  });

  it("admits a dependency that is live here, though another scope has edges from it", async () => {
    const mine = id();
    const theirs = id();
    await seedFact(theirs, "y2", "free");
    await seedFact(theirs, "z2", "free");
    await seedEdge(theirs, "y2", "z2");
    await seedFact(mine, "y2", "free");
    await seedEvidence(mine, "y2", "ev", "ry");
    const store = new D1LedgerStore(db, DEFAULT_LEDGER_CONFIG, lenient);
    expect(await store.admit(mine, entryOf({ factId: "e2", kind: "free", dependsOn: ["y2"], evidence: [ev("ev", "re")] }), T)).toEqual({
      admitted: true,
      factId: "e2",
    });
  });

  it("refuses a dependency that is missing here, though another scope has it, before the evidence is looked at", async () => {
    const mine = id();
    const theirs = id();
    await seedFact(theirs, "w", "free");
    const store = new D1LedgerStore(db, DEFAULT_LEDGER_CONFIG, lenient);
    expect(await store.admit(mine, entryOf({ factId: "e3", kind: "free", dependsOn: ["w"], evidence: [] }), T)).toEqual({
      admitted: false,
      reason: "dependency_not_live",
    });
  });
});

describe("the host's extension joins the core's batch and refuses with its own reason", () => {
  it("returns the extension's reason as the verdict, and writes nothing", async () => {
    const scope = id();
    const store = new D1LedgerStore(db, DEFAULT_LEDGER_CONFIG, lenient);
    const refusing: HostExtension = { guards: [{ holdsSql: "SELECT CASE WHEN 1 = 0 THEN 1 END", params: [], error: () => new Error("host"), reason: "stock_used" }] };
    expect(await store.admit(scope, entryOf({ factId: "x1", kind: "free", evidence: [ev("ev", "rx")] }), T, refusing)).toEqual({
      admitted: false,
      reason: "stock_used",
    });
    expect(await countFacts(scope, "x1")).toBe(0);
  });

  it("admits when the extension's guard holds", async () => {
    const scope = id();
    const store = new D1LedgerStore(db, DEFAULT_LEDGER_CONFIG, lenient);
    const holding: HostExtension = { guards: [{ holdsSql: "SELECT 1", params: [], error: () => new Error("host"), reason: "stock_used" }] };
    expect(await store.admit(scope, entryOf({ factId: "x2", kind: "free", evidence: [ev("ev", "ry")] }), T, holding)).toEqual({
      admitted: true,
      factId: "x2",
    });
    expect(await countFacts(scope, "x2")).toBe(1);
  });
});

describe("two concurrent admits settle on the UNIQUE keys and give a verdict", () => {
  it("one operation key: one is admitted, the other is a duplicate", async () => {
    const scope = id();
    const store = new D1LedgerStore(db, DEFAULT_LEDGER_CONFIG, lenient);
    const key = id();
    const verdicts = await Promise.all([
      store.admit(scope, entryOf({ factId: id(), kind: "free", operationKey: key, evidence: [ev("ev", "a")] }), T),
      store.admit(scope, entryOf({ factId: id(), kind: "free", operationKey: key, evidence: [ev("ev", "b")] }), T),
    ]);
    expect(verdicts.map((verdict) => (verdict.admitted ? "admitted" : verdict.reason)).sort()).toEqual(["admitted", "duplicate"]);
  });

  it("one fact id under two keys: one is admitted, the other is a duplicate", async () => {
    const scope = id();
    const store = new D1LedgerStore(db, DEFAULT_LEDGER_CONFIG, lenient);
    const factId = id();
    const verdicts = await Promise.all([
      store.admit(scope, entryOf({ factId, kind: "free", evidence: [ev("ev", "a")] }), T),
      store.admit(scope, entryOf({ factId, kind: "free", evidence: [ev("ev", "b")] }), T),
    ]);
    expect(verdicts.map((verdict) => (verdict.admitted ? "admitted" : verdict.reason)).sort()).toEqual(["admitted", "duplicate"]);
  });
});

describe("schema.sql keeps its four tables append-only, also against INSERT OR REPLACE", () => {
  it("refuses an update or a delete of each table", async () => {
    const scope = id();
    await seedFact(scope, "t1", "free");
    await seedFact(scope, "t0", "free");
    await seedEdge(scope, "t1", "t0");
    await seedClosure(scope, "t0", "t1", "superseded");
    await expect(db.prepare(`DELETE FROM facts WHERE scope_id = ?`).bind(scope).run()).rejects.toThrow(/append-only/);
    await expect(db.prepare(`DELETE FROM fact_dependencies WHERE scope_id = ?`).bind(scope).run()).rejects.toThrow(/append-only/);
    await expect(db.prepare(`UPDATE fact_closures SET reason = 'cancelled' WHERE scope_id = ?`).bind(scope).run()).rejects.toThrow(/append-only/);
  });

  it("refuses an INSERT OR REPLACE that would overwrite a fact, evidence, a dependency or a closure", async () => {
    const scope = id();
    const operationKey = await seedFact(scope, "r1", "free");
    await seedFact(scope, "r0", "free");
    await seedEvidence(scope, "r1", "ev", "x");
    await seedEdge(scope, "r1", "r0");
    await seedClosure(scope, "r0", "r1", "cancelled");

    await expect(
      db
        .prepare(`INSERT OR REPLACE INTO facts (scope_id, id, kind, operation_key, actor_id, valid_from_ms, recorded_at_ms, body_json) VALUES (?, 'r1', 'FORGED', ?, 'u', ?, ?, '{}')`)
        .bind(scope, id(), T, T)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db
        .prepare(`INSERT OR REPLACE INTO facts (scope_id, id, kind, operation_key, actor_id, valid_from_ms, recorded_at_ms, body_json) VALUES (?, 'r9', 'FORGED', ?, 'u', ?, ?, '{}')`)
        .bind(scope, operationKey, T, T)
        .run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.prepare(`INSERT OR REPLACE INTO fact_evidence (scope_id, fact_id, kind, ref_id, content_sha256) VALUES (?, 'r1', 'ev', 'x', 'FORGED')`).bind(scope).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.prepare(`INSERT OR REPLACE INTO fact_dependencies (scope_id, fact_id, depends_on_fact_id) VALUES (?, 'r1', 'r0')`).bind(scope).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db
        .prepare(`INSERT OR REPLACE INTO fact_closures (scope_id, fact_id, closed_by_fact_id, reason, closed_at_ms) VALUES (?, 'r0', 'r9', 'superseded', ?)`)
        .bind(scope, T)
        .run(),
    ).rejects.toThrow(/append-only/);

    expect(await db.prepare(`SELECT kind FROM facts WHERE scope_id = ? AND id = 'r1'`).bind(scope).first<{ kind: string }>()).toEqual({ kind: "free" });
    expect(await db.prepare(`SELECT content_sha256 AS sha FROM fact_evidence WHERE scope_id = ? AND fact_id = 'r1'`).bind(scope).first<{ sha: string | null }>()).toEqual({ sha: null });
    expect(await db.prepare(`SELECT reason FROM fact_closures WHERE scope_id = ? AND fact_id = 'r0'`).bind(scope).first<{ reason: string }>()).toEqual({ reason: "cancelled" });
  });
});
