#!/usr/bin/env node
// Re-runs the Deed verdicts of an exported entry (C3): `node scripts/deed-recheck.mjs <entry.json>`.
// No network, no database, no model, no secret. The judge is src/domain/deed-recheck.ts, bundled here with
// esbuild: Node can't import the domain's extensionless TypeScript, and a second copy of the rules would not be
// the same judge. Exit 0: every verdict holds. 1: a verdict differs. 2: not a readable, valid entry.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [file, ...extra] = process.argv.slice(2);
if (file === undefined || extra.length > 0) {
  console.error("usage: node scripts/deed-recheck.mjs <entry.json>");
  process.exit(2);
}

let entry;
try {
  entry = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`deed-recheck: cannot read ${file} as JSON: ${error.message}`);
  process.exit(2);
}

const bundle = await build({
  entryPoints: [join(root, "src/domain/deed-recheck.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const { recheckEntry } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const result = recheckEntry(entry);
if (!result.ok) {
  console.error(`deed-recheck: ${result.error}`);
  process.exit(2);
}
console.log(`pairs: ${result.pairs}, same: ${result.same}, differ: ${result.differ.length}`);
for (const d of result.differ) console.log(`differ ${d.rowKey}: stored ${d.stored ?? "null"}, recomputed ${d.recomputed ?? "null"}`);
process.exit(result.differ.length === 0 ? 0 : 1);
