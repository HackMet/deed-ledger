import { describe, expect, it } from "vitest";
import { type LedgerView, ancestorsOf, deadAncestors } from "../src/deed-core";

/** A view over plain data: `facts` maps each fact to what it depends on; `closures` maps a closed fact to its closer. */
function viewOf(facts: Record<string, string[]>, closures: Record<string, { reason: "cancelled" | "superseded"; closedBy: string }> = {}): LedgerView {
  return {
    has: (id) => id in facts,
    dependsOn: (id) => facts[id] ?? [],
    closure: (id) => closures[id] ?? null,
  };
}

describe("liveness", () => {
  it("collects every ancestor, transitively, with the ids themselves", () => {
    const view = viewOf({ a: [], b: ["a"], c: ["b"] });
    expect([...ancestorsOf(["c"], view)].sort()).toEqual(["a", "b", "c"]);
  });

  it("finds nothing dead when every ancestor is live", () => {
    expect(deadAncestors(["c"], viewOf({ a: [], b: ["a"], c: ["b"] }))).toEqual([]);
  });

  it("reports a missing dependency", () => {
    expect(deadAncestors(["ghost"], viewOf({ a: [] }))).toEqual(["ghost"]);
  });

  it("a cancelled ancestor kills every descendant that rests on it", () => {
    const view = viewOf({ a: [], b: ["a"], c: ["b"] }, { a: { reason: "cancelled", closedBy: "x" } });
    expect(deadAncestors(["c"], view)).toEqual(["a"]);
  });

  it("a supersede by an ancestor does not kill", () => {
    // v2 depends on v1 and supersedes it; a descendant resting on both stays live.
    const view = viewOf({ v1: [], v2: ["v1"] }, { v1: { reason: "superseded", closedBy: "v2" } });
    expect(deadAncestors(["v1", "v2"], view)).toEqual([]);
  });

  it("a supersede by a fact outside the ancestry kills: the descendant rests on the old version alone", () => {
    const view = viewOf({ v1: [], v2: ["v1"], d: ["v1"] }, { v1: { reason: "superseded", closedBy: "v2" } });
    expect(deadAncestors(["v1"], view)).toEqual(["v1"]);
    expect(deadAncestors(["d"], view)).toEqual(["v1"]);
  });
});
