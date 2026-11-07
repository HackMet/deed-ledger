#!/usr/bin/env node
// Guards the R6 record: docs/hackathon-record.md must not cite a tag that does not exist, and the
// stacked-on-main branches must not count the stack they carry a second time.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const readme = readFileSync(new URL("../docs/hackathon-record.md", import.meta.url), "utf8");
const problems = [];
const skipped = [];
// The stacked branches below live only in Angel's clone; a fresh clone or CI has none of them.
const hasRef = (ref) => {
  try {
    git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

if (readme.includes("pre-event-baseline") && !git("tag", "-l", "pre-event-baseline")) {
  const claimsIt = readme.split("\n").some((l) => l.includes("pre-event-baseline") && !/no `pre-event-baseline` tag/.test(l));
  if (claimsIt) problems.push("the record cites a `pre-event-baseline` tag that does not exist");
}

for (const [b, parent, excl, shown] of [
  ["claude/stack-on-main", "origin/main", "claude/dispatch", null],
  ["claude/demo-on-main", "claude/stack-on-main", "claude/demo-env", null],
  ["claude/owner-on-main", "claude/demo-on-main", "claude/facturas", null],
  ["claude/deed-on-main", "claude/engine-reads", "claude/deed-graph", null],
]) {
  const m = readme.match(new RegExp("\\| `" + b + "` \\| (\\d+) \\|"));
  if (!m) problems.push(`the record has no row for ${b}`);
  const missing = [b, parent, excl].filter((ref) => !hasRef(ref));
  if (missing.length) {
    skipped.push(`${b}: ${missing.length > 1 ? "branches" : "branch"} ${missing.join(", ")} not found (local only), commit count not checked`);
    continue;
  }
  const n = git("rev-list", "--count", b, `^${parent}`, `^${excl}`);
  if (m && m[1] !== n) problems.push(`the record says ${b} has ${m[1]} commits, new ones are ${n}`);
}

if (skipped.length) console.log(skipped.join("\n"));
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(skipped.length ? "submission docs consistent (branch counts skipped above)" : "submission docs consistent");
