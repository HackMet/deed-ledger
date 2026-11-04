import { describe, expect, it } from "vitest";
import type { LibroInput } from "../src/domain/deed-libro";
import { entryOf, recheckEntry } from "../src/domain/deed-recheck";
import example from "../docs/deed-entry-example.json";

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

  it("finds a stored verdict whose row the input does not have: one difference, the row missing on the judge's side", () => {
    const entry = entryOf(input);
    const added = { ...entry, verdicts: [...entry.verdicts, { rowKey: "r9", state: "emparejado" as const }] };
    expect(recheckEntry(roundTrip(added))).toEqual({
      ok: true,
      pairs: 6,
      same: 5,
      differ: [{ rowKey: "r9", stored: "emparejado", recomputed: "missing" }],
    });
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
    ["a fact whose live flag is not true or false", { ...good, input: { ...input, facts: [{ ...input.facts[0], live: "yes" }] } }],
    ["a fact whose witness is of an unknown kind", { ...good, input: { ...input, facts: [{ ...input.facts[0], witness: { kind: "robot", refId: "u1" } }] } }],
    ["a fact whose witness has no refId", { ...good, input: { ...input, facts: [{ ...input.facts[0], witness: { kind: "member" } }] } }],
    ["a line whose counted flag is not true or false", { ...good, input: { ...input, lines: [{ ...input.lines[0], counted: "yes" }] } }],
    ["a reply whose provider status is not one of the five", { ...good, input: { ...input, replies: [{ ...input.replies[0], providerStatus: "seen" }, input.replies[1]] } }],
    [
      "an order_state claim in a state the book does not know",
      { ...good, input: { ...input, replies: [{ ...input.replies[0], claims: [{ anyOf: [{ type: "order_state", orderId: "order-1", version: 1, state: "verde" }] }] }, input.replies[1]] } },
    ],
    [
      "an order_state claim whose version is not an integer",
      { ...good, input: { ...input, replies: [{ ...input.replies[0], claims: [{ anyOf: [{ type: "order_state", orderId: "order-1", version: 1.5, state: "confirmado" }] }] }, input.replies[1]] } },
    ],
    [
      "an order_total claim whose total is a string",
      { ...good, input: { ...input, replies: [input.replies[0], { ...input.replies[1], claims: [{ anyOf: [{ type: "order_total", orderId: "order-1", version: 1, total: "5000" }] }] }] } },
    ],
    [
      "an order_total claim whose total is fractional",
      { ...good, input: { ...input, replies: [input.replies[0], { ...input.replies[1], claims: [{ anyOf: [{ type: "order_total", orderId: "order-1", version: 1, total: 50.5 }] }] }] } },
    ],
    ["a refusal whose time is not an integer", { ...good, input: { ...input, refusals: [{ id: "chk-1", atMs: "soon", reason: "invalid_state", decidingFactId: null, operationKey: null }] } }],
    ["a refusal whose reason is not text", { ...good, input: { ...input, refusals: [{ id: "chk-1", atMs: 5000, reason: 7, decidingFactId: null, operationKey: null }] } }],
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

describe("docs/deed-entry-example.json: a real entry of the demo's order A", () => {
  // Order A has paired rows (a witnessed fact) and en duda rows (replies with no delivery status yet).
  it("re-runs to the same eight verdicts, with no difference", () => {
    expect(recheckEntry(example)).toEqual({ ok: true, pairs: 8, same: 8, differ: [] });
    expect(example.verdicts.map((v) => v.state)).toContain("en_duda");
    expect(example.verdicts.map((v) => v.state)).toContain("emparejado");
  });

  it("finds one stored verdict that is changed: one difference", () => {
    const tampered = { ...example, verdicts: example.verdicts.map((v) => (v.rowKey === "r4" ? { ...v, state: "emparejado" } : v)) };
    expect(recheckEntry(tampered)).toEqual({ ok: true, pairs: 8, same: 7, differ: [{ rowKey: "r4", stored: "emparejado", recomputed: "en_duda" }] });
  });

  it("finds one input field that decides a pair changed: the first reply read as delivered", () => {
    const tampered = { ...example, input: { ...example.input, replies: [{ ...example.input.replies[0], providerStatus: "delivered" }, ...example.input.replies.slice(1)] } };
    const result = recheckEntry(tampered);
    expect(result).toMatchObject({ ok: true, pairs: 8, same: 7 });
    expect(result.ok && result.differ).toEqual([expect.objectContaining({ stored: "en_duda", recomputed: "emparejado" })]);
  });
});
