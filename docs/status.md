# Status

Shared state for every agent: what's true now, what's next, what's open, what bit us. Keep it short. Anything a
command can tell you (git log, test results, CI) doesn't belong here. Decisions go in [decisions.md](decisions.md).

Last updated: Tue Oct 27, 2026, afternoon Honduras time, by Claude Code (team offer sent).

## Now

- Repository initialized: docs, agent instructions, spike cases on `main`. No application code.
- Kickoff today at 10:00 AM Honduras time. Product code starts after it (D-17, proposed; U4 asks whether Oct 27 is
  the real start).
- Johan agreed (Oct 26, per Angel): real store data, filming, and public use of the store's name, the town, his name
  and the product name. His written message is the record.
- Meta credits claimed, card on file. Cloudflare: Angel's existing account, already on Workers Paid.
- The first commit is unblocked and waits only on Angel's word.
- E1-E8 prep (Muse orchestrator, ~9:45 PM): date gate NOT passed (Oct 26 in
  ET/Honduras, U4 unanswered) → contracts + 53 fixed cases (+2 fixtures) only,
  no runner or model calls. Lanes wait for Oct 27 00:00 ET; see the handoff.
- E1-E8 Phase 1 (Muse orchestrator, Oct 27 AM): all lanes green-ish, all
  uncommitted on spike/* (E1 14/15, E3 10/10, E6 4/4, E8 3/3, E2 5/6, E5
  9/9; ~$0.75 of $5). Needs Angel: echo-convention ruling, Phase 2 go,
  commit/integrate. Cards in KB planning/2026-10-27-phase1-result-cards.md.
- E4 voice (Muse, Oct 27 AM, `spike/voice-e4` uncommitted): transcription
  6/6, interpretation 4/6 strict (E4-05 correction flip is genuine; E4-02
  filler-echo is a scoring artifact); E1-02 rescored PASS offline (E1
  15/15); ~$0.81 of $5 total. E7 not run. OGG->WAV: WASM-in-consumer
  leads, needs T2 CPU benchmark.
- e1-v4 fix (Muse, Oct 27 AM, `spike/e1-v4` uncommitted): E1 19/21 (15/15
  original, 4/6 held-out -- corrections right, product lift gap stands);
  E4 interpret 6/6 on saved transcripts. No e1-v5 (no original-15
  regression). ~$1.12 of $5 total.

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
| Team: offer sent Oct 27 to a possible teammate (accepted builder, Indie track): they would own perception (photos and voice in, checked proposals out); Angel keeps the engine and the product. Waiting on a reply. Before they write code: prize split and code ownership in writing, Johan's OK for real data, repo access, a written spec for the perception/engine boundary. T2 and T3 owners change only once they agree | Teammate → Angel | Oct 27 |
| Product and team name: "Johan AI" is a working title, to be picked later | Angel | Oct 27 |

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
