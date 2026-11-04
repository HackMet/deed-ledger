// Builds the static scale page from the harness verdicts CSV. One command, no network, no dependency:
//   node scripts/deed-scale.mjs <deed-verdicts.csv> <out.html>
// The CSV comes from deed_check_harness.py (run without --gate, so the verdicts are commit-only).
import { readFile, writeFile } from "node:fs/promises";
import { buildScale, parseCsv, renderPage } from "./lib/deed-scale.mjs";

const [csvPath, outPath] = process.argv.slice(2);
if (!csvPath || !outPath) {
  console.error("usage: node scripts/deed-scale.mjs <deed-verdicts.csv> <out.html>");
  process.exit(2);
}

const scale = await buildScale(parseCsv(await readFile(csvPath, "utf8")));
await writeFile(outPath, renderPage(scale));
const { counts } = scale;
console.log(
  `wrote ${outPath}: ${counts.total} runs, ${counts.confirmed} confirmed, ${counts.contradicted} contradicted, ${counts.inDoubt} in doubt, ${counts.noClaim} without claim`,
);
