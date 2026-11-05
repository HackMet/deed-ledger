# Status

Shared state for every agent: what's true now, what's next, what's open, what bit us. Keep it short. Anything a
command can tell you (git log, test results, CI) doesn't belong here. Decisions go in [decisions.md](decisions.md).

Last updated: Thu Nov 5, 2026, late morning Honduras time, by Claude Code.

## Now

- **Public demo (`claude/public-demo`, D-61, not deployed):** `/demo` opens a synthetic store per visitor with a
  customer phone beside the console. Deploying needs migration `0032_demo_stores.sql` applied to the remote D1 first.
  Tested locally with the real models (Nov 5): text → readback → Confirmar → name → the console's "To prepare";
  the preset photo and voice note read in fresh stores. D-62 adds the limits and fixes. **To test it by hand, use
  `MODEL_API_KEY=… node scripts/demo-test-server.mjs`** (frozen copy on :8795, fresh database, minute sweep), never
  a `wrangler dev` on a worktree an agent is editing: a save restarts the server and drops the reply in flight.
  The console's order cards now show the name the customer gave (`OrderEngine.preparationList` left it null).
  Open: the phone shows a reply before the dispatch's claim check, so a reply the check blocks would still show
  its original text there.

- **Ask before confirm (`claude/flow-ask`, D-58 proposed, not deployed):** on `OrderEngine`, a missing quantity, an
  illegible line or no pickup or delivery is asked before an order confirms, and staff close an order stuck at `listo`
  with Entregado. A typed word answers the customer's last readback only while that order is the open one; otherwise
  it is read like any other message. Not covered: a change request after confirming can still add a line with no quantity, for staff to
  approve or decline. An illegible line is asked as `illegible` once, then as `quantity`, since nothing stores the issue.
  A list with a part unread is asked once too: the next message that changes nothing gets the readback, or the line's
  question while a line still waits. Exceptions: instructions found in a message stay out of scope, a handoff stays a
  handoff, and an empty answer to a list with no fulfillment gets the pickup question first.

- **Integration (`claude/integration`, PR #71, Nov 4, not merged):** `claude/deed-core` + `claude/deed-recheck` +
  `claude/demo-fixes`. Gates and open items are in the PR.
  - **C3 met, with known limits in the README.** Its last review passed after more fix rounds than Kerly authorized,
    because `track.sh` relaunched the chain; those scripts are now disabled. The two findings closed only by the demo now
    have tests under `npm test`: `test/node/deed-recheck-command.test.mjs` and `test/node/demo-verdicts.test.mjs`.
  - **C10 met, with known limits in the README.** One Opus review gave PASS after the fix for the blocking
    disagreement. Open for Kerly: any kind can close any kind, and a policy can't require a dependency or a closure.
    Handoff for Angel's agents: `docs/handoff-pr-71.md`.
  - **`claude/demo-fixes` goes in only through this PR.** Its reviews and their fixes are in the PR. Codex was not run: it isn't installed here.
  - **Answers to customer messages in the demo are templates;** notices after a staff tap are the product's. "Le pasé tu cambio…" exists only there. Real WhatsApp doesn't say it, so it
    stays out of the video.
  - **Decided (D-55, D-56):** the contract additions are accepted, and C11's code stays invisible. Angel also says the
    customer doesn't need the quantity shown while a change waits, so the `statusReply` diff is dropped.
  - **C11 stays partial:** the Libro shows each reply's WhatsApp ID, the search is a POST, and the order notices resolve. The owner's words from Pendientes
    and a safe reply don't (`docs/handoff-pr-71.md`, item 10).
  - **Short stock (D-57 proposed):** a short line asks "¿Te mando 2 o lo quitamos?", and its written answer makes a new version the customer confirms. An unreadable answer asks again. An order with nothing to prepare can't be confirmed. Still open: a typed "confirmar" under the stock question commits the full amount.
  - **Waiting on Angel:** append-only triggers in the store's migrations (C5), `saidName`, and the real order with Muse.
    stays out of the video until Angel matches it.
  - **Waiting on Angel:** the `statusReply` copy for a pending change, not committed; append-only triggers in the
    store's migrations (C5).
- **Deed en vivo (`claude/deed-live`, Nov 4):** a console screen, `/console/deed/en-vivo`, in Más for owner and staff:
  the graph of the order with the newest activity (or one picked with `?pedido=`), above the store's newest checks,
  refreshing every 3 seconds with the feed's meta refresh and no script. "Historial del pedido" now also shows on
  `PlannedDeedEngine`: the `instanceof OrderEngine` check hid it on the deployed config.
- **Deed en vivo redrawn (`claude/deed-graph-look`, Nov 4):** left to right, each fact a state node (EN DUDA, HECHO, CERRADO, BLOQUEADO) with the agent above and the confirmation below, from real evidence only. No evidence kind records a WhatsApp delivery, so that label never shows.
- **On top of PR #71 (Nov 4):** the planner on the Deed engine (below), one product list (`CatalogService` the
  only writer, the same ID in `products` and `store_products`, migration `0031`), the console's new look (Inicio,
  five tabs, Pendientes as the one inbox), long price pastes saved 25 products per batch, and the demo runner
  closing each connection. Review fixes: staff see delivery totals with the fee, the planner path reads stock, and
  the planner quotes only confirmed prices. Eval on the combined copy: 28/31, zero truth failures.
  - **After this deploy (Angel):** in Productos, tap "Confirmar precio" on each demo product. A price typed in the
    old Tienda screen has no price fact, so the bot treats it as unknown until it's confirmed. Then one real order
    from a phone: order, readback, Confirmar, Listo, "listo".
- **Planner on the Deed engine (`claude/planner-on-deed`, on top of PR #71, Nov 4, uncommitted):** closes the handoff's
  known gap 1. With `DEED_ENGINE=1` and `CONVERSATION=planner` the app runs `PlannedDeedEngine` (D-59, proposed): the
  planner's conversation per customer in `planner_memory` (migration `0030`, additive), `OrderEngine` as the only writer
  of orders through one new entry, `onDecidedChange`. Classic on the Deed engine is unchanged. Simulator:
  `npm run dev:sim -- --ai --store --planner --deed …`, then `npm run eval -- --planner --deed …`. Under `--deed`,
  E14, E16, E16a and E16b add the owner's approval (K12) instead of a second Confirmar. Eval on the Deed engine
  (Nov 4): 25/32 and 27/32, zero truth failures. E02 and E04 failed the first run only on a stale expectation
  («acabo»; the copy says "ahorita no hay" since 9ca625a), fixed before the second. E08b and E11 fail the same way
  on the pretend engine at the same code; E21's expectation is known wrong; E16b in the second run hit the sim
  store's US$2 daily model cap.
  - **Open for Angel:** after a change on a confirmed order, the ledger saves a K12 request, but the planner's
    phrase still says "Va, le agrego eso." before "Vas cuarto en la fila…". It reads as done while it waits for the
    store (same gap as the pending `statusReply` copy).
- **Deed core (`src/deed-core/`, in PR #71):** the fact batch lives in `src/deed-core/d1-store.ts`. The store's evidence
  rules are policy data (`src/domain/store-policy.ts`), its drafts and stock a host extension
  (`src/infrastructure/d1/store-extension.ts`) (D-53, D-54). The store's tables keep their kind CHECKs: they are the
  host's schema, not the core's. In the store, `facts` and `fact_evidence` are append-only by code path only; the core's
  `schema.sql` enforces it with triggers.
- **Auto-deploy works (Nov 3):** every merge to main tests and deploys the demo (`.github/workflows/deploy.yml`);
  the first run after #63 passed once the repo secrets were set. Repo moved to `HackMet/deed-ledger`.
- **Customer copy fixes (branch `claude/customer-copy-fixes`, from a live photo test):** "out of stock" now reads
  "ahorita no hay X" (was "no nos queda calabacitas", wrong for plurals); the ready notice joins "sin a, b ni c";
  an item still without an amount is never listed under "Anotado ✅" (it read as settled, and "Tomate 1 lb" as a
  chosen pound): it goes in "Me falta saber cuánto querés de…". Still open from that test: two sold-out notices
  and "listo" arrive as three messages in six seconds; a photo takes about 34 seconds with nothing in between.

- **Live (Nov 3):** deployed to Cloudflare Workers on Meta's WhatsApp test number, store "Tienda demo (sintética)"
  with a synthetic 40-product catalog, `PRETEND_ENGINE=1`, `CONVERSATION=planner`, `TEST_COMMANDS=1`
  (docs/deploy.md). Tested end to end from a phone: order, readback with buttons and footer, Confirmar, name,
  staff Listo, the customer notice. Real WhatsApp voice notes have no Ogg end-of-stream page (#27 settled): the
  reader no longer requires it and downloads are checked against Meta's `sha256` and `file_size` instead.
- **Planner (D-45 to D-52, `CONVERSATION=planner`; default stays `classic`):** a Muse Spark call decides the next
  step from two instruction files (`src/application/planner/instructions/`); code validates every proposal
  (`src/domain/planner/validate.ts`), the readiness gate (`src/domain/readiness.ts`) has the last word, and the
  pretend engine applies the plan. Text and voice are read and planned in one call (`one-call.ts`); photos take two.
  Whole-catalog retrieval with reader-proposed other names; learned aliases proposed inside the confirmation batch
  and approved in Pendientes; the planner's sentence is one of fixed phrases (`SAY_PHRASES`). Effort: reader `low`,
  planner and one call `minimal`, prompt-cache keys per instruction version. Live: 4–7 s per model call, 9–13 s
  receipt to reply (3 s of it is the deliberate burst wait).
- **Evidence:** head-to-head eval (Nov 3, `npm run eval`): planner 27–28/32, classic 12–16/32, zero truth failures
  on both; the planner failures since fixed (option-list loop, voice like text, "una" after a question, runner
  crash, E22). Two Codex reviews, every finding fixed with a failing test first. E21's recording is an owner's sales
  report, not an order: its expectation needs a real customer voice order.
- **Codex final pass, Nov 3:** six findings fixed, each with a failing test first: a quantity or removal names a
  line only when the words tell it apart from the other lines; `/new` keeps inbound provider IDs (duplicates) and
  erases only the media up to its cutoff; only an affirmative answer picks an option, read against the list as shown
  (stale prices name nothing); a voice note without a usable `sha256` or `file_size` is retried as `unverified`.
- **Test commands:** `/new` makes a store member's phone a new customer again, `/help` lists the commands; only with
  `TEST_COMMANDS=1` and only for the store's own members (docs/deploy.md "Testing on the live number").
- **Next:** push to PR #63 (Angel), Kerly tests with her number, a real
  WhatsApp number for judging, demo video and submission.

- The product is an order assistant: customers order on WhatsApp, Johan and staff work from a phone console, and
  both end in the same engine. Two-person team (D-37): Angel owns conversations, perception, replies, the console
  and deploys; kercmari owns the engine (orders, payments, sales, fiado, stock, prices, fact memory).
- Built on Angel's side, against the in-memory pretend engine (handoffs `handoffs/2026-10-31-*.md`):
  - customers (#14–#16), the full order trip (#17), console taps that message the customer (#18);
  - Spanish replies, the claim check and reply buttons (#19, #20); reading orders with Muse Spark (#21);
  - console login (#22, PR #61) and shell with Empleados (#23); the Anotar reader (#26);
  - media download, voice notes decoded and transcribed, both read in orders (#27). Settled Nov 3: real WhatsApp
    voice notes have no Ogg end-of-stream flag, so the decoder no longer requires it; a cut-off download is caught
    instead by checking the bytes against the `sha256` and `file_size` Meta declares (retried like a timeout).
    Both real notes decode locally (about 9.0 s and 7.9 s); not yet tried on the deployed bot;
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

- K12, change requests (Nov 3, `claude/change-requests`, local D1 only, **not deployed**): after `confirmado`, a
  customer's change is a `change_request` fact on the live confirm (key `chg:<order>:<job>`); owner or staff answer
  in Pedidos with Aprobar ✓ / Rechazar ✗ and a required reason (`change_review`, key `rev:<request>`). Approve
  writes the new version (superseding the old, resting on the review) and its confirm in the same batch; decline
  closes the request. Window: `confirmado` and `preparando` (Q1 default). Migration `0024_change_requests.sql`
  rebuilds `facts` with `change_request`, `change_review` and `receipt_review` (K14). The contract additions are
  Proposed in [contract.md](contract.md) and need Angel's OK before merging. The Pedidos buttons save through
  `runConsoleAction` (#63), post guards included, since `claude/demo-on-main`.
- K13, dispatch (Nov 3, `claude/dispatch`, local D1 only, **not deployed**): a ready delivery order is dispatched
  from Pedidos with a courier picked from the store's active members (`en_camino`, blue, the courier's name in the
  row and the trail), then marked delivered; pickup goes `listo → entregado`. Each step is an `order_status` fact
  resting on the one before; a `null` fulfillment is refused, and the customer can't cancel once it is on its way.
  Migration `0025_dispatch.sql` widens `orders.state`. The contract additions are Proposed in
  [contract.md](contract.md) and need Angel's OK; as with K12, taps save through `runConsoleAction` (#63).
- K21 and K20 (Nov 3, `claude/deed-on-main`, from `claude/owner-on-main`, local only, **not deployed**):
  - K21: `OrderEngine` gives Angel's reader `perceptionContext` and `catalog`. The catalog comes from our `products` table, not `store_products`.
  - K21: with `DEED_ENGINE=1` the app runs on `OrderEngine`, and the Muse reader reads through it. `wrangler.jsonc` sets the flag to "1", so a deploy runs on it with nothing else to set; the simulator and the tests set "0". `plannerContext` is not built, so the planner conversation mode can't run on it yet.
  - K20: every refusal and claim check the engine makes is recorded in `deed_checks` (migration `0027`, append-only, IDs and codes only).
  - K20: `/console/deed/<order>` shows the order's facts as a graph, and `/console/deed/verificaciones` shows the feed.
  - Measured: 84 files / 1192 tests pass and `./demo.sh` gives 29/29.
- K6, K15 and K14 on main (Nov 3, `claude/owner-on-main`, from `claude/demo-on-main`, local only): Productos,
  Mi tienda (`/console/negocio`) and Facturas are registered in `console/index.ts`; the invoice upload sets its own
  size limit there, like Anotar. Those three screens still draw their own pages, not the shared layout, and "Más"
  doesn't link them yet. Productos overlaps #40's Tienda (products and prices): which one the owner uses is open.
- K14, supplier invoices (Nov 3, `claude/facturas`, local D1 only, **not deployed**): the owner uploads an invoice
  photo at `/console/facturas/nueva` (≤ 10 MB, JPG/PNG/WEBP by its bytes; PDF refused with a Spanish message, no PDF
  library), stored through `putImmutable`. It is read through the `ReceiptReader` port, today only by
  `RecordedReceiptReader` (synthetic fixtures by SHA-256); every other photo is refused as unreadable. The draft
  matches each line by exact name or known alias (no alias table yet, so names only) or marks it "nuevo"; edits bump
  the revision; Aprobar ✓ is one guarded batch (new products, `receipt` fact with member + photo evidence and the
  revision, movements, balances); Rechazar ✗ is one `receipt_review` fact with the reason; "Anular factura" is a
  `cancellation` with compensating movements, refused when stock already left. Migration `0026_console_receipts.sql`
  rebuilds `drafts` for console uploads. **Pending:** the Muse Spark adapter waits on PR #63 (`MuseSparkProvider`)
  and decision Q2; its prompt draft is [prompts/receipt-reading.md](prompts/receipt-reading.md), for Angel's review.

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
| D-57: the `inStock` contract fields and the short-stock copy; whether the preparation list should show a sold-out line differently; `stock_balances` has no unit, so "2 cajas" is compared as 2 | Angel | Nov 4 |
| Product and team name: "Johan AI" is a working title | Team | Oct 27 |
| K12 touched two of Angel's files: `src/domain/copy.ts` gains the owner-facing copy `CHANGE_AFTER_READY` (new copy, not compile-only), and `test/secrets.test.ts` lists `0024_change_requests.sql` (compile-only); both need Angel's OK | Angel | Nov 3 |
| K21 touched Angel's files: `config.ts` (`deedEngine`), `wrangler.jsonc` (`DEED_ENGINE: "0"`), `worker-configuration.d.ts` (regenerated) and `composition.ts` (engine choice; the Deed checks recorder). Whether to turn `DEED_ENGINE` on is his call | Angel | Nov 3 |
| K20 adds migration `0027_deed_checks.sql` and lists it in Angel's `test/secrets.test.ts` (compile-only) | Angel | Nov 3 |
| K14 Muse Spark receipt reader: needs PR #63's `MuseSparkProvider` and Q2; prompt draft in [prompts/receipt-reading.md](prompts/receipt-reading.md). K14 touched Angel's `test/secrets.test.ts` (lists `0026_console_receipts.sql`, compile-only) and `LogFields` (`draftId`) | Angel | Nov 3 |
| K13 touched Angel's files: `memory-engine.ts` gains `case "dispatch"` returning null like `match_line` (compile-only), `copy.ts` gains `CANCEL_AFTER_DISPATCH` (new copy), `test/secrets.test.ts` lists `0025_dispatch.sql`; a delivery order at `listo` can no longer be marked delivered from Preparación (it needs a dispatch first) | Angel | Nov 3 |
| D-41 (fact memory under `Commit`) and D-42 (read before every guard) are Proposed and need Angel's acceptance | Angel | Oct 30 |
| D-43 (customer cancel refused once preparando; re-confirm returns to the interrupted state) and D-44 (operation keys derived from the customer's own order and action) are Proposed and need Angel's acceptance | Angel | Oct 30 |
| Issue #12: `preparationList`, `verifyClaims` and the console taps are not built | Teammate | Oct 30 |
| Order engine is wired only through the fixture perception adapter (T6b); `dev:sim` and `simulate` not run | Teammate | Oct 30 |
| Perception questions (ambiguous size, missing fulfillment) not asked; unit prices null, so totals null | Teammate, with Angel's perception | Oct 30 |
| Order tables lack some guards: no FK between order tables, no version-immutability trigger, no partial UNIQUE for one open order, `facts.operation_key` has no FK to `operations` | Teammate | Oct 30 |
| `operations` rows do not store `customer_id`; ownership is checked through the order instead | Teammate | Oct 30 |
| Trace shas for T1 to T5 and T7 (e.g. `137ec35`, `6c92127`) are on `claude/fact-memory`, not on `claude/fact-ledger`; the same work is committed here under other shas | Team | Oct 30 |

## Traps

- Migration numbers: Angel's side uses 0003–0019, kercmari's 0020–0039 (proposed in #6). PR #62 still uses 0003–0005;
  renaming a migration after it ran remotely makes wrangler run it again. Settle before any remote apply.
- `test/secrets.test.ts` lists every migration by name: every branch that adds one conflicts there.
- At the model's own reasoning effort, the planner once reasoned past its 6,144-token cap on an 11-item list (59 s, cut
  off, classic fallback). Keep `PLANNER_REASONING_EFFORT` at `minimal` or `low`. Reader `minimal` misread "5 consome"
  as a product name; `low` is the floor.
- A photo's caption never reaches the reader: `resolveBurst` (`order-reading.ts`) sends only the image for photo jobs.
- During `npm run eval`, don't edit `src/` (the simulator's `wrangler dev` reloads mid-conversation) and don't query
  the simulator's local D1 from another process: one `SQLITE_BUSY` in the Worker deferred a job past the eval's 45 s
  wait (E01a, Nov 4).

- Claude Code skips `AGENTS.md` in this folder unless `CLAUDE.md` imports it (`~/angel/CLAUDE.md` is above the
  repo). Keep the import.
- `muse --version` can start Muse's auto-updater. Use `MUSE_NO_AUTO_UPDATE=1` for quick checks.
- `META_API_KEY` in the shell makes Muse Code bill that key instead of the signed-in plan. The app uses
  `MODEL_API_KEY`.
- Muse's sandbox keeps `.git` read-only: it can't commit, so Angel commits its work.
- WhatsApp voice notes have to become WAV (mono, 16-bit, 16 or 24 kHz) before Muse Voice Transcribe accepts them.
- WhatsApp voice notes end without the Ogg end-of-stream flag (#27). Don't make the decoder require it again: a
  cut-off note is caught at download, against Meta's `sha256` and `file_size`. Meta's `sha256` encoding is
  undocumented; the download reads hex or base64. If every media download fails after a deploy, that check is the
  suspect: the log says only `media_not_downloaded` with reason `MediaDownloadError`, not the error's code.
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
