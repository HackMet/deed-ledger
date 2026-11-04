/**
 * Portability: two industries the core has never heard of (a clinic lab and a freight flow) run on the memory store,
 * from the same table of cases that a later step runs on D1 too. The core's files are not edited for either one.
 */
import { describe, expect, it } from "vitest";
import { type Entry, type EntryJudge, MalformedEntry, MemoryLedgerStore, type Verdict, entryFile, recheck } from "../src/deed-core";
import { cases, entry, ev } from "./helpers/deed-core-cases";
import { clinicPolicy, policies, type PolicyName } from "./helpers/deed-core-policies";

const reasonOf = (verdict: Verdict): string => (verdict.admitted ? "admitted" : verdict.reason);

const states = [
  "admitted",
  "duplicate",
  "unknown_kind",
  "evidence_incomplete",
  "dependency_not_live",
  "closes_not_live",
] as const;

interface PortableInput {
  readonly policy: PolicyName;
  readonly entries: readonly Entry[];
}

/** The judge a third party re-runs from the file alone: the entries, in order, on a fresh memory store. */
const portableJudge: EntryJudge<PortableInput, (typeof states)[number]> = {
  domain: "portable-cases",
  states,
  parse: (raw) => {
    const input = raw as Partial<PortableInput> | null;
    if (typeof input !== "object" || input === null || !(input.policy !== undefined && input.policy in policies) || !Array.isArray(input.entries)) {
      throw new MalformedEntry("input must name a policy and list its entries");
    }
    return input as PortableInput;
  },
  rows: ({ policy, entries }) => {
    const store = new MemoryLedgerStore(policies[policy]);
    // Rows are numbered, not keyed by fact id: a case may reuse a fact id on purpose, and a row key must be unique.
    return entries.map((item, index) => ({ rowKey: `${index}:${item.factId}`, state: reasonOf(store.admitNow("file", item)) as (typeof states)[number] }));
  },
};

describe("the core on a memory store: two industries, one table of cases", () => {
  it.each(cases)("$name", async ({ policy, steps }) => {
    const store = new MemoryLedgerStore(policies[policy]);
    for (const step of steps) {
      const verdict = await store.admit("tenant-a", step.entry);
      expect(reasonOf(verdict), step.entry.factId).toBe(step.expect);
    }
  });

  it("keeps scopes apart: the same key and fact id are free in another scope", async () => {
    const store = new MemoryLedgerStore(clinicPolicy);
    const sample = entry({ factId: "s1", kind: "sample_taken", operationKey: "op-1", evidence: [ev("clinician", "c1")] });
    expect(reasonOf(await store.admit("site-a", sample))).toBe("admitted");
    expect(reasonOf(await store.admit("site-b", sample))).toBe("admitted");
    expect(reasonOf(await store.admit("site-a", { ...sample, factId: "s2" }))).toBe("duplicate");
  });

  it.each(cases)("re-checks from the file alone: $name", ({ policy, steps }) => {
    const input: PortableInput = { policy, entries: steps.map((step) => step.entry) };
    const file = JSON.parse(JSON.stringify(entryFile(portableJudge, input))) as unknown;
    const result = recheck(portableJudge, file);
    expect(result).toEqual({ ok: true, pairs: steps.length, same: steps.length, differ: [] });
  });

  it("reports a verdict that was changed in the file", () => {
    const sample = cases[0]!.steps[0]!.entry;
    const file = entryFile(portableJudge, { policy: "clinic", entries: [sample] });
    const rowKey = `0:${sample.factId}`;
    const tampered = { ...file, verdicts: [{ rowKey, state: "duplicate" }] };
    expect(recheck(portableJudge, tampered)).toEqual({
      ok: true,
      pairs: 1,
      same: 0,
      differ: [{ rowKey, stored: "duplicate", recomputed: "admitted" }],
    });
  });
});
