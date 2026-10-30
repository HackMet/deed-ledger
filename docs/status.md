# Status

Shared state for every agent: what's true now, what's next, what's open, what bit us. Keep it short. Anything a
command can tell you (git log, test results, CI) doesn't belong here. Decisions go in [decisions.md](decisions.md).

Last updated: Fri Oct 30, 2026, morning Honduras time, by Claude Code (engine commits, contract draft, console).

## Now

- The product is now an order assistant: customers order on WhatsApp, Johan and staff work from a phone console,
  and both end in the same engine. The team's PRD v1.2 and Tech Spec v3 describe it; they were shared with the
  teammate on Oct 30 and aren't in this repo yet (`PRD.md` and `architecture.md` still describe the earlier
  inventory flow).
- Two-person team (D-37). Angel owns conversations, perception, replies, the console and deploys. His teammate owns
  the engine (orders, payments, sales, fiado, stock, prices, fact memory) on D1 fenced batches.
- Foundation part 1 is built: WhatsApp intake, in-order processing, the outbox, store isolation
  ([architecture.md](architecture.md#part-1-as-built)). On the team repo it sits on `claude/base-layer`; the stacked
  PRs merged into each other, so `main` has only the planning docs until a PR from `claude/base-layer` lands.
- Built Oct 30 on `claude/job-outcome-commits`, uncommitted
  ([handoff](handoffs/2026-10-30-commits-contract-console.md)):
  - `JobOutcome.commits`: the engine's writes save in the batch that completes the job. This unblocks the engine.
  - Contract v1 draft ([contract.md](contract.md)): types and fixtures between perception, the engine and the
    console. For the spec meeting; not agreed.
  - The console's preparation list, on an in-memory pretend engine, in local dev mode only (no login yet).
- Spikes are done (handoffs in [handoffs/](handoffs/)): Muse Spark reads invoices and orders with structured output;
  voice transcription 6/6; voice notes decode to WAV inside the Worker.
- Two independent reviews of Tech Spec v3 (Oct 30) both said "build with changes". The contract draft takes in their
  fixes for line references, multi-part messages, staff-only kinds, confirmed prices and the claim check.

## Next

| # | Task | Owner | Notes |
|---|---|---|---|
| 1 | Spec meeting: agree contract v1 and its open questions | Both | [contract.md](contract.md#open-for-the-meeting) |
| 2 | PR `claude/base-layer` into `main` on the team repo | Angel | Merge commit, not squash |
| 3 | Engine on the contract, saving through `JobOutcome.commits` | Teammate | Replaces the pretend engine |
| 4 | Console login (invite QR, sessions, roles), then a deploy | Angel (Claude Code) | Needed for the console gate |
| 5 | Replies and the claim check; perception for customer orders | Angel (Claude Code) | Against the contract fixtures |
| 6 | The two-minute "te respondemos en un momento" fallback | Angel (Claude Code) | Specified, not built |

Gate: Saturday Oct 31, 8:00 PM Honduras time. A customer order runs end to end on fixtures through the engine, and
staff use the preparation list on their own phones. If the console can't pass, it is cut and the scope replanned.

## Open: waiting on someone

| What | Who | Since |
|---|---|---|
| A change while packing: does the customer reconfirm (PRD) or not (Tech Spec order life)? | Team | Oct 30 |
| One open order per customer, or several? | Team | Oct 30 |
| The teammate's own spec, to compare against the contract | Teammate → Angel | Oct 29 |
| Real WhatsApp payloads (text, photo, voice, location pin, button tap) captured on the test number | Angel | Oct 30 |
| The pilot's WhatsApp number, and how judges try the product | Angel | Oct 29 |
| Organizer questions U1–U4, U6 and U7 | Angel → Discord | Oct 26 |
| Repository license, and when it goes public (right before submitting) | Team | Oct 26 |
| Decisions made since Oct 28 aren't in [decisions.md](decisions.md) yet | Angel → Claude Code | Oct 28 |
| Product and team name: "Johan AI" is a working title | Team | Oct 27 |

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
