# Development workflow

How Claude Code, Muse Code and Codex share one repo without stepping on each other. No orchestration platform: git
branches, worktrees, a few files, and Angel deciding who does what.

## Who does what

| Agent | Use it for | Not for |
|---|---|---|
| **Claude Code** (primary; Claude Max) | Planning, implementation, integration, tests, debugging, deploy preparation, demo and submission prep, coordinating handoffs | — |
| **Muse Code** (Meta) | Separately scoped tasks behind a clear interface, Meta-API-heavy work, independent validation suites ([plan](hackathon-plan.md#first-three-tasks)) | That day's critical-path integration; anything that needs real store data |
| **Codex** (optional; ChatGPT Plus) | Independent reviews (architecture, security, risky diffs) and second opinions on hard bugs | Building, testing or deploying. Nothing in this workflow depends on it |

Cost: Claude Max covers daily engineering. Muse Code runs on Angel's Muse plan, or on an API key billed to the Meta
Model API account (whether the hackathon credits cover that is unverified). Codex draws on ChatGPT Plus limits, so
save it for reviews that matter. Don't switch tools just to switch.

## Start of every session

1. The instructions load by themselves (`AGENTS.md`). Then read [status.md](status.md).
2. Run `git status` and `git worktree list` to see what else is in flight.
3. Read the task's references: plan item, PRD requirements, architecture.
4. Confirm the task is yours (assigned in status.md) before editing.

## Task lifecycle

1. Angel assigns a task to an agent in status.md.
2. Create a branch `<agent>/<slug>` from `main`: `claude/whatsapp-intake`, `muse/voice-pipeline`,
   `codex/review-commit-batch`.
3. If another agent is working at the same time, give each agent its own worktree, next to the repo (Angel's usual
   `../<repo>-<branch>` layout):

   ```bash
   git worktree add -b muse/voice-pipeline ../hackathon-muse-voice-pipeline main
   cd ../hackathon-muse-voice-pipeline && muse
   ```

   One agent per worktree. Never edit another agent's worktree or branch. Unexpected changes in your tree: stop and
   report.
4. Implement with tests and run the whole suite.
5. Write the handoff (below) and update status.md.
6. Review: the integrating agent (usually Claude) reruns the tests, reads the diff and checks the handoff's claims.
   Codex reviews the riskiest diffs. Angel commits and merges. `muse/*` branches merge with a merge commit
   (`git merge --no-ff`, never squash), so Muse Code's share stays visible in the history (D-14).
7. Clean up: `git worktree remove ../hackathon-muse-voice-pipeline` and delete the merged branch.

## Handoff format

For any non-trivial task, and for every task that moves between agents. Trivial changes get one line in status.md
instead.

```markdown
## Handoff: <task>
- Agent and branch:
- Objective:
- References: (plan item, PRD FR-xx, decisions)
- Files changed:
- What was done:
- Tests run: (command → result, pasted)
- Not done, risks, open questions:
- Next steps:
```

Where it goes: the pull request description once the GitHub repo exists. Until then, `docs/handoffs/<date>-<slug>.md`
(create the folder with the first one).

## Claude Code

- `CLAUDE.md` imports `AGENTS.md`. The import is required: Claude reads `AGENTS.md` on its own only when no
  `CLAUDE.md` exists at or above the working directory, and `~/angel/CLAUDE.md` sits above this repo.
- Claude also loads Angel's personal files (`~/angel/CLAUDE.md`, `~/.claude/CLAUDE.md`). Muse and Codex don't, so
  shared rules go in `AGENTS.md`.
- `.claude/settings.json` blocks reading `.dev.vars` and the usual deploy and force-push commands. It matches command
  text, so it's a guard, not a boundary.
- Verified Oct 26: a fresh headless `claude -p` session in this repo quoted `AGENTS.md` through the import.

## Muse Code

Checked against Meta's docs on Oct 26, 2026. Not yet run in this repo: the first session must confirm the items
marked "check".

**Install and update.** Installed at `~/.local/bin/muse`, version 1.4.9. The changelog's latest is 1.4.13, which
adds enforced filesystem deny rules in permission profiles that extend `:ask-me`, plus security fixes. Update by
letting the built-in updater run, or with the official installer: `curl -fsSL https://dev.meta.ai/install.sh | sh`.
For a quick check that doesn't trigger the updater: `MUSE_NO_AUTO_UPDATE=1 muse --version`.

**Sign-in.** Browser sign-in at first run (or `/login`), or an API key with `muse auth set`. Precedence:
`META_API_KEY` environment variable > stored key > browser session. API-key use is pay-as-you-go on the Meta Model
API account. Never export `META_API_KEY` for the app (D-19).

**Trust.** The first `muse` in the repo (or a worktree) asks whether to trust the workspace. `AGENTS.md` loads only
after you trust it.

**How it finds our rules.** At each directory level it reads the first file that exists of `AGENTS.md`,
`CLAUDE.md`, `.agents/AGENTS.md`, `.claude/CLAUDE.md`, walking up from the workspace to the nearest `.git`. At our
root that's `AGENTS.md`. User-level rules always load too. Don't run `muse init`: it stops because `AGENTS.md`
exists, and `--force` would overwrite it.

**Contributor mode: turn it off.** Subscriptions start with it on, and then Meta may train on prompts, code and
files. Turn it off in `/settings` → Model → Contributor mode (saved per computer), or per run with
`--contributor-mode off` or `MUSE_CONTRIBUTOR_MODE=0`. Angel's settings file has no saved value, so it may be on.
Check.

**Foreign context: check before the first session here.** Muse loads other tools' personal skills
(`~/.claude/skills`, `~/.codex/skills`), and Angel's earlier research found it also reads personal instruction files
such as `~/.claude/CLAUDE.md`. That file holds private details. Angel's Muse settings show the foreign-context notice
has already appeared once. The docs mention "a user preference" that disables foreign personal skill roots but don't
name it. Look for it in `/settings`, or ask in office hours.

**Sandbox.** Shell commands run sandboxed (bubblewrap on Linux). Writes are allowed in the workspace and a temp
folder; `.git`, `.muse` and `.agents` stay read-only, so **Muse can't commit**. Angel commits its work. Network is
proxy-only: each new host (npm registry, `api.meta.ai`) asks for approval.

**Sandbox on this machine: likely blocker, unverified.** The kernel restricts unprivileged user namespaces
(`kernel.apparmor_restrict_unprivileged_userns = 1`). Codex's bubblewrap sandbox fails to start here
(`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`). Muse bundles bubblewrap too and refuses shell
commands when it can't confirm the sandbox, so it may not be able to run tests. If that happens, there are two
options: run Muse with `--disable-sandbox` (approval prompts stay on, isolation is weaker) in a worktree with no
real secrets; or allow Muse's bubblewrap through an AppArmor profile, which changes a system security setting and is
Angel's call.

**Secrets.** Muse has no project-level path deny. Its file tools refuse "credential files", but the docs don't
define them. Keep only low-limit test keys in `.dev.vars`.

**Running it.** Interactive: `muse`. Headless: `muse exec "<prompt>"`. Task briefs live in
[hackathon-plan.md](hackathon-plan.md).

**First-session check** (counts as verified only after it's done):

1. In a T2 worktree, run `muse` and trust the workspace.
2. Ask: "Which instruction files did you load, and what does AGENTS.md say about committing?" Expected: it names
   `AGENTS.md` and says agents don't commit unless Angel asks.
3. Confirm in `/settings` that Contributor mode is off.
4. Ask it to run `git status`. If it refuses because the sandbox can't start, see "Sandbox on this machine" above.

**Evidence.** After each Muse task, export the session:
`/export transcript --redacted --out ../hackathon-evidence/<date>-<slug>.txt`. It goes outside the repo; review it
before sharing. Then fill in [muse-contributions.md](muse-contributions.md).

## Codex

- Installed: `codex-cli 0.163.0`. It reads every `AGENTS.md` from the git root down to the working directory, and
  skips them in untrusted projects, so accept the trust prompt on the first run in this repo.
- Verified Oct 26: a read-only, ephemeral `codex exec` in this repo quoted `AGENTS.md` correctly and ran
  `git status`. Trust was passed as a one-off `-c` override, not saved. It warns that its bubblewrap sandbox needs
  user namespaces, which this machine restricts; read-only commands still ran.
- Reviews: `codex review --base main` (a branch), `codex review --uncommitted`, `codex review --commit <sha>`. Add a
  focus as the prompt, for example `codex review --base main "Focus: tenant isolation"`.
- Questions without edits: `codex exec -s read-only "<prompt>"`.
- Give Codex the code and the requirement, not our conclusion. Its findings come back to Claude to verify and fix.

## When to ask Codex

- T3: the AI output contract and prompt-injection handling.
- M5: the commit batch (idempotency, guards).
- M8: tenant isolation.
- Before submission: a security pass over the whole diff from the first commit.
