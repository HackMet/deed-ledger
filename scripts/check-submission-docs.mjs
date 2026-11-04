#!/usr/bin/env node
// Guards the R6 record: the README must not cite a tag that does not exist, and the
// stacked-on-main branches must not count the stack they carry a second time.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const problems = [];

if (readme.includes("pre-event-baseline") && !git("tag", "-l", "pre-event-baseline")) {
  const claimsIt = readme.split("\n").some((l) => l.includes("pre-event-baseline") && !/no `pre-event-baseline` tag/.test(l));
  if (claimsIt) problems.push("README cites a `pre-event-baseline` tag that does not exist");
}

for (const [b, parent, excl, shown] of [
  ["claude/stack-on-main", "origin/main", "claude/dispatch", null],
  ["claude/demo-on-main", "claude/stack-on-main", "claude/demo-env", null],
  ["claude/owner-on-main", "claude/demo-on-main", "claude/facturas", null],
  ["claude/deed-on-main", "claude/engine-reads", "claude/deed-graph", null],
]) {
  const n = git("rev-list", "--count", b, `^${parent}`, `^${excl}`);
  const m = readme.match(new RegExp("\\| `" + b + "` \\| (\\d+) \\|"));
  if (!m) problems.push(`README has no row for ${b}`);
  else if (m[1] !== n) problems.push(`README says ${b} has ${m[1]} commits, new ones are ${n}`);
}

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log("submission docs consistent");
