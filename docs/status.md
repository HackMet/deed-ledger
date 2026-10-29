# Status

Shared state for every agent: what's true now, what's next, what's open, what bit us. Keep it short. Anything a
command can tell you (git log, test results, CI) doesn't belong here. Decisions go in [decisions.md](decisions.md).

Last updated: Thu Oct 29, 2026, morning Honduras time, by Claude Code (first PRs into the team repo).

## Now

- Two-person team (D-37). Angel owns perception, WhatsApp, media, answers, the web view and deploys. His teammate
  owns the engine: drafts, confirmations, the save batch, the ledger and fact memory. The engine runs in this same
  Worker.
- This repo is the team's. The first PRs bring in the planning docs, the spikes and foundation part 1.
- Foundation part 1 is built and reviewed: WhatsApp intake, in-order processing per conversation, the outbox and store
  isolation. It answers with a placeholder until the engine plugs in at `JobHandler` (`src/application/ports.ts`).
  The media download is still a stub. Details: [architecture.md](architecture.md#part-1-as-built),
  [handoff](handoffs/2026-10-28-foundation-part-1.md).
- Spikes are done (handoffs in [handoffs/](handoffs/)): invoice and voice understanding work on Muse Spark with
  structured output (E1 19/21, E3 10/10, E2 5/6, E5 9/9); voice transcription 6/6 (E4); voice notes decode to WAV
  inside the Worker (A1). E7 was not run.
- Johan agreed (Oct 26, per Angel): real store data, filming, and public use of the store's name, the town, his name
  and the product name. His written message is the record.

## Next

| # | Task | Owner | Notes |
|---|---|---|---|
| 1 | Contract v1 between perception and the engine | Angel and teammate | The engine's entry point is `JobHandler` |
| 2 | One-page spec of minimal fact memory: evidence, validity window, how a cancellation blocks what depends on it | Teammate | Decides open questions 4 and 5 of the technical proposal |
| 3 | Engine: drafts, confirmation, save batch, ledger | Teammate | The save shares one D1 batch with closing the job and queuing the reply |
| 4 | Invoice photo to checked proposal, media download, voice adapter | Angel (Claude Code) | Builds on the E1/E3 and A1 spikes |
| 5 | First deploy | Angel | Needs the Meta app, test phones and Cloudflare resources |

Gate: Thursday Oct 29, 8:00 PM Honduras time. An invoice photo is confirmed and saved once, on the deployed app.

## Open: waiting on someone

| What | Who | Since |
|---|---|---|
| What Johan wants first: inventory or fiado (PRD Q-01) | Angel → Johan | Oct 24 |
| Organizer questions U1–U4, U6 and U7 (Muse Code counted? credits for Muse? credit window? start time? planning docs written before the event? live product?) | Angel → Discord | Oct 26 |
| Check the credits' expiry date (10-day window, U3) and the spend alert | Angel | Oct 26 |
| Repository license, and when it goes public (right before submitting) | Team | Oct 26 |
| Muse Code: Contributor mode off, foreign-context check, sandbox, plan or API key (separate session) | Angel | Oct 26 |
| Proposed decisions D-09, D-10, D-14, D-15, D-16, D-17, D-19 | Angel | Oct 26 |
| Decisions D-20 to D-36 were made Oct 28 in the product and technical proposals and are not in [decisions.md](decisions.md) yet | Angel → Claude Code | Oct 28 |
| Product and team name: "Johan AI" is a working title, to be picked with the team | Team | Oct 27 |

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
