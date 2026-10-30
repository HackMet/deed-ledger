// Lane C runner: executes E6 + E8 scenarios, writes spikes/results/e6.json and
// spikes/results/e8.json, and fails loudly unless every scenario passes.
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runExperiment } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const resultsDir = join(root, "results");
mkdirSync(resultsDir, { recursive: true });

for (const exp of ["e6", "e8"]) {
  const report = runExperiment(exp.toUpperCase(), join(root, "cases", exp));
  const outPath = join(resultsDir, `${exp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  for (const c of report.cases) {
    console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id}`);
    for (const s of c.steps) {
      console.log(`  step ${s.step} ${s.action}: ${s.ok ? "ok" : `REJECTED (${s.reason})`}`);
    }
  }
  console.log(`${exp.toUpperCase()}: passed ${report.passed} / ${report.total} -> ${outPath}`);
  assert.equal(report.passed, report.total, `${exp.toUpperCase()} has failures`);
}
console.log("All E6/E8 scenarios pass. Zero model calls.");
