# Status

Shared state for every agent: what's true now, what's next, what's open, what bit us. Keep it short. Anything a
command can tell you (git log, test results, CI) doesn't belong here. Decisions go in [decisions.md](decisions.md).

Last updated: Fri Oct 30, 2026, evening Honduras time, by Claude Code (E7: docs for the order engine chain, no code).

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
- K2b (Nov 2, `claude/engine-facts`, local D1 only, not deployed): every order transition is also exactly one fact in
  the same batch (`order_version`, `order_confirm`, `order_cancel`, `order_status`), under the operation's own key;
  `orders` is the read cache and keeps `version_fact_id` / `confirm_fact_id` (`0023_order_facts.sql`). P1 is
  kind-aware (customer facts need an `inbound_message`, staff taps exactly one `member`). `verifyClaims` answers from
  fact liveness and `domain/order-state.ts`. Liveness rule: a fact superseded by one of its own ancestors does not
  kill it (v2 depends on and supersedes v1 and stays live; v1's confirm dies). Staff-tap fact commits carry a post
  guard (P1), so `saveConsoleAction` (PR #63) must run post guards before staff taps work there. Not built: the
  `session` evidence (MemberContext has no session id) and the order code `#Codigo`.
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

- K12, change requests (Nov 3, `claude/change-requests`, local D1 only, **not deployed**): after `confirmado`, a
  customer's change is a `change_request` fact on the live confirm (key `chg:<order>:<job>`); owner or staff answer
  in Pedidos with Aprobar ✓ / Rechazar ✗ and a required reason (`change_review`, key `rev:<request>`). Approve
  writes the new version (superseding the old, resting on the review) and its confirm in the same batch; decline
  closes the request. Window: `confirmado` and `preparando` (Q1 default). Migration `0024_change_requests.sql`
  rebuilds `facts` with `change_request`, `change_review` and `receipt_review` (K14). The contract additions are
  Proposed in [contract.md](contract.md) and need Angel's OK before merging. The Pedidos buttons call the engine
  but, like every console tap on this branch, nothing saves until `saveConsoleAction` (#63) runs the commits.

## Next

| # | Task | Owner | Notes |
|---|---|---|---|
| 1 | Spec meeting: agree contract v1 and its open questions | Both | [contract.md](contract.md#open-for-the-meeting) |
| 2 | PR `claude/base-layer` into `main` on the team repo | Angel | Merge commit, not squash |
| 3 | Engine on the contract, saving through `JobOutcome.commits` | Teammate | Order engine wired to text jobs through the fixture adapter (T6b); the console still runs the pretend engine |
| 4 | Console login (invite QR, sessions, roles), then a deploy | Angel (Claude Code) | PR #61; the deploy needs `LINK_SIGNING_SECRET` set first |
| 5 | Replies and the claim check; perception for customer orders | Angel (Claude Code) | Against the contract fixtures |
| 6 | The two-minute "te respondemos en un momento" fallback | Angel (Claude Code) | Specified, not built |

Gate: Saturday Oct 31, 8:00 PM Honduras time. A customer order runs end to end on fixtures through the engine, and
staff use the preparation list on their own phones. If the console can't pass, it is cut and the scope replanned.

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
| K12 contract additions (`review_change`, `change_approved`, `change_declined`, `OrderView.openChangeRequest`, `OrderView.lastReview`) are Proposed and need Angel's OK | Angel | Nov 3 |
| D-41 (fact memory under `Commit`) and D-42 (read before every guard) are Proposed and need Angel's acceptance | Angel | Oct 30 |
| D-43 (customer cancel refused once preparando; re-confirm returns to the interrupted state) and D-44 (operation keys derived from the customer's own order and action) are Proposed and need Angel's acceptance | Angel | Oct 30 |
| Issue #12: `preparationList`, `verifyClaims` and the console taps are not built | Teammate | Oct 30 |
| Order engine is wired only through the fixture perception adapter (T6b); `dev:sim` and `simulate` not run | Teammate | Oct 30 |
| Perception questions (ambiguous size, missing fulfillment) not asked; unit prices null, so totals null | Teammate, with Angel's perception | Oct 30 |
| Order tables lack some guards: no FK between order tables, no version-immutability trigger, no partial UNIQUE for one open order, `facts.operation_key` has no FK to `operations` | Teammate | Oct 30 |
| `operations` rows do not store `customer_id`; ownership is checked through the order instead | Teammate | Oct 30 |
| Trace shas for T1 to T5 and T7 (e.g. `137ec35`, `6c92127`) are on `claude/fact-memory`, not on `claude/fact-ledger`; the same work is committed here under other shas | Team | Oct 30 |

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
