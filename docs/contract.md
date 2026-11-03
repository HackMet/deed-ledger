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
  `listo` (pickup). A `null` fulfillment is neither: both answer `rejected`/`invalid_state`, never a guess. This
  changes `mark_delivered` for a `listo` order with no fulfillment, which K2b accepted.
- A courier id that isn't an active member of this store answers `rejected`/`not_found` with the order.
- A customer's cancel (or change) from `en_camino` on answers `rejected`/`invalid_state`; the copy is
  `CANCEL_AFTER_DISPATCH` ("Ya va en camino; hablá con la tienda.") in `src/domain/copy.ts`.
- Migration `0025_dispatch.sql` rebuilds `orders` so its state CHECK admits `en_camino`.
- A review with an empty or too long reason answers `rejected`/`not_allowed` (the contract has no input-error reason).

## Open for the meeting

1. **Kerly's spec:** not read yet. Anything here that conflicts with it wins a discussion, not a default.
