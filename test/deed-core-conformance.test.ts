/**
 * Conformance: one table of cases, three answers. The pure judge, the memory store and the D1 store must give the same
 * verdict for every step of every case. The D1 store runs on schema.sql alone, on a blank database: no migration.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type Closed, D1LedgerStore, DEFAULT_LEDGER_CONFIG, type Entry, type JudgeState, type LedgerView, MemoryLedgerStore, type Policy, type Verdict, deadForEntry, judge } from "../src/deed-core";
import schemaSql from "../src/deed-core/schema.sql?raw";
import { cases } from "./helpers/deed-core-cases";
import { policies } from "./helpers/deed-core-policies";

const NOW = Date.UTC(2026, 10, 4);

/** schema.sql as statements: each top-level statement starts with CREATE; D1's exec() refuses the file's comments. */
const schemaStatements = schemaSql
  .replace(/--.*$/gm, "")
  .split(/;\n(?=CREATE\b)/)
  .map((statement) => statement.trim().replace(/;$/, ""))
  .filter((statement) => statement.length > 0);

const reasonOf = (verdict: Verdict): string => (verdict.admitted ? "admitted" : verdict.reason);

/**
 * The pure judge, run over the entries in order. Its reads are kept here, apart from the stores, so a store that
 * reads wrongly disagrees with it.
 */
function pureVerdicts(policy: Policy, entries: readonly Entry[]): string[] {
  const keys = new Set<string>();
  const dependsOn = new Map<string, readonly string[]>();
  const closures = new Map<string, Closed>();
  const view: LedgerView = {
    has: (factId) => dependsOn.has(factId),
    dependsOn: (factId) => dependsOn.get(factId) ?? [],
    closure: (factId) => closures.get(factId) ?? null,
  };
  return entries.map((entry) => {
    const target = entry.closes?.factId;
    const state: JudgeState = {
      keyUsed: keys.has(entry.operationKey) || dependsOn.has(entry.factId),
      deadDependencies: deadForEntry(entry, view),
      closes: target === undefined ? null : closures.has(target) ? "closed" : dependsOn.has(target) ? "live" : "missing",
    };
    const verdict = judge(entry, state, policy);
    if (verdict.admitted) {
      keys.add(entry.operationKey);
      dependsOn.set(entry.factId, entry.dependsOn);
      if (entry.closes !== null) closures.set(entry.closes.factId, { reason: entry.closes.reason, closedBy: entry.factId });
    }
    return reasonOf(verdict);
  });
}

describe("the core's conformance: the judge, the memory store and the D1 store agree on every case", () => {
  beforeAll(async () => {
    await env.MIGRATION_TEST_DB.batch(schemaStatements.map((statement) => env.MIGRATION_TEST_DB.prepare(statement)));
  });

  it.each(cases.map((item, index) => ({ ...item, index })))("$name", async ({ policy, steps, index }) => {
    const rules = policies[policy];
    // Each case is a fresh ledger: its own scope, so the cases share one blank database without seeing each other.
    const scope = `case-${index}`;
    const memory = new MemoryLedgerStore(rules);
    const d1 = new D1LedgerStore(env.MIGRATION_TEST_DB, DEFAULT_LEDGER_CONFIG, rules);
    const pure = pureVerdicts(rules, steps.map((step) => step.entry));
    for (const [n, step] of steps.entries()) {
      const memoryReason = reasonOf(await memory.admit(scope, step.entry));
      const d1Reason = reasonOf(await d1.admit(scope, step.entry, NOW));
      expect({ step: step.entry.factId, pure: pure[n], memory: memoryReason, d1: d1Reason }).toEqual({
        step: step.entry.factId,
        pure: step.expect,
        memory: step.expect,
        d1: step.expect,
      });
    }
  });
});
