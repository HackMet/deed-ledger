# Status

Shared state for every agent: what's true now, what's next, what's open, what bit us. Keep it short. Anything a
command can tell you (git log, test results, CI) doesn't belong here. Decisions go in [decisions.md](decisions.md).

Last updated: Mon Oct 26, 2026, 9:45 PM Honduras time, by Muse Code (E1-E8 date gate; day-0 answers by Claude Code 9:15 AM).

## Now

- Repository initialized: docs, agent instructions, git (`main`, no commits yet). No application code.
- Kickoff today at 10:00 AM Honduras time. Product code starts after it (D-17, proposed; U4 asks whether Oct 27 is
  the real start).
- Johan agreed (Oct 26, per Angel): real store data, filming, and public use of the store's name, the town, his name
  and the product name. His written message is the record.
- Meta credits claimed, card on file. Cloudflare: Angel's existing account, already on Workers Paid.
- The first commit is unblocked and waits only on Angel's word.
- E1-E8 prep (Muse orchestrator, ~9:45 PM): date gate NOT passed (Oct 26 in
  ET/Honduras, U4 unanswered) → contracts + 53 fixed cases (+2 fixtures) only,
  no runner or model calls. Lanes wait for Oct 27 00:00 ET; see the handoff.

## Next

| # | Task | Agent | Notes |
|---|---|---|---|
| 1 | Day-0 admin | Angel | [Plan, day 0](hackathon-plan.md#day-0-today-angel) |
| 2 | T1 walking skeleton | Claude Code | After the kickoff and the Meta app setup |
| 3 | T2 voice notes to text | Muse Code | After T1's scaffold commit; own worktree |
| 4 | T3 invoice photo → reviewed draft | Claude Code, Codex review | Needs 5 consented invoice photos |

## Open: waiting on someone

| What | Who | Since |
|---|---|---|
| What Johan wants first: inventory or fiado (PRD Q-01) | Angel → Johan | Oct 24 |
| Organizer questions U1–U4 and U7 (Muse Code expected? credits for Muse? credit window? start time? live product?) | Angel → Discord | Oct 26 |
| Check the credits' expiry date (10-day window, U3) and the spend alert | Angel | Oct 26 |
| Repository license, GitHub repo name, when it goes public (after the summary) | Angel | Oct 26 |
| Muse Code: Contributor mode off, foreign-context check, sandbox, plan or API key (separate session) | Angel | Oct 26 |
| Proposed decisions D-09, D-10, D-14, D-15, D-16, D-17, D-19 | Angel | Oct 26 |
| Team: solo so far, in talks with a possible teammate. Settle track, ownership and prize split before they write code | Angel | Oct 26 |

## Traps

- Claude Code skips `AGENTS.md` in this folder unless `CLAUDE.md` imports it (`~/angel/CLAUDE.md` is above the
  repo). Keep the import.
- `muse --version` can start Muse's auto-updater. Use `MUSE_NO_AUTO_UPDATE=1` for quick checks.
- `META_API_KEY` in the shell makes Muse Code bill that key instead of the signed-in plan. The app uses
  `MODEL_API_KEY`.
- Muse's sandbox keeps `.git` read-only: it can't commit, so Angel commits its work.
- WhatsApp voice notes have to become WAV (mono, 16-bit, 16 or 24 kHz) before Muse Voice Transcribe accepts them.
- Workers Free gives 10 ms of CPU per invocation. Angel's account is on Workers Paid (30 s by default, up to 5 min).
- In a D1 batch, an `UPDATE` that matches 0 rows doesn't roll anything back. Guards must fail loudly (UNIQUE or
  CHECK).
- Inside workerd, timers don't advance during synchronous work, so measure CPU-heavy code elsewhere.
- This machine restricts unprivileged user namespaces, so bubblewrap sandboxes can fail to start: Codex warns but
  still runs read-only commands; Muse may refuse shell commands. See [workflow.md](workflow.md#muse-code).

## Done

Feature-level milestones only (M1–M12 from the plan), one line each, as they land.
