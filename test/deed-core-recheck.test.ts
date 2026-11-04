import { describe, expect, it } from "vitest";
import { ENTRY_FILE_SCHEMA, type EntryJudge, MalformedEntry, entryFile, recheck } from "../src/deed-core";

type State = "even" | "odd";

/** A toy judge: each number in the input is a row, and the verdict is its parity. */
const judge: EntryJudge<number[], State> = {
  domain: "parity",
  states: ["even", "odd"],
  parse: (raw) => {
    if (!Array.isArray(raw) || !raw.every((n) => typeof n === "number")) throw new MalformedEntry("input must be numbers");
    return raw as number[];
  },
  rows: (input) => input.map((n) => ({ rowKey: String(n), state: n % 2 === 0 ? "even" : "odd" })),
};

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

describe("recheck", () => {
  it("writes the file with the schema, the domain and one verdict per row", () => {
    expect(entryFile(judge, [1, 2])).toEqual({
      schema: ENTRY_FILE_SCHEMA,
      domain: "parity",
      input: [1, 2],
      verdicts: [
        { rowKey: "1", state: "odd" },
        { rowKey: "2", state: "even" },
      ],
    });
  });

  it("re-runs the judge on the file alone and agrees with what was stored", () => {
    const file = roundTrip(entryFile(judge, [1, 2, 3]));
    expect(recheck(judge, file)).toEqual({ ok: true, pairs: 3, same: 3, differ: [] });
  });

  it("reports every row whose stored verdict differs from the recomputed one", () => {
    const file = roundTrip(entryFile(judge, [1, 2])) as { verdicts: { rowKey: string; state: State | null }[] };
    file.verdicts[1]!.state = "odd";
    expect(recheck(judge, file)).toEqual({
      ok: true,
      pairs: 2,
      same: 1,
      differ: [{ rowKey: "2", stored: "odd", recomputed: "even" }],
    });
  });

  it("a stored null is a real answer, not a missing row", () => {
    const file = { schema: ENTRY_FILE_SCHEMA, domain: "parity", input: [1], verdicts: [{ rowKey: "1", state: null }] };
    expect(recheck(judge, file)).toEqual({
      ok: true,
      pairs: 1,
      same: 0,
      differ: [{ rowKey: "1", stored: null, recomputed: "odd" }],
    });
  });

  it("a row the file lacks, or adds, is reported as missing", () => {
    const file = { schema: ENTRY_FILE_SCHEMA, domain: "parity", input: [1], verdicts: [{ rowKey: "9", state: "odd" }] };
    expect(recheck(judge, file)).toEqual({
      ok: true,
      pairs: 2,
      same: 0,
      differ: [
        { rowKey: "1", stored: "missing", recomputed: "odd" },
        { rowKey: "9", stored: "odd", recomputed: "missing" },
      ],
    });
  });

  it.each([
    ["a non-object", "nope", "entry must be an object"],
    ["another schema", { schema: 2, domain: "parity", input: [], verdicts: [] }, "schema must be 1"],
    ["another domain", { schema: 1, domain: "other", input: [], verdicts: [] }, "domain must be \"parity\""],
    ["verdicts that are not a list", { schema: 1, domain: "parity", input: [], verdicts: {} }, "verdicts must be an array"],
    ["a repeated rowKey", { schema: 1, domain: "parity", input: [], verdicts: [{ rowKey: "1", state: null }, { rowKey: "1", state: null }] }, "repeat a rowKey"],
    ["a state the domain does not name", { schema: 1, domain: "parity", input: [], verdicts: [{ rowKey: "1", state: "maybe" }] }, "must be one of even, odd"],
    ["an input the judge refuses", { schema: 1, domain: "parity", input: ["x"], verdicts: [] }, "input must be numbers"],
  ])("refuses %s as a malformed entry", (_label, file, message) => {
    const result = recheck(judge, file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});
