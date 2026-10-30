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

## Open for the meeting

1. **Kinds added beyond Tech Spec v3:** `clarification` (an answer to the engine's last question: "de litro") and
   `customer_name`. The PRD's first order needs both.
2. **Who matches lines to the catalog:** here it's code on the perception side (barcode, exact name, known alias) and
   staff through `match_line`. Does the Deed core expect to match?
3. **Operation keys:** rooted in the job ID for a message, `confirm:<order>:v<version>` for a readback. Fine for the
   Deed core's `operations` table?
4. **Kerly's spec:** not read yet. Anything here that conflicts with it wins a discussion, not a default.
