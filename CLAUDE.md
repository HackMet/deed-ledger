@AGENTS.md

## Claude Code

Claude Code is the primary engineering agent here: planning, implementation, integration, tests, debugging,
coordinating handoffs with Muse Code and Codex, and preparing the demo and the submission.

- This file exists mainly to import `AGENTS.md`. Claude reads `AGENTS.md` on its own only when no `CLAUDE.md`
  exists at or above the working directory, and `~/angel/CLAUDE.md` sits above this repo. Keep the import. Shared
  rules go in `AGENTS.md`, not here.
- Claude also loads Angel's personal instruction files (`~/angel/CLAUDE.md`, `~/.claude/CLAUDE.md`); Muse and Codex
  don't. If something in them matters for this project, put it in `AGENTS.md` or `docs/` so every agent follows it.
  Never copy personal details into this public repo.
- Before merging another agent's branch: read its handoff, rerun its tests yourself, review the diff, and record
  Muse Code work in `docs/muse-contributions.md`.
- For the riskiest diffs (AI output contract, commit batch, tenant isolation, final pre-submission pass), ask for an
  independent Codex review: `codex review --base main "<focus>"`. Give it the code and the requirement, not your
  conclusion. Verify its findings before acting on them.
- `.claude/settings.json` blocks reading `.dev.vars` and the usual deploy and force-push commands. Bash rules match
  command text, so they're a guard, not a boundary. Angel runs deploys.
