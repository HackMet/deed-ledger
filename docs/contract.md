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
  Typed "confirmar" and the button share one key: `confirm:<order>:v<version>`.
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
- A `Commit` may carry `post` guards, checked after its statements in the same batch. Until the fence runs them,
  `completeJob` refuses a commit that has any.
- `Commit` naming D1 types in the application layer is a decision (D-40), not debt.
- Tables use `business_id` (existing schema), not Tech Spec v3's `store_id`.

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
6. **Fee:** `fee` comes from store settings (#40) only, `null` when none is set, and is never part of `total`. Until
   #40 exists the pretend engine always gives `null`. The readback shows "Envío: L X, aparte del total." only for a
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
   - Customers hear: "Arroz: sí hay." / "Leche: se nos acabó." / "Pan: te lo anoto y te confirmo." and
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
