# Status

Shared state for every agent: what's true now, what's next, what's open, what bit us. Keep it short. Anything a
command can tell you (git log, test results, CI) doesn't belong here. Decisions go in [decisions.md](decisions.md).

Last updated: Mon Nov 2, 2026, night Honduras time, by Claude Code (latency lane).

## Now

- **Planner (Nov 2, D-45 to D-51, behind `CONVERSATION=planner`, default `classic`):** a second Muse Spark call per
  burst decides the next step from two instruction files (`src/application/planner/instructions/`); code checks it
  (`src/domain/planner/validate.ts`), the readiness gate (`src/domain/readiness.ts`) has the last word, and the
  pretend engine applies the plan. Simulator: `npm run dev:sim -- --ai --store --planner`. Retrieval is L1's over
  the whole catalog, widened by other names the reader proposes ("catsup" → "ketchup"; no spelling table); a
  confirmed order proposes learned aliases for its planner picks, approved in Pendientes; weighed items read back in
  pounds. The real engine runs classic until it has what contract.md "Proposed (Nov 2): planner" lists. The flag
  flips only when the eval suite (lane L2) says the planner path is at least as good with zero truth failures.
  The independent review's nine findings (Nov 2) are fixed with a failing-then-passing test each
  (`test/planner-review.test.ts`, and the alias batch in `planner-flow.test.ts`); the planner's sentence is now one
  of a fixed list of phrases (`SAY_PHRASES`), never its own text. A text-only burst is read and planned in one call
  (D-52, on by default in planner mode): 10–15 s receipt→reply live, same outcomes as two calls; the 10 s bar is
  still not met. Photo captions now reach the reader. After the head-to-head eval (Nov 3): a "which one" answer
  (number, price, brand) is read by code and the same list is never asked a third time (E19, E09b); a voice note
  takes the same one call as typed words (E21); "me manda una" after a product question orders that product
  (E11); the eval runner writes all.md and results.json again, keeps a failed scenario's transcript and retries a
  dropped socket once (E22 passes). Re-run of E09b, E11, E19, E21, E22 on the planner path: 4 of 5 pass; E21's
  recording is a store owner's sales report ("Vendí tres refrescos…"), read as no order whether spoken or typed,
  so its expectation needs another recording or a decision.
- **Planner-path latency (Nov 2, [handoff](handoffs/2026-11-02-latency.md)):** each call now sends its own reasoning
  effort and a prompt-cache key per instruction version. Planner-path defaults: reader `low`, planner `minimal`
  (`READER_REASONING_EFFORT`, `PLANNER_REASONING_EFFORT`; the classic reader keeps the model's own). On the fixed
  4-input set, a text message went from about 30 s to about 13.6 s from receipt to reply, a short photo list from 37 s
  to 15–16 s, an 11-item photo list from 90 s to 25–32 s. Not under the 10 s bar: two calls plus the ~4.3 s burst wait
  can't get there. Next lever: a one-call path for text-only bursts (described in the handoff, not built). L2's
  eval must rerun at these efforts before the flag flips.

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


## Engine side, as merged on team main (kercmari, PRs #62 and #64)

Kept as written on `main`. In this merge the default `jobHandler` is the order handler with Muse Spark reading (the fixture perception adapter is no longer wired in); `OrderEngine` is in the code and plugs in at the composition root's engine line once it has `preparationList`, `verifyClaims` and the store's prices.

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
  - The console's preparation list, on an in-memory pretend engine. Console login (#22) is in PR #61
    (`claude/console-login`).
- Fact memory is plumbing under the engine (#11), not a deliverable of its own: the ledger migration `0020_ledger.sql`,
  `FactCommit` in `domain/facts.ts`, `D1FactLedger.statementsFor` turning one into a `Commit` (D-41), post-guards that
  the fence now runs inside the batch, cancellation as compensating movements, and the dependency gate G4. On local D1
  only, **not deployed**. The chain's trace records T1 to T5 as PASS.
- The order engine (issue #11) is built on local D1 only, **not deployed**, wired into the composition root only through
  the fixture perception adapter (T6b, below). Its E1 to E3 trace lines (E1, E1b, E2, E2b, E3, e3-engine-orders-fix1, e3-engine-orders-fix2) are
  all PASS. What it does: a burst becomes one versioned order (`onBurst`); each saved decision is anchored by an
  operation key derived from the customer's own order and action (D-44); every decision reads first (D-42); the
  customer can confirm, cancel and remove a line, and a re-confirm after a change returns to the state the change
  interrupted (D-43). One open order per customer (D-39) holds. What it does not do: `preparationList`,
  `verifyClaims` and the console taps (issue #12, out of this cut); `correct_order`, `accept_saved_place`,
  `accept_substitute`, `payment_receipt`, `stop`, `clarification` and `customer_name` return nothing and save nothing;
  it asks no perception questions (ambiguous size, missing fulfillment); unit prices are always null, so totals are
  null, and availability is always `no_se`. Verified by 238 tests on local D1 (26 files). `npm run dev:sim` and
  `npm run simulate` were **not run**, so the order flow is "tests on local D1", not end to end.
- T6b (Oct 31): a WhatsApp text job now reaches the order engine through the default `jobHandler` in
  `composition.ts`, and the engine's commits save in the job's own completion batch (D-37). The handler is
  `src/application/engine/fixture-perception-handler.ts`: fixture perception adapter: replaced by the teammate's
  perception when it lands (D-37). It reads only a few Spanish words in a text message (a pedido, "confirmar",
  "cancelar") and maps them to the contract fixtures; `customerId` is the conversation id until a customers table
  exists. Anything else (photo, voice note, unreadable text) falls through to the placeholder. Verified by
  `test/wire-engine.test.ts` on local D1: a failing commit guard leaves no order, no engine reply and a job that is
  not done; order -> readback -> "confirmar" saves one order and one confirmation reply, and a repeated "confirmar"
  adds nothing. Suite: 27 files / 255 tests. Not deployed.
  **The Saturday 8:00 PM Honduras gate is NOT met without real perception.** Missing:
  - real perception for photo -> draft (the fixture adapter reads words, not photos or voice)
  - `dev:sim` / `simulate` not run for this flow
  - issue #12's console taps, `preparationList` and `verifyClaims`
  - issue #60's supplier invoices (the receipt handler stays unwired)
  - console login and a deploy, so staff use the preparation list on their own phones (not deployed)
- Every guard now has a read before it that answers the owner, with the guard left as the backstop
  for a race (D-42): a used operation key reads as `duplicate`, a stale draft revision as
  `rejected`/`stale_version`, a cancelled dependency as a rejection carrying the dead ids. A guard
  that fires after a clear read is a real race, and `processor.ts` retries it.
- The supplier-invoice receipt handler has its own tests but is **not wired into the composition root**, and has not
  been run through `npm run dev:sim` or `npm run simulate` (port 8787 was busy on Oct 30). Its chain task is recorded
  as **FAIL** in the trace, and the work is now issue #60, a cut-candidate. The handoff task is recorded as
  **BLOCKED**: it could not open a PR.
- Spikes are done (handoffs in [handoffs/](handoffs/)): Muse Spark reads invoices and orders with structured output;
  voice transcription 6/6; voice notes decode to WAV inside the Worker.
- Two independent reviews of Tech Spec v3 (Oct 30) both said "build with changes". The contract draft takes in their
  fixes for line references, multi-part messages, staff-only kinds, confirmed prices and the claim check.

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
- At the model's own reasoning effort, the planner once reasoned past its 6,144-token cap on an 11-item list (59 s, cut
  off, classic fallback). Keep `PLANNER_REASONING_EFFORT` at `minimal` or `low`. Reader `minimal` misread "5 consome"
  as a product name; `low` is the floor.
- A photo's caption never reaches the reader: `resolveBurst` (`order-reading.ts`) sends only the image for photo jobs.

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
- Eval detectors: a readiness claim needs a present-tense predicate on the pedido ("está listo") — the classic
  confirmation opens with "Listo, \<name\>" and promises "te aviso cuando esté listo" (subjunctive), which is the
  opposite of a claim. Money mentions must be backed by per-step order snapshots, not just the final order, or
  mid-run totals read as lies after an unpriced line lands.
- `npm run eval` must survive a scenario error with a transcript: one crashing scenario once took down the whole
  run's `all.md`/`results.json` (E22).
- Inside workerd, timers don't advance during synchronous work, so measure CPU-heavy code elsewhere.
- This machine restricts unprivileged user namespaces, so bubblewrap sandboxes can fail to start: Codex warns but
  still runs read-only commands; Muse may refuse shell commands. See [workflow.md](workflow.md#muse-code).

## Done

Feature-level milestones only (M1–M12 from the plan), one line each, as they land.
