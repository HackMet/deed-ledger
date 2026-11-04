// Runs scripts/deed-recheck.mjs as a third party would, by its exit code. Vitest runs inside the Workers runtime,
// which can't start a process, so this file runs under node:test from `npm test`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const EXAMPLE = "docs/deed-entry-example.json";
const dir = mkdtempSync(join(tmpdir(), "deed-recheck-"));

function exitOf(file) {
  return spawnSync(process.execPath, ["scripts/deed-recheck.mjs", file], { encoding: "utf8" }).status;
}

function copyOf(name, change) {
  const entry = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  change(entry);
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(entry));
  return file;
}

test("exits 0 on a correct entry", () => {
  assert.equal(exitOf(EXAMPLE), 0);
});

test("exits 1 on an entry whose verdict was changed", () => {
  const changed = copyOf("changed", (entry) => {
    const first = entry.verdicts[0];
    first.state = first.state === "emparejado" ? "sin_pareja" : "emparejado";
  });
  assert.equal(exitOf(changed), 1);
});

test("exits 1 on an entry with an added verdict", () => {
  const added = copyOf("added", (entry) => entry.verdicts.push({ rowKey: "r99", state: "emparejado" }));
  assert.equal(exitOf(added), 1);
});

test("exits 2 on an entry it can't read", () => {
  assert.equal(exitOf(copyOf("schema2", (entry) => { entry.schema = 2; })), 2);
  assert.equal(exitOf(join(dir, "missing.json")), 2);
});
