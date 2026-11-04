import { describe, expect, it } from "vitest";
import { type Corroboration, pair } from "../src/deed-core";

/** Each witness answers with its own corroboration; the claim is just a number here. */
const answer = (answers: Corroboration[]) => pair(0, answers, (_claim: number, witness: Corroboration) => witness);

describe("pair", () => {
  it("pairs the claim when any witness matches, whatever the others say", () => {
    expect(answer(["conflict", "silent", "match"])).toBe("paired");
    expect(answer(["blocked", "match"])).toBe("paired");
  });

  it("a refusal blocks the claim before a contradiction leaves it unpaired", () => {
    expect(answer(["conflict", "blocked"])).toBe("blocked");
  });

  it("a contradiction alone leaves the claim unpaired", () => {
    expect(answer(["conflict"])).toBe("unpaired");
  });

  it("silence is in doubt, never unpaired", () => {
    expect(answer(["silent"])).toBe("in_doubt");
    expect(answer(["silent", "silent"])).toBe("in_doubt");
  });

  it("no witness at all is in doubt", () => {
    expect(answer([])).toBe("in_doubt");
  });
});
