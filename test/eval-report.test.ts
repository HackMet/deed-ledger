/**
 * The eval runner's all.md (scripts/lib/eval-report.mjs). A non-string here made `writeFileSync`
 * throw, so all.md, results.json and the summary were never written (eval run, Nov 3).
 */
import { describe, expect, it } from "vitest";
import { allReport, retriedOnce } from "../scripts/lib/eval-report.mjs";

describe("the eval's all.md", () => {
  it("is one Markdown string: the header, then every transcript whole", () => {
    const report = allReport("2026-11-03T00:00:00.000Z", "planner", ["## E01 · Uno\n\nCliente: hola", "## E02 · Dos"]);
    expect(typeof report).toBe("string");
    expect(report).toBe("# Eval run 2026-11-03T00:00:00.000Z (path: planner)\n\n## E01 · Uno\n\nCliente: hola\n## E02 · Dos");
  });
});

describe("the eval runner's posts to the simulator", () => {
  it("retry once after a network failure (the request carries its own operation key or message ID)", async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
      return 303;
    };
    expect(await retriedOnce(flaky, 0)).toBe(303);
    expect(calls).toBe(2);
  });

  it("never retry anything else, and say why a network failure happened", async () => {
    await expect(retriedOnce(async () => { throw new Error("bad request"); }, 0)).rejects.toThrow("bad request");
    const down = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
    await expect(retriedOnce(down, 0)).rejects.toThrow("fetch failed (ECONNREFUSED)");
  });
});
