# Contract v1 (draft)

**Status:** draft for the spec meeting, Fri Oct 30. Not agreed yet. **Owners:** both.

The contract is the set of values that cross between perception, the engine and the console. Both sides build
against the types and the fixtures; `npm run typecheck` fails when a fixture stops matching a type.

| File | What it holds |
|---|---|
| `src/domain/contract/numbers.ts` | `DecimalString`, `Centavos`, `Thousandths`, exact conversion |
| `src/domain/contract/observation.ts` | What perception read from one burst: 15 kinds, evidence, issues, the context it's given |
| `src/domain/contract/actions.ts` | Customer taps and console actions, each with an operation key and an actor |
| `src/domain/contract/outcomes.ts` | Engine outcomes, the order view, customer notices, claims for the claim check |
| `src/application/engine.ts` | The `Engine` interface: bursts, actions, `verifyClaims`; results carry `commits` |
| `test/fixtures/contract.ts` | The PRD's first order, a change while packing, a two-part burst, an out-of-stock line, a stale tap |

## Rules the types encode

- **No IDs from the model.** Observations name products in the customer's words. Catalog matches (`LineMatch`) are
  found by code inside the store's scope and passed beside them. Evidence points at a message by its position in the
  burst.
- **Edits point at labels.** Perception gets the open order as labelled lines ("L1: Arroz 1 lb: 3") and the question
  the engine asked last. "Que sean 3 de azúcar" comes back as `set_quantity` on `L3`, or `ref: null` when no line
  clearly fits. The engine owns the labels: line N of the current version is "LN".
- **A burst can say several things.** "Agregale un jabón y lo paso a traer" is two observations, in order. The engine
  returns one outcome for the burst: the next thing to say.
- **Customers can't send staff work.** A customer burst only carries customer kinds; the engine refuses `sale_report`,
  `fiado_report`, `setup_card` and `supplier_invoice` from WhatsApp whatever perception said.
- **Unknown is `null`.** Quantities are decimal strings; money is integer centavos.
- **Only Johan's price reaches a customer.** A line's `unitPrice` is the confirmed price or `null`; an order's total is
  `null` while any price is unknown. A staff-proposed price waits in Pendientes.
- **A change after confirming goes back to the customer.** It makes a new version in `por_confirmar`, read back
  with Confirmar, Corregir and Cancelar; taps on the old version are refused, and the order keeps its place on the
  list. Confirmed again, it returns to `preparando` (or `confirmado` if nobody had started).
- **One open order per customer.** An order is open until `entregado` or `cancelado`; a new order message while
  one is open adds to it.
- **Every action has an operation key and an actor** from the session or conversation; order actions carry the
  version on screen. A reused key returns `duplicate` with the first outcome; a stale version returns `rejected`.
  Typed "confirmar" and the button share one key: `confirm:<order>:v<version>`. The engine derives the key from the
  action and rejects any other as `not_allowed`: `cancel:<order>:v<version>`, `remove:<order>:v<version>:<lineId>`.
- **The engine saves nothing itself.** It returns `{ outcome, notices, commits }`. For a customer message the commits
  run in the job's completion batch (`JobOutcome.commits`); for a console action, in one guarded batch.
- **The claim check runs twice.** Before the save, against the outcome (the records it names aren't saved yet).
  Right before sending, against the records through `verifyClaims` (a cancel may have landed since). Replies are
  fixed templates; the model writes no connecting words.

## Engine rules the contract assumes

- One receipt is one payment claim: bank and reference are unique per store.
- Every guard covers what the decision read: order version, role, price, PAUSA.

## Agreed (Oct 30)

- `clarification` and `customer_name` are kinds.
- Lines are matched to the catalog on the perception side (barcode, exact name, known alias) and by staff through
  `match_line`. The engine never guesses a product.
- Operation keys as above. The `operations` table is the single anchor for idempotency; the engine's facts reference
  it. A repeated key is answered from `operations` before any commit is built (`duplicate` with the first outcome);
  the UNIQUE rule only settles races.
- A `Commit` may carry `post` guards, checked after its statements in the same batch, so they can read what the
  statements wrote. One that doesn't hold rolls the whole batch back: no fact, no reply, the job stays open.
- `Commit` naming D1 types in the application layer is a decision (D-40), not debt.
- Tables use `business_id` (existing schema), not Tech Spec v3's `store_id`.

## Proposed (K12): change requests after confirming

Not agreed. Built behind these types on `claude/change-requests`; the PR can't merge until Angel accepts them (#5).
Angel renders the WhatsApp copy.

| Addition | Where | Status |
|---|---|---|
| `ConsoleAction` `{ type: "review_change"; changeRequestId; decision: "approve" \| "decline"; reason }`, owner or staff; reason 1–200 characters after trimming, stored as data; key `rev:<changeRequestId>` | `actions.ts` | Proposed (K12) — Angel to accept |
| `CustomerNotice` `change_approved { order }` ("Tu cambio fue aprobado: …") | `outcomes.ts` | Proposed (K12) — Angel to accept |
| `CustomerNotice` `change_declined { order, reason }` ("No pudimos hacer el cambio: <reason>") | `outcomes.ts` | Proposed (K12) — Angel to accept |
| `OrderView.openChangeRequest: { id; diff } \| null`, with `LineDiff { added; removed; changed: { before; after }[] }` | `outcomes.ts` | Proposed (K12) — Angel to accept |
| `OrderView.lastReview: { decision; reason; atMs } \| null` | `outcomes.ts` | Proposed (K12) — Angel to accept |

- Both `OrderView` fields are optional (`?:`), so views built before K12 (the pretend engine, the demo orders,
  the fixtures) still type-check unchanged; the real engine always sets them, `null` when there is none.
- A customer's change in `confirmado` or `preparando` no longer answers `order_changed`: the order stays as it is
  and the engine answers `order_status` with `openChangeRequest` set (the reply says it waits for the store). From
  `listo` on it answers `rejected`/`invalid_state`; the copy is `CHANGE_AFTER_READY` in `src/domain/copy.ts`.

## Proposed (K13): dispatch and internal delivery

Not agreed. Built behind these types on `claude/dispatch`; the PR can't merge until Angel accepts them (#5). Angel
renders the WhatsApp copy.

| Addition | Where | Status |
|---|---|---|
| `OrderState` `en_camino`: a delivery order out with a courier of the store, between `listo` and `entregado` | `outcomes.ts` | Proposed (K13) — Angel to accept |
| `ConsoleAction` `{ type: "dispatch"; orderId; version; courierMemberId }`, any active member (Q4); the courier must be an active member of the same store; key `staff:<order>:<version>:dispatch` | `actions.ts` | Proposed (K13) — Angel to accept |
| `CustomerNotice` `order_dispatched { order, courierName }` ("Tu pedido va en camino con <nombre>"); `courierName` is the store's name for the member, `null` when it has none | `outcomes.ts` | Proposed (K13) — Angel to accept |

- Every step is an `order_status` fact, no new kind: dispatch's body carries `status: "dispatched"` and
  `courierMemberId`, and it rests on the live confirm and the live `ready` tap; a delivery order's `delivered` rests
  on the confirm and the live dispatch. A pickup order's `delivered` rests on the confirm, as before.
- `dispatch` only for `fulfillment.mode = "delivery"` at `listo`; `mark_delivered` from `en_camino` (delivery) or
  `listo` (pickup). A `null` fulfillment is never guessed: `dispatch` answers `rejected`/`invalid_state`, and since
  D-58 `mark_delivered` closes it from `listo` with the fulfillment left `null`, on a person's word.
- A courier id that isn't an active member of this store answers `rejected`/`not_found` with the order.
- A customer's cancel (or change) from `en_camino` on answers `rejected`/`invalid_state`; the copy is
  `CANCEL_AFTER_DISPATCH` ("Ya va en camino; hablá con la tienda.") in `src/domain/copy.ts`.
- Migration `0025_dispatch.sql` rebuilds `orders` so its state CHECK admits `en_camino`.
- A review with an empty or too long reason answers `rejected`/`not_allowed` (the contract has no input-error reason).

## Open for the meeting

1. **Kerly's spec:** not read yet. Anything here that conflicts with it wins a discussion, not a default.

## Proposed (#29): delivery to a saved place

Angel's side, built against the pretend engine; not agreed yet. Our side owns the places (`customer_places`,
migration 0017) and the pin's coordinates; the engine owns the order's fulfillment. Optional fields keep both sides
compiling until this is agreed.

1. **`OrderView.fulfillment` delivery gains `pin`.** `pin?: { latitude: number; longitude: number } | null`, a shared
   WhatsApp location from the webhook (never the model). Today it's optional in `outcomes.ts`; agreed, it becomes
   required (`null` for none). The readback says "Te lo llevamos a la ubicación que nos mandaste." and the
   preparation card links to a map. Everything else in the variant is as is: `placeText` as the customer wrote it,
   `placeId` when a saved place was accepted, `fee` from store settings.
2. **`CustomerContext.savedPlace: SavedPlace | null`**, with `SavedPlace = { placeId: string; placeText: string |
   null; pin: Pin | null }` (`src/domain/place.ts`). Our side reads the customer's newest used place and passes it in
   (local today as `CustomerContextWithName.savedPlace`). The engine may offer it, never apply it: when an order is
   delivery with no place, it asks `same_place` if a saved place exists and the customer hasn't declined it for
   this order, otherwise `delivery_place`.
3. **`decline_saved_place` (& `OrderRef`)** joins `CustomerAction`: "Otro lugar". The engine asks `delivery_place`
   and doesn't offer the saved place again for that order. `accept_saved_place` stays as is; the engine must refuse
   a `placeId` that isn't the context's `savedPlace.placeId` (`not_found`), and an order not in `armando` with
   delivery (`invalid_state`).
4. **Button keys:** `place:<order>:v<version>:<placeId>` (Sí, `accept_saved_place`) and
   `otherplace:<order>:v<version>` (Otro lugar). The button ID is the operation key, as with `confirm:`. Typed
   answers ("sí", "otro lugar", an address) go through perception as `clarification` or `fulfillment` with the
   pending question `same_place` or `delivery_place`.
5. **Engine rules for `fulfillment` observations:** `mode: "pickup"` drops any place (a place is used for delivery
   only); a `pin` or `placeText` makes the order a delivery to that place; `sameAsBefore` uses the saved place only
   when one exists; `mode: null` with no place changes nothing. A `clarification` answering `same_place` is a yes
   only when it clearly says so (`isYes` in `src/domain/place.ts`); anything else is Otro lugar. A `clarification`
   answering `delivery_place` is the place in words.
6. **Fee:** `fee` comes from store settings (#40) only, `null` when none is set, and is never part of `total`. The
   pretend engine takes it from the store's setup (#40, our stand-in), `null` when unset. The readback shows "Envío: L X, aparte del total." only for a
   fee above zero.
7. **Saving a place is ours:** on `order_confirmed` for a delivery order, the order handler saves the place in the
   job's batch (new place: one row per order ID, updated if the order is confirmed again; accepted saved place:
   marked used). No engine call is needed. Open question: does the engine also want the place in its own records?

## Proposed (#47): customer questions

**Status:** proposed by Angel's side, not agreed. Built against the pretend engine only. The types below are already
in `src/domain/contract/outcomes.ts`, marked "Proposed (#47)"; they are additive (no existing type changed).

1. **Question products are matched like lines.** For a `question` observation, a `LineMatch` with
   `observation: i, line: n` points at `products[n]`. Code matches (exact name, known alias, barcode); a product
   the code can't match has no `LineMatch` and is unknown. A question may drop one leading article ("el arroz")
   only when the words as said match nothing; a tie stays unmatched. The model never supplies a product ID.
2. **`price` and `availability` questions return the existing `answer` outcome,** one `AnswerFact` per entry of
   `products`, in order, `asked` = the customer's words:
   - `productId`: from a `LineMatch` only, else null.
   - `unitPrice`: Johan's confirmed price (#36), else null. Never a proposed price. Null for restricted products.
   - `availability`: from evidence (#37): `hay` only with recent evidence, `se_acabo` after No hay, else `no_se`.
     `no_se` for an unmatched or restricted product.
   - `restricted`: the product is alcohol or tobacco.
   - Customers hear: "Arroz: sí hay." / "Leche: ahorita no hay." / "Pan: te lo anoto y te confirmo." and
     "El arroz: L 18." / "Pan: el precio te lo confirmo." Restricted: "eso solo lo vendemos aquí en la tienda."
3. **New outcome for store hours (gap f):**

   ```ts
   export interface StoreHoursEntry {
     readonly days: readonly number[]; // ISO weekdays, 1 = Monday … 7 = Sunday
     readonly opens: string;           // "HH:MM", 24-hour, store local time
     readonly closes: string;          // later than opens; past midnight isn't expressible yet
   }
   export type StoreHours = readonly StoreHoursEntry[];

   // EngineOutcome gains:
   | { readonly type: "store_hours"; readonly hours: StoreHours | null }
   ```

   `hours` comes from store settings (#40); unset is `null`, never a default. A day in no entry is closed; no day
   appears in two entries. Customers hear "Abrimos de lunes a sábado de 7 a. m. a 7 p. m., y el domingo de 8 a. m.
   a 12 del mediodía." or, when null or unreadable, "El horario te lo confirmo."
4. **New claim:**

   ```ts
   // Claim gains:
   | { readonly type: "store_hours"; readonly hours: StoreHours }
   ```

   `verifyClaims` answers true only when the store's hours now are exactly these (same entries, same order).
   `unit_price` and `availability` claims need `verifyClaims` support too: true only while the confirmed price,
   or the availability from evidence, is still the one claimed. Until then those replies go out as the safe reply.
   Proposed (D-57): the order engine answers `availability` from `stock_balances`, and an optional `inStock` on the
   claim, with `OrderLineView.inStock`, holds only while the balance is exactly that amount.
5. **Topic routing in the engine:** `order_status` → `order_status`; `price`/`availability` → `answer`;
   `store_hours` → `store_hours`; `other` → `out_of_scope` (the short redirect); `balance` → unchanged (handoff in
   the pretend engine). A burst that also changes the order gets the order's next step; the question isn't
   answered in that reply (one outcome per burst).
6. **Pendientes (our side):** every reply that says "te confirmo" about a price, a product or the hours raises a
   `customer_question` Pendientes item (IDs, topic and a count; never the words). Part of gap (c).

Open: `Question.products` are bare strings, so an unmatched "cerveza" can't be known as restricted and hears "te lo
anoto y te confirmo". Proposal: the wire adds `restricted` per question product, like `ItemLine.restrictedCategory`.

## Proposed (conversation rules)

**Status:** approved by Angel as product behavior (Oct 31); the engine-side parts are proposed to the engine, not
agreed. Built against the pretend engine (`memory-engine.ts`, and through it `d1-pretend-engine.ts`). Channel-side
rules (typed yes, typed numbers, greetings and thanks, stop in other words, failure copy) are decided in
`order-handler.ts`, `customer-gate.ts` and the domain copy, and need nothing from the engine.

1. **Never `nothing` for a burst.** `onBurst` always returns something to say. A burst that changes nothing gets
   the current step again: an order being built hears its open question (or pickup/delivery, the place, the
   readback); a readback that waits is returned again as `readback` at the same version; an order on the list
   gets `order_status`. No order at all: `ask` with the new question code `what_to_order` (proposed, additive in
   `QuestionCode`). Our side keeps a last guard: a job that would still send nothing sends the pending question,
   "¿Qué más te mando?" or "¡A la orden! 🙌".
2. **A question beside an order step.** When one burst both asks something the records answer (price,
   availability, hours) and moves the order, `EngineResult` gains an optional `answered` (an `answer` or
   `store_hours` outcome) next to `outcome` (the order's next step). The customer gets the answer first, then the
   step, in one message; each part keeps its claims. Supersedes #47 point 5's "the question isn't answered in that
   reply".
3. **The name at the end.** The engine never asks `customer_name` while the order is built. On `confirm_order`
   for a `por_confirmar` order when no name is on file (`CustomerContext.customerName` null, proposed): the
   engine returns `ask customer_name` with the order and holds the confirmation (order, version, the action's
   operation key). A later burst with a `customer_name` completes it as `order_confirmed` under the held operation
   key, so a second tap of the same Confirmar is a `duplicate`. A burst with no name asks again (at most twice per
   order, then the order is confirmed without the name). The hold is dropped when the order changes version, is
   cancelled, or another order opens. A name given earlier ("soy Carla") is in the context and never asked. If
   the name was asked on an earlier order and not given (`customerNameAsked`), Confirmar confirms at once.
4. **What our side decides before the engine sees it** (no engine change, listed so the engine doesn't duplicate
   it): a typed yes ("sí", "dale", "ok", "listo", "confirmo", "así está bien", "👍") under the readback whose
   Confirmar button was on the customer's last message is `confirm_order` for that version with the button's
   operation key; "1"/"2"/"3" alone after a message with buttons is that button's ID; a greeting, thanks or "ok"
   alone is sent as an empty reading (point 1 restates the step); a name answer is checked by code (never "sí",
   a number, an emoji, a product or a sentence) before it reaches the engine.

## Proposed (Nov 2): conversation QA fixes

**Status:** built against the pretend engine after the first scripted QA run (`npm run qa`); proposed to the engine,
not agreed. All contract additions are optional fields or new union members, so both sides compile.

1. **`LineMatch.how: "label_pick"`.** Perception's pick among the catalog labels code put in the prompt, mapped
   back to a product by code (the model never supplies an ID). Code matches (barcode, exact name, alias) still
   come first; a pick only fills a line code couldn't match. The customer confirms the readback, which names the
   product, before anything is saved.
2. **Products found by words, inside the engine.** A line nobody matched is searched in the store's catalog by its
   words (`src/domain/catalog-search.ts`: whole words, plurals and unit words folded, numbers exact). One product
   fits: that product. Two to `MAX_OPTIONS` (5) fit: the engine asks with **`ask.options`** (proposed:
   `ProductOption { productId, name, unitPrice }`), and a perception size or product question for that line
   carries the same options. The answer is read by code: the option's number ("2", "el segundo") or its words
   among the options ("el clover de litro"). A price or stock question about a product nobody matched answers
   one fact per fitting product (each a claim), or unknown when none or too many fit.
3. **The quantity is asked.** A line with no quantity gets `ask quantity` for that line; the answer ("dos", "3",
   "media docena") is read by code. Absent is never a quantity.
4. **Pickup or delivery in plain words.** A `clarification` right after `pickup_or_delivery` sets the mode when its
   words are clear ("a domicilio", "lo recojo"); otherwise nothing changes.
5. **Setting the same fulfillment again changes nothing.** "Ok ya voy" read as pickup on a ready order must not
   reopen it (it did: the order went back to `por_confirmar`).
6. **`OrderView.code`** (proposed): the store's order number, said out loud ("101"), unique per store, assigned
   when the order is created. Shown in the confirmation, the ready notice and the console.
7. **A No hay mark recomputes the order total**, and the `line_unavailable` notice says the new total (claimed)
   when the lines back it.
8. **Owner answers from Pendientes** (our side only): each card shows what the customer last wrote (read from the
   conversation, not copied into the item) and a reply box. The answer goes to the customer's conversation as an
   outbox notice signed with the owner's first name, deduplicated by the item, and the item leaves the list. A
   confirmed order with lines nobody could price or find raises a `customer_question` item with topic
   `order_prices`, so every "te confirmo" reaches someone who can answer it.

## Proposed (Nov 2): planner

**Status:** built against the pretend engine (`memory-engine.ts`, and through it `d1-pretend-engine.ts`) behind
`CONVERSATION=planner` (default `classic`); proposed to the engine, not agreed. Decisions D-45 to D-49. Every
addition is an optional field, an optional parameter or a new union member, so both sides compile and the classic
path is unchanged.

The planner is a second Muse Spark call per burst, after the reader, with strict json_schema output and no write
tools. It names lines and products by labels only (`L` order lines, `N` new items of the burst, `P` products
offered for a line); code maps them back, refuses what it can't back (`src/domain/planner/validate.ts`), and gives
the engine a `TurnPlan`. Code still renders every fact, and the claim check is unchanged.

1. **`Engine.onBurst(context, reading, matches, plan?: TurnPlan)`** (`src/domain/planner/types.ts`). `TurnPlan`:
   `move` (`ask | readback | answer_only | handoff | restate`), `ask` (`{ kind, lineRefs }` or null: one kind per
   message, several lines), `assumed` (`{ lineRef, quantity, source: "suggested" | "store_usual" }[]`), `say` (one
   of the fixed phrases in `SAY_PHRASES`, `src/domain/planner/wire.ts`, or empty: the schema makes it an enum, so
   no text the planner writes reaches a customer; rendered by our side, ignored by the engine), `basis` (the open
   order as the plan was checked against it, `orderBasis` in `frame.ts`, or null), and two optional fields:
   `changes` (`{ lineRef, productId?, quantity?, remove? }[]`: a product picked for an order line, a quantity the
   burst said, a removal; the reading has no observation for these) and `options` (`{ lineRef, productIds }[]`: the
   products retrieval offered for an `options` question, so the engine never searches the catalog itself). Labels
   resolve against the turn: `N3` is the third line the burst adds (customer_order lines, then order_change adds, in
   reading order), `L2` the second line of the order as it was before the burst. With a plan the engine skips its
   own questions and its own catalog search (new lines take only code's exact matches and the planner's picks),
   applies `changes` and `assumed`, then asks or reads back. **The engine keeps the last word on readiness**
   (`settleStep` in `validate.ts`): a readback it can't allow comes back as `ask` with the first missing kind, and a
   question about lines that don't need it is narrowed or replaced. A draft the planner shaped stays on that path:
   a later burst with no plan (small talk, a planner failure) asks what the readiness gate says is missing. **A
   stale plan is refused:** when `basis` no longer matches the open order (another write landed between the
   planner's read and the engine's), the engine ignores the plan and its picks and asks what the readiness gate
   says is missing; never silent. Every assumed quantity is checked again against the product as it is then (never
   1 of something sold by weight or restricted; a store-usual amount only while the store still says it).
2. **`LineMatch.how: "planner_pick"`**: a candidate the planner chose for a new item, mapped to a product by code,
   like `label_pick`.
3. **`OrderLineView.quantitySource?: "said" | "suggested" | "store_usual"`**; absent means said. The readback marks
   the other two ("• 1 Piña (te puse 1)"); Confirmar makes them the agreed quantity (the pretend engine drops
   the mark on confirm). A quantity the customer later says replaces the assumption and drops the mark.
   **`OrderLineView.byWeight?: true`** (planner path): the quantity is in pounds, because the product is sold by
   weight, or the customer said a weight for a product the store doesn't sell by unit. The unit is the one said, or
   "libra". The readback says "2 libras de Pollo entero"; absent, a count ("2 Pollo entero").
4. **`EngineOutcome.ask` gains `questions?: AskQuestions` and `assumed?: lineId[]`**. `AskQuestions`:
   `{ kind, lineIds, options?: Record<lineId, ProductOption[]>, byWeight?: lineId[] }`: every missing quantity
   together, or every "which one" together, or pickup/delivery, the place, what to order. `question` and `line` stay
   filled (`quantity`/`quantities`, `ambiguous_product`, `illegible`, `pickup_or_delivery`, `delivery_place`,
   `what_to_order`) so perception's PREGUNTA PENDIENTE and the never-silent fallback keep working. Option prices
   are claims, backed by the outcome (`backedClaims` reads `questions.options` too). `assumed` lists the lines
   whose quantity this burst assumed, for "Te puse 1 de…". **Proposed (Nov 3): `noted?: lineId[]`** (both
   paths) lists the lines this burst added or changed (quantity, product or unit), the only ones the reply echoes
   (as "Anotado ✅" when the line has an amount; still without one, in "Me falta saber cuánto querés de…"); empty means nothing new and no echo; "¿ya anotaste…?" notes every line. Absent: every line,
   as before.
5. **`missingFor(order, quantityAsks)`** (`src/domain/readiness.ts`, pure) is the shared readiness rule: no lines
   (what to order), lines without a quantity until asked twice (`MAX_QUANTITY_ASKS`), unknown fulfillment, delivery
   without a place. Unmatched products and unknown prices are not blocking (they read back as "te confirmo");
   restricted and out-of-stock lines never need a quantity.
6. **The planner's read** (`src/application/planner/source.ts`, local until agreed, like gaps a and b):
   `plannerContext(context)` → the open order, each line's words as perception read them, the other names the
   reader proposed for each line, the lines whose product the planner picked, the question last shown on the
   planner path (kind, line IDs, options shown, times in a row), and the store layer as booleans (`hoursSet`,
   `delivery`). The store's products come from retrieval's own source (`D1RetrievalRepository`), not the engine.
7. **Catalog fields** (our temporary products now; the engine's `products` later): `sold_by: "unit" | "weight" |
   null` and `usual_quantity: DecimalString | null` (L1, migration 0011 `store_product_selling`, read through
   `RetrievableProduct`; the pretend engine carries them on `PretendProduct`), and `store_aliases` (proposed /
   approved / rejected). Migration numbers still to settle: our gaps left are 0009, 0012, 0013; the engine's range is
   0020–0039.
8. **Retrieval** is L1's `retrieveForStore(source, tenant, lines)` (`src/application/learned-aliases.ts`, pure core
   `retrieveCandidates` in `src/domain/retrieval.ts`) over the whole catalog. `CandidateTable` now carries
   `howByLine` (per line, how each candidate was found), and the planner sees it as `found_by`: `exact_name`,
   `store_name` (the store's other name or an approved alias), `all_words`, `some_words`, `other_name`,
   `near_spelling`. There is no spelling table: **`ItemLine.otherNames?`** (planner mode only, reader-proposed,
   at most 3 short plain names, e.g. "catsup" → "ketchup", "salsa de tomate") widens the search as
   `CandidateHow` **`"other_name"`**, ranked below the customer's own words and above near spelling; never a match
   by itself, never shown to the customer. The classic reader's schema and prompt are unchanged.
9. **Learned aliases from confirmed orders** (D-49): once an order is confirmed, each line whose product the
   planner picked proposes the customer's words for it, unless those words already find the product on their own.
   The proposals are statements in the job's completion batch, after the confirmation's (`aliasProposalCommits`,
   `D1RetrievalRepository.proposalCommit`): they land only if the confirmation saves. The INSERT itself refuses
   unless the product is the store's, the order is the store's confirmed order of that customer (the engine's
   `orders` or the pretend engine's snapshot), and the customer hasn't asked to delete their data; so a job still
   running when the purge runs adds nothing. Words the store rejected for one product, proposed again for another,
   get a **new alias ID**, so a "Sí" tapped on an old Pendientes page finds nothing. It never throws, and a
   retried job proposes nothing new. The engine only has to remember, per line, the words retrieval looked up and
   that the planner picked it (`plannerContext`).
10. **Customer data deletion** also deletes the learned aliases still `proposed` from that customer's orders (the
   engine's `orders` and the pretend engine's snapshot); approved or rejected ones are the store's decision and stay,
   unlinked from the order. They keep `source = 'order'` (where they came from doesn't change) and the person in
   `decided_by_user_id`; migration 0011 requires the order link only while an alias is still proposed. In the purge
   batch (`D1CustomerControlRepository.purge`).
11. **What code refuses in a plan, after the Nov 2 review** (`validate.ts`; each with a test in
   `test/planner-review.test.ts`):
   - **A quantity** counts for a line only when (a) the reader itself gave it for that line or its ref, (b) a part
     of the customer's words that names the line says it ("6 platanos" backs platanos, never arroz), or (c) the
     question last asked was that one line's quantity and the burst holds exactly one number. Never a price
     ("a L 18"), an address or phone number ("casa 5"), or a number in the product's own name ("paquete de 10").
     Words name a line only when they fit it better than every other line of the turn (Codex final pass, Nov 3):
     "2 arroz blanco" backs arroz blanco, never arroz integral; "2 arroz" backs neither. The same holds for a
     removal the reader couldn't place.
   - **A removal** stands only when the reader heard one: on its own line, or, when the reader couldn't place it,
     on a line the removal's words name. Mentioning a product ("dejá el arroz como estaba") removes nothing.
   - **A suggested 1** is refused for an item the reader found unclear, and for one offered two or more products
     unless the customer named the one picked (exact name, the store's own name or an approved alias).
   - **Options** never list a product marked "No hay" (the planner input still says it's out).
   - **A photo line kept only through the whole-photo fallback** (its box unusable) keeps no quantity: it's asked.
12. **Rollback policy.** A draft the planner already shaped finishes on the readiness gate's questions even if
   `CONVERSATION` flips back to `classic`: it never switches to the classic question queue halfway, which would ask
   things twice or skip them. New conversations go classic at once. The list-photo fixes from Nov 2 (one line per
   written item in the reader prompt, the whole-photo fallback for a line whose box is unusable, and its
   quantity-free rule above) intentionally apply to the classic path too: they are bug fixes, not planner policy.
13. **A photo's caption** ("lo paso a traer" written under the photo) reaches the reader as its own text message
   right after the photo, quoted as data like any message, on both paths. It was dropped before.
14. **Phrases about media only with media:** "Ya vi tu lista 👍" stands only when the burst has a photo, "Ya escuché
   tu nota de voz 👍" only when it has a voice note (`SAY_NEEDS`); otherwise the reply goes without a phrase.
15. **One call for a burst of text only** (`PLANNER_FAST_TEXT`, D-52; `src/application/planner/one-call.ts`). Code
   first retrieves products for pieces of the customer's own text (split at commas and "y", numbers left out,
   labelled `T1…`) and for order lines still without a product; then one strict call returns the reading's
   `observations` and the turn proposal together (schema `ReadingAndTurn`). Its system prompt is the planner's
   layers, a short bridge (`instructions/one-call.md`) and the planner-mode reader's rules, cache-keyed by all
   three versions. Nothing is trusted more than on two calls: the reading goes through the reader's validator; the
   proposal's product labels are mapped to the table retrieved for each item line exactly as on the two-call path
   (a product the line's own words don't find is refused), then `validateProposal`. When the reader's other names
   find a product the customer's words didn't ("catsup" → "ketchup"), the planner is asked again with them (the
   second call the two-call path makes anyway). Any other failure goes the two-call way, logged
   (`one_call.fallback`). A voice note's transcript takes the same one call as the same words typed (eval E21,
   Nov 3); photos and pins always take two calls.
16. **"Which one" answers and the loop guard** (eval E19, E09b, Nov 3). When the question last shown listed
   options, code reads the answer itself (`chosenOption`, `src/domain/planner/option-answer.ts`): the number shown
   ("2"), the price shown ("esa de 34"), or words only one option holds ("mazola", "el clover de litro"). Exactly
   one option, or nothing. That pick is added to the plan whatever the model made of the burst (a reading that
   missed the answer, or a plan that asked the same list again). The engine never asks a line's "which one" (or
   unreadable) question a third time (`MAX_WHICH_ASKS`): the line is left for the store to confirm and the order
   moves on. `plannerContext` carries the options as shown (`shownOptions`: number, line, product, name, price).
   After the Codex final pass (Nov 3): only a choice counts; a burst with a "no" ("no quiero Mazola", "la Mazola
   no") or a question ("¿cuánto trae la Mazola?", "hay mazola") picks nothing, and the model's reading stands. The
   engine keeps the list exactly as it was shown (number, product, name, price) when it asks, and `shownOptions` is
   that list, not the catalog read again; if a shown price is no longer the store's, its prices are null, so "la de
   34" is left to the model and the next reply shows today's price.
17. **What the last answer was about** (eval E11, Nov 3): **`PerceptionContext.lastAnswered?`** (proposed) lists the
   products the engine's last answer named ("Miel de abeja Don Pancho 500 ml: te confirmo si hay"), until the
   customer's next burst. The planner-mode reader sees it as ULTIMA RESPUESTA and reads "me manda una" as that
   product; the planner sees it as `last_answer`, and the one call is offered it as candidates (`A1…`).

**What the real engine (`OrderEngine`, kercmari) would need** before the planner can run on it. Nothing here breaks
its current types; it runs the classic path until then, since it has no `plannerContext`.

- Save a version in `armando` when the plan asks. Today `onBurst()` applies lines and fulfillment and goes straight
  to `change()`, which always writes `por_confirmar` and returns a readback.
- Accept `plan` in `onBurst`: apply `changes` (pick for an order line, quantity, remove) and `assumed`, take
  `planner_pick` matches like any match, and run `missingFor` + `settleStep` before choosing between `ask` and
  `readback`.
- Store `quantitySource` on order lines, mark it in the readback version, and clear it when the customer confirms
  or says a quantity.
- Remember the question last shown per open order (kind, line IDs, options shown with the names and prices shown,
  times) and quantity asks per line, the words and other names each line was looked up by, and which lines the
  planner picked, and expose them with the order through `plannerContext`.
- Mark lines in pounds (`byWeight`) from its products' `sold_by`.
- Return `ask` outcomes with `questions` (and `assumed`, `noted`), with the option prices from its own price
  records.
