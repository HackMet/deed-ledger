import { describe, expect, it } from "vitest";
import { type Entry, type Policy, type Verdict, MemoryLedgerStore } from "../src/deed-core";

const policy: Policy = { kinds: { k: { evidence: [{ require: [{ kind: "ref", min: 1 }] }] } } };

const entryOf = (init: Pick<Entry, "factId" | "operationKey"> & Partial<Entry>): Entry => ({
  kind: "k",
  actor: "a",
  validFromMs: 0,
  body: null,
  evidence: [{ kind: "ref", refId: "r", contentSha256: null }],
  dependsOn: [],
  closes: null,
  ...init,
});

const reasonOf = (verdict: Verdict) => (verdict.admitted ? "admitted" : verdict.reason);

describe("MemoryLedgerStore", () => {
  it("refuses an entry whose sameBatch dependency was never written, and leaves nothing behind", async () => {
    const store = new MemoryLedgerStore(policy);
    const refused = entryOf({ factId: "f2", operationKey: "op-2", dependsOn: ["ghost"], sameBatch: ["ghost"] });
    expect(reasonOf(await store.admit("t", refused))).toBe("dependency_not_live");
    // Nothing stayed written: the same operation key is still free.
    expect(reasonOf(await store.admit("t", { ...refused, dependsOn: [], sameBatch: undefined }))).toBe("admitted");
  });

  it("admits an entry whose sameBatch dependency was written first", async () => {
    const store = new MemoryLedgerStore(policy);
    await store.admit("t", entryOf({ factId: "f1", operationKey: "op-1" }));
    expect(reasonOf(await store.admit("t", entryOf({ factId: "f2", operationKey: "op-2", dependsOn: ["f1"], sameBatch: ["f1"] })))).toBe(
      "admitted",
    );
  });

  it("a fact that cancels its own dependency is admitted, as D1 admits it: the dependency is judged before the write", async () => {
    const store = new MemoryLedgerStore(policy);
    await store.admit("t", entryOf({ factId: "f1", operationKey: "op-1" }));
    const cancel = entryOf({ factId: "f2", operationKey: "op-2", dependsOn: ["f1"], closes: { factId: "f1", reason: "cancelled" } });
    expect(reasonOf(await store.admit("t", cancel))).toBe("admitted");
    expect(reasonOf(await store.admit("t", entryOf({ factId: "f3", operationKey: "op-3", dependsOn: ["f1"] })))).toBe("dependency_not_live");
  });

  it("a fact that supersedes its own dependency keeps itself live", async () => {
    const store = new MemoryLedgerStore(policy);
    await store.admit("t", entryOf({ factId: "f1", operationKey: "op-1" }));
    const supersede = entryOf({ factId: "f2", operationKey: "op-2", dependsOn: ["f1"], closes: { factId: "f1", reason: "superseded" } });
    expect(reasonOf(await store.admit("t", supersede))).toBe("admitted");
    expect(reasonOf(await store.admit("t", entryOf({ factId: "f3", operationKey: "op-3", dependsOn: ["f1"] })))).toBe("dependency_not_live");
  });

  it("refuses a fact id that is already written, under a new operation key", async () => {
    const store = new MemoryLedgerStore(policy);
    await store.admit("t", entryOf({ factId: "f1", operationKey: "op-1" }));
    expect(reasonOf(await store.admit("t", entryOf({ factId: "f1", operationKey: "op-9" })))).toBe("duplicate");
  });

  it("the synchronous form gives the same verdicts as the port", () => {
    const store = new MemoryLedgerStore(policy);
    expect(store.admitNow("t", entryOf({ factId: "f1", operationKey: "op-1" }))).toEqual({ admitted: true, factId: "f1" });
    expect(store.admitNow("t", entryOf({ factId: "f2", operationKey: "op-1" }))).toEqual({ admitted: false, reason: "duplicate" });
  });
});
