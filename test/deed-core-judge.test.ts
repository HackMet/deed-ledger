import { describe, expect, it } from "vitest";
import { type Entry, type JudgeState, type Policy, evidenceHolds, judge } from "../src/deed-core";

const ref = (kind: string, n: number) => Array.from({ length: n }, (_, i) => ({ kind, refId: `${kind}-${i}`, contentSha256: null }));

const entryOf = (init: Partial<Entry>): Entry => ({
  factId: "f1",
  kind: "k",
  operationKey: "op-1",
  actor: "a",
  validFromMs: 0,
  body: null,
  evidence: [],
  dependsOn: [],
  closes: null,
  ...init,
});

const clear: JudgeState = { keyUsed: false, deadDependencies: [], closes: null };

const policy: Policy = { kinds: { k: { evidence: [{ require: [{ kind: "ref", min: 1, max: 2 }] }] } } };

describe("judge", () => {
  it("admits evidence inside the bounds of the rule", () => {
    expect(judge(entryOf({ evidence: ref("ref", 1) }), clear, policy)).toEqual({ admitted: true, factId: "f1" });
    expect(judge(entryOf({ evidence: ref("ref", 2) }), clear, policy)).toEqual({ admitted: true, factId: "f1" });
  });

  it("refuses evidence above the max: the max is not ignored", () => {
    expect(judge(entryOf({ evidence: ref("ref", 3) }), clear, policy)).toEqual({ admitted: false, reason: "evidence_incomplete" });
  });

  it("refuses evidence below the min", () => {
    const other = [{ kind: "other", refId: "o", contentSha256: null }];
    expect(judge(entryOf({ evidence: other }), clear, policy)).toEqual({ admitted: false, reason: "evidence_incomplete" });
  });

  it("refuses a kind the policy does not name, before it looks at evidence", () => {
    expect(judge(entryOf({ kind: "zz", evidence: ref("ref", 1) }), clear, policy)).toEqual({ admitted: false, reason: "unknown_kind" });
  });

  it("refuses zero evidence even when the policy's rule would hold on nothing", () => {
    const empty: Policy = { kinds: { k: { evidence: [{ require: [] }] } } };
    expect(judge(entryOf({ evidence: [] }), clear, empty)).toEqual({ admitted: false, reason: "evidence_incomplete" });
    expect(judge(entryOf({ evidence: [] }), clear, { kinds: { k: { evidence: [] } } })).toEqual({ admitted: false, reason: "evidence_incomplete" });
  });

  it("the first rule whose when holds decides, and it must then be satisfied", () => {
    const rules: Policy = {
      kinds: { k: { evidence: [{ when: { kind: "a", min: 1 }, require: [{ kind: "b", min: 1 }] }, { require: [{ kind: "a", min: 1 }] }] } },
    };
    const a = ref("a", 1);
    const b = ref("b", 1);
    expect(evidenceHolds([...a], rules.kinds.k!.evidence)).toBe(false);
    expect(evidenceHolds([...a, ...b], rules.kinds.k!.evidence)).toBe(true);
    expect(evidenceHolds(b, rules.kinds.k!.evidence)).toBe(false);
  });

  it("refuses when no rule holds", () => {
    const onlyWhen: Policy = { kinds: { k: { evidence: [{ when: { kind: "a", min: 2 }, require: [] }] } } };
    expect(evidenceHolds(ref("a", 1), onlyWhen.kinds.k!.evidence)).toBe(false);
  });

  it("checks duplicate first, then the dependencies, then the closure, then the evidence", () => {
    const bad = entryOf({ kind: "zz" });
    expect(judge(bad, { ...clear, keyUsed: true }, policy)).toEqual({ admitted: false, reason: "duplicate" });
    expect(judge(entryOf({ evidence: ref("ref", 1) }), { ...clear, deadDependencies: ["x"] }, policy)).toEqual({
      admitted: false,
      reason: "dependency_not_live",
    });
    expect(judge(entryOf({ evidence: ref("ref", 1) }), { ...clear, closes: "closed" }, policy)).toEqual({
      admitted: false,
      reason: "closes_not_live",
    });
    expect(judge(entryOf({ evidence: ref("ref", 1) }), { ...clear, closes: "missing" }, policy)).toEqual({
      admitted: false,
      reason: "closes_not_live",
    });
    expect(judge(entryOf({ evidence: ref("ref", 1) }), { ...clear, closes: "live" }, policy)).toEqual({ admitted: true, factId: "f1" });
  });

  it("refuses a dead dependency before a closure that is not live, and before evidence that is missing", () => {
    const dead = { ...clear, deadDependencies: ["x"] };
    expect(judge(entryOf({ evidence: ref("ref", 1) }), { ...dead, closes: "closed" }, policy)).toEqual({
      admitted: false,
      reason: "dependency_not_live",
    });
    expect(judge(entryOf({ evidence: [] }), dead, policy)).toEqual({ admitted: false, reason: "dependency_not_live" });
  });

  it("refuses a kind that only the prototype chain names, whatever the policy holds", () => {
    for (const kind of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(judge(entryOf({ kind, evidence: ref("ref", 1) }), clear, policy), kind).toEqual({ admitted: false, reason: "unknown_kind" });
    }
  });

  it("counts one witness once: a repeated (kind, refId) is evidence_incomplete, not two witnesses", () => {
    const [witness] = ref("ref", 1);
    expect(judge(entryOf({ evidence: [witness!, witness!] }), clear, policy)).toEqual({ admitted: false, reason: "evidence_incomplete" });
    expect(evidenceHolds([witness!, witness!], policy.kinds.k!.evidence)).toBe(false);
  });

  it("refuses a dependency listed twice, and an entry that depends on itself", () => {
    expect(judge(entryOf({ dependsOn: ["x", "x"], evidence: ref("ref", 1) }), { ...clear, deadDependencies: [] }, policy)).toEqual({
      admitted: false,
      reason: "dependency_not_live",
    });
    expect(judge(entryOf({ dependsOn: ["f1"], evidence: ref("ref", 1) }), { ...clear, deadDependencies: [] }, policy)).toEqual({
      admitted: false,
      reason: "dependency_not_live",
    });
  });
});
