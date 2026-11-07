// The migration guard CI and the deploy run before migrating (scripts/check-migrations.mjs).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkMigrationsDir, migrationProblems } from "../../scripts/check-migrations.mjs";

test("a migration that only adds passes", () => {
  const sql = `CREATE TABLE demo_x (id TEXT PRIMARY KEY, business_id TEXT NOT NULL, n INTEGER NOT NULL);
CREATE INDEX demo_x_business ON demo_x (business_id);
ALTER TABLE orders ADD COLUMN seeded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN note TEXT;`;
  assert.deepEqual(migrationProblems(sql), []);
});

test("drops, renames and NOT NULL columns without a DEFAULT are refused", () => {
  assert.deepEqual(migrationProblems("DROP TABLE orders;"), ["drops a table"]);
  assert.deepEqual(migrationProblems("drop table if exists orders;"), ["drops a table"]);
  assert.deepEqual(migrationProblems("ALTER TABLE orders DROP COLUMN note;"), ["drops a column"]);
  assert.deepEqual(migrationProblems("ALTER TABLE orders RENAME TO orders_old;"), ["renames a table or column"]);
  assert.deepEqual(migrationProblems("ALTER TABLE orders RENAME COLUMN a TO b;"), ["renames a table or column"]);
  assert.deepEqual(migrationProblems("ALTER TABLE orders ADD COLUMN seeded INTEGER NOT NULL;"), [
    "adds a NOT NULL column without a DEFAULT",
  ]);
  assert.deepEqual(migrationProblems("ALTER TABLE orders ADD seeded INTEGER NOT NULL;\nALTER TABLE orders ADD b TEXT;"), [
    "adds a NOT NULL column without a DEFAULT",
  ]);
});

test("words inside comments and strings don't count", () => {
  const sql = `-- we never DROP TABLE here
/* RENAME is not done */
INSERT INTO notes (text) VALUES ('DROP TABLE orders; RENAME');`;
  assert.deepEqual(migrationProblems(sql), []);
  // An apostrophe inside a comment doesn't hide what follows.
  assert.deepEqual(migrationProblems("-- don't keep it\nDROP TABLE orders;\n-- it's gone"), ["drops a table"]);
});

test("an allow comment with a reason lets it through; a bare one doesn't", () => {
  assert.deepEqual(migrationProblems("-- migration-check: allow demo_tmp is never read\nDROP TABLE demo_tmp;"), []);
  assert.deepEqual(migrationProblems("-- migration-check: allow\nDROP TABLE demo_tmp;"), ["drops a table"]);
});

test("migrations up to 0032 are grandfathered; later ones and unnumbered files are checked", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "migrations-"));
  writeFileSync(path.join(dir, "0024_old.sql"), "DROP TABLE x;");
  writeFileSync(path.join(dir, "0033_new.sql"), "ALTER TABLE x RENAME TO y;");
  writeFileSync(path.join(dir, "extra.sql"), "CREATE TABLE z (id TEXT);");
  writeFileSync(path.join(dir, "README"), "DROP TABLE");
  assert.deepEqual(checkMigrationsDir(dir), [
    "0033_new.sql: renames a table or column",
    "extra.sql: no leading number, so wrangler's order for it is unclear",
  ]);
});

test("the repo's migrations pass, and the command exits non-zero on a bad one", () => {
  const out = execFileSync("node", ["scripts/check-migrations.mjs"], { encoding: "utf8" });
  assert.match(out, /migrations only add/);
  const dir = mkdtempSync(path.join(tmpdir(), "migrations-"));
  writeFileSync(path.join(dir, "0040_bad.sql"), "ALTER TABLE x DROP COLUMN y;");
  assert.throws(() => execFileSync("node", ["scripts/check-migrations.mjs", dir], { stdio: "pipe" }), (e) => e.status === 1);
});
