// Builds the static scale page from the harness verdicts CSV. One command, no network, no dependency:
//   node scripts/deed-scale.mjs <deed-verdicts.csv> <out.html> [notes.json]
// The CSV comes from deed_check_harness.py (run without --gate, so the verdicts are commit-only).
import { readFile, writeFile } from "node:fs/promises";
import { buildScale, parseCsv, renderPage } from "./lib/deed-scale.mjs";

const [csvPath, outPath, notesPath] = process.argv.slice(2);
if (!csvPath || !outPath) {
  console.error("usage: node scripts/deed-scale.mjs <deed-verdicts.csv> <out.html> [notes.json]");
  process.exit(2);
}

const scale = await buildScale(parseCsv(await readFile(csvPath, "utf8")));
const notes = notesPath ? JSON.parse(await readFile(notesPath, "utf8")) : {};
await writeFile(outPath, renderPage(scale, notes));
const { counts } = scale;
console.log(
  `wrote ${outPath}: ${counts.total} runs, ${counts.confirmed} confirmed, ${counts.contradicted} contradicted, ${counts.inDoubt} in doubt, ${counts.noClaim} without claim`,
);
