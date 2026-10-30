import { describe, expect, it } from "vitest";
import type { EngineOutcome } from "../src/domain/contract/outcomes";
import { type FactPrecheckReads, precheckFact } from "../src/domain/fact-precheck";

const NOW = 1_793_196_000_000;
const CLEAR: FactPrecheckReads = { firstOutcome: null, draft: null, deadDependencies: [] };
const pending = (revision: number) => ({ revision, state: "pending", expiresAtMs: NOW + 3_600_000 });
const subject = { draft: { id: "draft-1", revision: 2 }, dependsOn: [] as readonly string[] };

describe("precheckFact: the read that answers instead of failing the batch", () => {
  it("lets a fact through when the records say nothing against it", () => {
    expect(precheckFact(subject, { ...CLEAR, draft: pending(2) }, NOW)).toBeNull();
  });

  it("a tap on an older revision is rejected as stale_version, not an error", () => {
    const stopped = precheckFact(subject, { ...CLEAR, draft: pending(3) }, NOW);
    expect(stopped?.outcome).toEqual({ type: "rejected", reason: "stale_version", order: null });
  });

  it("an operation key already used is a duplicate carrying the first outcome", () => {
    const first: EngineOutcome = { type: "order_confirmed", order: null as never };
    const stopped = precheckFact(subject, { ...CLEAR, draft: pending(2), firstOutcome: first }, NOW);
    expect(stopped?.outcome).toEqual({ type: "duplicate", first });
  });

  it("a used key wins over a stale revision: the work is already done", () => {
    const first: EngineOutcome = { type: "nothing" };
    const stopped = precheckFact(subject, { firstOutcome: first, draft: pending(99), deadDependencies: ["x"] }, NOW);
    expect(stopped?.outcome.type).toBe("duplicate");
  });

  it("a cancelled ancestor is rejected and names the dead dependencies", () => {
    const stopped = precheckFact(
      { draft: null, dependsOn: ["a", "b"] },
      { ...CLEAR, deadDependencies: ["a"] },
      NOW,
    );
    expect(stopped?.outcome).toEqual({ type: "rejected", reason: "invalid_state", order: null });
    expect(stopped?.deadDependencies).toEqual(["a"]);
  });

  it("a draft that is gone, committed or expired is invalid_state, not stale_version", () => {
    expect(precheckFact(subject, { ...CLEAR, draft: null }, NOW)?.outcome).toMatchObject({ reason: "invalid_state" });
    expect(precheckFact(subject, { ...CLEAR, draft: { ...pending(2), state: "committed" } }, NOW)?.outcome).toMatchObject({
      reason: "invalid_state",
    });
    expect(precheckFact(subject, { ...CLEAR, draft: { ...pending(2), expiresAtMs: NOW } }, NOW)?.outcome).toMatchObject({
      reason: "invalid_state",
    });
  });

  it("a fact with no draft and no dependencies is never stopped", () => {
    expect(precheckFact({ draft: null, dependsOn: [] }, CLEAR, NOW)).toBeNull();
  });
});
