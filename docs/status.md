# Status

Shared state for every agent: what's true now, what's next, what's open, what bit us. Keep it short. Anything a
command can tell you (git log, test results, CI) doesn't belong here. Decisions go in [decisions.md](decisions.md).

Last updated: Sat Oct 31, 2026, morning Honduras time, by Claude Code (Angel's side built against the pretend engine).

## Now

- The product is an order assistant: customers order on WhatsApp, Johan and staff work from a phone console, and
  both end in the same engine. Two-person team (D-37): Angel owns conversations, perception, replies, the console
  and deploys; kercmari owns the engine (orders, payments, sales, fiado, stock, prices, fact memory).
- Built on Angel's side, against the in-memory pretend engine (handoffs `handoffs/2026-10-31-*.md`):
  - customers (#14–#16), the full order trip (#17), console taps that message the customer (#18);
  - Spanish replies, the claim check and reply buttons (#19, #20); reading orders with Muse Spark (#21);
  - console login (#22, PR #61) and shell with Empleados (#23); the Anotar reader (#26);
  - media download, voice notes decoded and transcribed, both read in orders (#27);
  - first message, ALTO, handoff and deletion, a privacy page (#30); the two-minute message (#31);
  - delivery to a saved place (#29): pins from the webhook, saved places offered with Sí / Otro lugar (migration
    0017; contract additions proposed in [contract.md](contract.md) "Proposed (#29)");
  - customer questions: price, availability, store hours (#47); contract additions proposed in contract.md
    "Proposed (#47)";
  - console menu and look (worktree `hackathon-claude-menu`, not committed): bottom tabs, Más, Pendientes
    (migration 0018) with its count on the owner's tab, a top bar with who is logged in, and Pedidos as a list plus
    a page per order (`handoffs/2026-10-31-console-look.md`);
  - conversation rules (same worktree, not committed): never silent, name asked at Confirmar, typed yes and typed
    button numbers, greetings and thanks, question + order in one reply, stop in other words, honest failure and
    handoff copy (`handoffs/2026-10-31-conversation-fixes.md`; engine side proposed in contract.md "Proposed
    (conversation rules)").
- kercmari's engine is PR #62. A local trial ran this branch's full path on it: orders save once under our customer
  IDs, but no order reply goes out until `verifyClaims` exists (#12); the list and staff taps need #12 too.
- Contract gaps (a)–(p) and 16 questions from the build have proposed answers in [contract.md](contract.md); not
  agreed yet. Gap (p) is settled: one model call per burst.

## Next

| # | Task | Owner | Notes |
|---|---|---|---|
| 1 | Agree the contract answers; settle migration numbers before any remote apply | Both | Call Sat Oct 31, 4 PM Honduras |
| 2 | `verifyClaims`, `preparationList`, `onConsoleAction` on the real engine (#12) | kercmari | Unblocks every customer reply on her engine |
| 3 | Swap the pretend engine for the real one (#13) | Angel (Claude Code) | Bridge built in the local trial |
| 4 | First deploy (#24) | Angel | `docs/deploy.md`; set `LINK_SIGNING_SECRET`, `MODEL_API_KEY`, `PUBLIC_BASE_URL` |
| 5 | Capture real WhatsApp payloads (#25) | Angel | Needs the deploy |

Gate: Saturday Oct 31, 8:00 PM Honduras time.

## Open: waiting on someone

| What | Who | Since |
|---|---|---|
| The teammate's own spec, to compare against the contract | Teammate → Angel | Oct 29 |
| Real WhatsApp payloads (text, photo, voice, location pin, button tap) captured on the test number | Angel | Oct 30 |
| The pilot's WhatsApp number, and how judges try the product | Angel | Oct 29 |
| Organizer questions U1–U4, U6 and U7 | Angel → Discord | Oct 26 |
| Repository license, and when it goes public (right before submitting) | Team | Oct 26 |
| Decisions made since Oct 28 aren't in [decisions.md](decisions.md) yet | Angel → Claude Code | Oct 28 |
| Product and team name: "Johan AI" is a working title | Team | Oct 27 |

## Traps

- Migration numbers: Angel's side uses 0003–0019, kercmari's 0020–0039 (proposed in #6). PR #62 still uses 0003–0005;
  renaming a migration after it ran remotely makes wrangler run it again. Settle before any remote apply.
- `test/secrets.test.ts` lists every migration by name: every branch that adds one conflicts there.

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
