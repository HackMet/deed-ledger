#!/usr/bin/env node
// Guards the rule that migrations only add (docs/deploy.md): the deploy applies migrations while the old code is
// still serving, so a new migration must not drop or rename what that code reads, or add a NOT NULL column with
// no DEFAULT (old code's INSERTs would fail). CI and the deploy run this before migrating.
//
// A migration that really needs one of these says so in a comment with a reason, e.g.
//   -- migration-check: allow drop of demo_tmp, never read by any deployed code
// Migrations up to GRANDFATHERED_THROUGH were applied before this check existed and are skipped.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GRANDFATHERED_THROUGH = 32;
const ALLOW = /--[ \t]*migration-check:[ \t]*allow[ \t]+\S/i;

/** The SQL with comments and string literals blanked, so words inside them don't count. */
function codeOnly(sql) {
  // One pass, so whichever starts first wins: an apostrophe in a comment doesn't open a string.
  return sql.replace(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\/|--[^\n]*/g, " ");
}

/** What in one migration breaks the code still running while it applies. Empty when it only adds. */
export function migrationProblems(sql) {
  if (ALLOW.test(sql)) return [];
  const code = codeOnly(sql);
  const problems = [];
  if (/\bDROP\s+TABLE\b/i.test(code)) problems.push("drops a table");
  if (/\bDROP\s+COLUMN\b/i.test(code)) problems.push("drops a column");
  if (/\bRENAME\b/i.test(code)) problems.push("renames a table or column");
  // A new table's NOT NULL columns are fine: no running code writes to it yet. Only added columns matter.
  for (const statement of code.split(";")) {
    const added = statement.match(/\bALTER\s+TABLE\b[\s\S]*?\bADD\s+(?:COLUMN\s+)?([\s\S]*)/i);
    if (added && /\bNOT\s+NULL\b/i.test(added[1]) && !/\bDEFAULT\b/i.test(added[1])) {
      problems.push("adds a NOT NULL column without a DEFAULT");
    }
  }
  return problems;
}

/** The migration's number from its file name (0033_x.sql → 33), or null when it has none. */
export function migrationNumber(fileName) {
  const m = /^(\d+)_.*\.sql$/.exec(fileName);
  return m ? Number(m[1]) : null;
}

export function checkMigrationsDir(dir) {
  const problems = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const n = migrationNumber(file);
    if (n === null) {
      problems.push(`${file}: no leading number, so wrangler's order for it is unclear`);
      continue;
    }
    if (n <= GRANDFATHERED_THROUGH) continue;
    for (const p of migrationProblems(readFileSync(path.join(dir, file), "utf8"))) problems.push(`${file}: ${p}`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? fileURLToPath(new URL("../migrations", import.meta.url));
  const problems = checkMigrationsDir(dir);
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(
      "Migrations must only add (the old code serves while they apply). If this one is safe, add a comment\n" +
        "`-- migration-check: allow <reason>` to the file.",
    );
    process.exit(1);
  }
  console.log(`migrations only add (checked those after ${String(GRANDFATHERED_THROUGH).padStart(4, "0")})`);
}
