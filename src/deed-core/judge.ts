/**
 * The pure judge: fixed arithmetic over the entry, the reads it needs and the policy. No I/O, no clock, no model.
 */
import type { Entry, EvidenceRule, JudgeState, Policy, Requirement, Verdict } from "./types";

const refuse = (reason: string): Verdict => ({ admitted: false, reason });

/** Whether the evidence satisfies the rules. Zero evidence is always refused (C2), whatever the policy says. */
export function evidenceHolds(evidence: Entry["evidence"], rules: readonly EvidenceRule[]): boolean {
  if (evidence.length === 0) return false;
  // One witness counted twice is one witness: a repeated (kind, refId) is refused, not counted again.
  if (new Set(evidence.map((item) => JSON.stringify([item.kind, item.refId]))).size !== evidence.length) return false;
  const holds = (req: Requirement): boolean => {
    const n = evidence.filter((item) => item.kind === req.kind).length;
    return (req.min === undefined || n >= req.min) && (req.max === undefined || n <= req.max);
  };
  for (const rule of rules) {
    if (rule.when === undefined || holds(rule.when)) return rule.require.every(holds);
  }
  return false;
}

/** A dependency listed twice, or an entry that depends on itself: no store can write either, so it is refused here. */
function repeatsOrSelf(entry: Entry): boolean {
  return new Set(entry.dependsOn).size !== entry.dependsOn.length || entry.dependsOn.includes(entry.factId);
}

/** The verdict for one entry. The order of the checks is the order of the refusals a caller sees. */
export function judge(entry: Entry, state: JudgeState, policy: Policy): Verdict {
  if (state.keyUsed) return refuse("duplicate");
  if (!Object.hasOwn(policy.kinds, entry.kind)) return refuse("unknown_kind");
  if (state.deadDependencies.length > 0 || repeatsOrSelf(entry)) return refuse("dependency_not_live");
  if (state.closes === "closed" || state.closes === "missing") return refuse("closes_not_live");
  if (!evidenceHolds(entry.evidence, policy.kinds[entry.kind]!.evidence)) return refuse("evidence_incomplete");
  return { admitted: true, factId: entry.factId };
}
