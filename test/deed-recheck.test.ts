import { describe, expect, it } from "vitest";
import type { LibroInput } from "../src/domain/deed-libro";
import { entryOf, recheckEntry } from "../src/domain/deed-recheck";

/** A small order: a version and its confirm, a delivered claim that pairs, a claim with no delivery yet, and a total. */
const input: LibroInput = {
  orderId: "order-1",
  facts: [
    { id: "fact-v1", kind: "order_version", operationKey: "op-v1", recordedAtMs: 1000, version: 1, status: null, resumeState: null, live: true, witness: null },
    { id: "fact-c1", kind: "order_confirm", operationKey: "op-c1", recordedAtMs: 3000, version: 1, status: null, resumeState: "confirmado", live: true, witness: null },
  ],
  lines: [{ version: 1, counted: true, unitPrice: 2500, quantity: "2" }],
  replies: [
    {
      id: "msg-1",
      atMs: 2000,
      status: "sent",
      providerStatus: "delivered",
      providerStatusAtS: 2,
      claims: [{ anyOf: [{ type: "order_state", orderId: "order-1", version: 1, state: "por_confirmar" }] }],
    },
    {
      id: "msg-2",
      atMs: 4000,
      status: "sent",
      providerStatus: null,
      providerStatusAtS: null,
      claims: [{ anyOf: [{ type: "order_total", orderId: "order-1", version: 1, total: 5000 }] }],
    },
  ],
  refusals: [],
};

/** The entry as a file holds it: the JSON round trip the command and the route both go through. */
const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("entryOf and recheckEntry: the judge re-runs from the entry alone", () => {
  it("gives one verdict per row, and re-running the judge on the entry reproduces every one", () => {
    const entry = entryOf(input);
    expect(entry.schema).toBe(1);
    expect(entry.verdicts.map((v) => [v.rowKey, v.state])).toEqual([
      ["r1", "emparejado"],
      ["r2", "emparejado"],
      ["r3", null],
      ["r4", "en_duda"],
      ["r5", "emparejado"],
    ]);
    expect(recheckEntry(roundTrip(entry))).toEqual({ ok: true, pairs: 5, same: 5, differ: [] });
  });

  it("finds a stored verdict that no longer matches the input: one difference, named by its row", () => {
    const entry = entryOf(input);
    const tampered = { ...entry, verdicts: entry.verdicts.map((v) => (v.rowKey === "r4" ? { ...v, state: "emparejado" as const } : v)) };
    expect(recheckEntry(roundTrip(tampered))).toEqual({
      ok: true,
      pairs: 5,
      same: 4,
      differ: [{ rowKey: "r4", stored: "emparejado", recomputed: "en_duda" }],
    });
  });

  it("finds a changed input field that decides a pair: the delivery that was read as failed", () => {
    const entry = entryOf(input);
    const changed = { ...entry, input: { ...input, replies: [{ ...input.replies[0]!, providerStatus: "failed" as const }, input.replies[1]!] } };
    const result = recheckEntry(roundTrip(changed));
    expect(result).toEqual({ ok: true, pairs: 5, same: 4, differ: [{ rowKey: "r1", stored: "emparejado", recomputed: "sin_pareja" }] });
  });

  it("counts a verdict whose row is missing from the stored entry as a difference, not a pass", () => {
    const entry = entryOf(input);
    const shorter = { ...entry, verdicts: entry.verdicts.slice(0, 4) };
    expect(recheckEntry(roundTrip(shorter))).toEqual({
      ok: true,
      pairs: 5,
      same: 4,
      differ: [{ rowKey: "r5", stored: "missing", recomputed: "emparejado" }],
    });
  });

  it("treats a null verdict as an answer: a fact nothing witnessed stays null, and changing it to a state differs", () => {
    const entry = entryOf(input);
    const tampered = { ...entry, verdicts: entry.verdicts.map((v) => (v.rowKey === "r3" ? { ...v, state: "en_duda" as const } : v)) };
    expect(recheckEntry(roundTrip(tampered))).toMatchObject({ ok: true, differ: [{ rowKey: "r3", stored: "en_duda", recomputed: null }] });
  });
});

describe("recheckEntry: a malformed entry is an error, never a pass", () => {
  const good = roundTrip(entryOf(input)) as Record<string, unknown>;

  it.each([
    ["not an object", null],
    ["a string", "entry"],
    ["an unknown schema", { ...good, schema: 2 }],
    ["no schema", { ...good, schema: undefined }],
    ["no input", { schema: 1, verdicts: good.verdicts }],
    ["an input without its replies", { ...good, input: { ...(good.input as object), replies: undefined } }],
    ["a fact of an unknown kind", { ...good, input: { ...input, facts: [{ ...input.facts[0], kind: "order_magic" }] } }],
    ["a line with a fractional price", { ...good, input: { ...input, lines: [{ ...input.lines[0], unitPrice: 25.5 }] } }],
    ["a quantity that is not a decimal string", { ...good, input: { ...input, lines: [{ ...input.lines[0], quantity: 2 }] } }],
    ["a verdict with an unknown state", { ...good, verdicts: [{ rowKey: "r1", state: "verde" }] }],
    ["a verdict with no state field", { ...good, verdicts: [{ rowKey: "r1" }] }],
    ["two verdicts with one row key", { ...good, verdicts: [{ rowKey: "r1", state: null }, { rowKey: "r1", state: null }] }],
  ])("refuses %s", (_, entry) => {
    const result = recheckEntry(entry);
    expect(result.ok).toBe(false);
  });

  it("names the field that is wrong", () => {
    expect(recheckEntry({ ...good, schema: 2 })).toEqual({ ok: false, error: "malformed entry: schema must be 1 (unknown schema 2)" });
  });
});
