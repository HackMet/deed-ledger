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
