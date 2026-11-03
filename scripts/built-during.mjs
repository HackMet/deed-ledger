#!/usr/bin/env node
// Regenerates docs/built-during-hackathon.md from git and gh (no dependencies).
// Usage: node scripts/built-during.mjs [ref]   (default ref: origin/main)
// The output depends only on the repo state and the PR list, so a rerun with
// nothing new produces the same file.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const KICKOFF = "2026-10-26T16:00:00Z"; // D-17: Mon Oct 26, 10:00 AM Honduras time
const REF = process.argv[2] ?? "origin/main";

// Work not yet on origin/main lives on stacked local branches: [branch, parent, excluded refs].
// The two on-main branches are the stack above them rebased/merged onto main, so the
// stack they carry is excluded from their count (otherwise those shas are counted twice).
const STACK = [
  ["claude/engine-issue-12", "origin/main"],
  ["claude/engine-facts", "claude/engine-issue-12"],
  ["claude/console-pedidos", "claude/engine-facts"],
  ["claude/change-requests", "claude/console-pedidos"],
  ["claude/dispatch", "claude/change-requests"],
  ["claude/demo-env", "claude/dispatch"],
  ["claude/adversary", "claude/demo-env"],
  ["claude/console-negocio", "claude/dispatch"],
  ["claude/facturas", "claude/console-negocio"],
  ["claude/engine-docs", "origin/main"],
  ["claude/stack-on-main", "origin/main", ["claude/dispatch"]],
  ["claude/demo-on-main", "claude/stack-on-main", ["claude/demo-env"]],
];

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).trim();
const tryRun = (cmd, args) => { try { return run(cmd, args); } catch { return null; } };
const utc = (iso) => new Date(iso).toISOString().slice(0, 16).replace("T", " ") + "Z";
const cell = (s) => String(s).replace(/\|/g, "\\|");

const kickoff = Date.parse(KICKOFF);
const head = run("git", ["rev-parse", "--short", REF]);

const commits = run("git", ["log", REF, "--reverse", "--format=%aI%x09%h%x09%an%x09%s"])
  .split("\n").map((l) => l.split("\t"))
  .map(([date, sha, author, ...s]) => ({ date, sha, author, subject: s.join("\t") }));

const authors = new Map();
for (const c of commits) authors.set(c.author, (authors.get(c.author) ?? 0) + 1);
const pre = commits.filter((c) => Date.parse(c.date) < kickoff).length;

const prJson = tryRun("gh", ["pr", "list", "--state", "all", "--limit", "200", "--json",
  "number,title,author,createdAt,mergedAt,state,headRefName"]);
const prs = prJson ? JSON.parse(prJson).sort((a, b) => a.number - b.number) : null;

const out = [];
out.push("# Built during the hackathon", "");
out.push("Regenerate right before submitting: `node scripts/built-during.mjs` (git + gh only, no dependencies).", "");
out.push(`- Kickoff boundary (D-17): ${utc(KICKOFF)} (Mon Oct 26, 10:00 AM Honduras time). Commits dated before it are marked **pre-event**.`);
out.push(`- Source: \`${REF}\` at \`${head}\`, ${commits.length} commits, ${pre} dated before kickoff. Dates are author dates in UTC.`);
out.push("- There is no `pre-event-baseline` tag in the repo, so the boundary is the date, not a tag.");
out.push(`- Authors as \`git log --format=%an\` shows them: ${[...authors].map(([a, n]) => `${a} (${n})`).join(", ")}.`, "");

out.push("## Pull requests", "");
if (prs) {
  out.push("| # | Title | Author | Opened (UTC) | State | Merged (UTC) |", "|---|---|---|---|---|---|");
  for (const p of prs) {
    out.push(`| #${p.number} | ${cell(p.title)} | ${p.author.login} | ${utc(p.createdAt)} | ${p.state} | ${p.mergedAt ? utc(p.mergedAt) : "-"} |`);
  }
} else {
  out.push("[TBD: `gh pr list` failed; rerun with gh authenticated]");
}
out.push("");

out.push("## Not yet on origin/main (local branches)", "");
out.push("Commits are counted against the parent branch; the stack order is the merge order.");
out.push("`claude/stack-on-main` and `claude/demo-on-main` are the stack above merged onto main: their count leaves out the commits already counted in the rows they carry (`claude/dispatch` and its ancestors, and `claude/demo-env`), so only the commits new on that branch are listed, merges included.", "");
out.push("| Branch | Parent | Commits | Head |", "|---|---|---|---|");
for (const [b, parent, excl = []] of STACK) {
  const sha = tryRun("git", ["rev-parse", "--short", b]);
  if (!sha) { out.push(`| ${b} | ${parent} | - | not present in this clone |`); continue; }
  out.push(`| ${b} | ${parent} | ${run("git", ["rev-list", "--count", b, `^${parent}`, ...excl.map((e) => `^${e}`)])} | ${sha} |`);
}
out.push("");

out.push(`## Every commit on ${REF}`, "");
out.push("| Date (UTC) | Sha | Author | Subject |", "|---|---|---|---|");
for (const c of commits) {
  const flag = Date.parse(c.date) < kickoff ? " **(pre-event)**" : "";
  out.push(`| ${utc(c.date)} | ${c.sha} | ${cell(c.author)} | ${cell(c.subject)}${flag} |`);
}
out.push("");

writeFileSync(new URL("../docs/built-during-hackathon.md", import.meta.url), out.join("\n"));
console.log(`wrote docs/built-during-hackathon.md: ${commits.length} commits, ${prs ? prs.length : "?"} PRs`);
