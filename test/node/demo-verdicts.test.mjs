// The demo fails when the judge admits everything. Holds the real judge, on the inputs of a clean demo run, to the
// check the demo itself runs on each entry (demo/verdicts.mjs). The fixtures are synthetic: `./demo.sh` made them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build } from "esbuild";
import { EXPECTED_VERDICTS, checkVerdicts } from "../../demo/verdicts.mjs";

const bundle = await build({
  entryPoints: ["src/domain/deed-recheck.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const { entryOf } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const inputOf = (who) => JSON.parse(readFileSync(`test/fixtures/demo-entries/${who}.json`, "utf8")).input;
const orders = Object.keys(EXPECTED_VERDICTS);

for (const who of orders) {
  test(`the judge gives ${who} the verdicts the demo requires`, () => {
    checkVerdicts(who, entryOf(inputOf(who)).verdicts.map((verdict) => verdict.state));
  });
}

test("the demo's check refuses a judge that admits everything", () => {
  for (const who of orders) {
    const states = entryOf(inputOf(who)).verdicts.map(() => "emparejado");
    assert.throws(() => checkVerdicts(who, states), /the verdicts of/);
  }
});

test("the demo's label and the video script's strip say the same about what is real", () => {
  const label = /LABEL = `PERCEPTION: [^`]*— ([^`]+)`/.exec(readFileSync("demo/run.mjs", "utf8"))?.[1];
  assert.match(label ?? "", /demo templates/);
  const script = readFileSync("docs/demo-video-script.md", "utf8").replace(/\s+/g, " ");
  assert.ok(script.includes(label), label);
});
