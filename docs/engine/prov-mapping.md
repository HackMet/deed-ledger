# Deed and W3C PROV-O

Deed's fact memory is a provenance model. This page maps its terms to [PROV-O](https://www.w3.org/TR/prov-o/), then
names the three things Deed adds that PROV does not say.

Where the code lives: the ledger and engine files below are on the unmerged branches `claude/engine-facts`,
`claude/demo-env` and their stack (the table in `docs/built-during-hackathon.md` lists them). `migrations/0020_ledger.sql`
is on `main`. Paths are checked against `claude/demo-env` at `cbce8de`. For the engine's rules in full, see
`docs/engine/fact-memory.md` (on `claude/engine-docs`, not yet on `main`).

## The mapping

| Deed | PROV-O | Where it lives |
|---|---|---|
| A **fact**: one row of `facts` (kinds such as `order_version`, `order_confirm`, `order_cancel`, `change_request`, `price`) with its `body_json` | `prov:Entity` | `migrations/0020_ledger.sql`, widened in `migrations/0023_order_facts.sql` |
| A **member** (owner, staff), a **customer**, the **model** that read a message (Muse) | `prov:Agent` | `actor_user_id` on `facts`; `member` evidence (`0023`); recorded perception in `demo/` |
| An engine **operation**: one derived operation key, one atomic batch | `prov:Activity` | `src/application/engine/order-engine.ts` (`burstKey`, `actionKey`, `staffKey`); `UNIQUE (business_id, operation_key)` on `facts` |
| The fact came out of that operation | `prov:wasGeneratedBy` | the fact row carries the `operation_key` of the batch that wrote it |
| Who acted in it (the customer, the staff member) | `prov:wasAssociatedWith` | `actor_user_id`; the `ConsoleAction` / `CustomerAction` envelope names the actor |
| `dependsOn` (a confirm depends on the version it confirms; a status depends on the confirm) | `prov:wasDerivedFrom` | `fact_dependencies (fact_id, depends_on_fact_id)` |
| A **closure**, with its reason (`superseded`, `cancelled`) | `prov:wasInvalidatedBy` (the closing fact is the invalidating activity's output) | `fact_closures (fact_id, closed_by_fact_id, reason, closed_at_ms)` |
| **Evidence** (inbound message, media asset, confirmation, stock movement, another fact, member) | `prov:used` | `fact_evidence (fact_id, kind, ref_id, content_sha256)` |

Differences worth knowing. PROV invalidation is a bare timestamp; a Deed closure always names the fact that closed it
and a reason. A `superseded` closure does not kill what rests on the superseding fact: order version v2 depends on v1
and closes it `superseded`, and v2 stays live (`KILLING_CLOSURE` in `src/infrastructure/d1/fact-ledger.ts`). A
`cancelled` closure kills every descendant. "Live" means neither the fact nor any ancestor has a killing closure.

## What Deed adds

PROV describes provenance that was recorded. It does not say who may write it, how often, or what may be said from it.

### 1. Provenance is enforced when the fact is written

A fact whose evidence or dependencies are not live is refused in the same atomic batch that would have written it.
Nothing is recorded first and audited later.

- Guards run before the statements: G3 (the draft the owner confirmed is still pending), G4 (every `dependsOn` id and
  all its ancestors exist in this store and none is closed), G5 (what a cancellation closes is a fact of this store and
  still open). After the statements: G4b (the fact just written and its ancestors are live) and P1 (the fact has the
  evidence its kind rests on). A failed guard rolls the whole batch back.
- Implemented in `src/infrastructure/d1/fact-ledger.ts` (`D1FactLedger.statementsFor`, `KILLING_CLOSURE`); the batch
  is run with a fence in `src/infrastructure/d1/fence.ts`.
- The guard is the backstop. The engine reads first and gives the person a reason (D-42):
  `src/domain/fact-precheck.ts` (`precheckFact`), so a refusal names what is dead, for example
  `rejected: stale_version`.
- Effect, as the engine reports it: a staff tap on a cancelled order is refused, not recorded.

### 2. Activities happen exactly once

The engine derives the operation key from what the operation is, never from a message, and a repeat answers the
first outcome instead of running again.

- Keys: `burst:<jobId>`, `confirm:<orderId>:v<version>`, `cancel:<orderId>:v<version>`,
  `staff:<orderId>:<version>:<action>`, and the change-request keys (`changeRequestKey`, `reviewKey` in `src/domain/change-request.ts`). The rest are in
  `src/application/engine/order-engine.ts`. An envelope whose key differs from the derived one is
  `rejected: not_allowed`.
- The first outcome is stored in `operations.outcome_json` (`migrations/0021_orders.sql`) and read back by
  `firstOutcome` in `order-engine.ts`; a used key answers `{ type: "duplicate", first }`.
- `UNIQUE (business_id, operation_key)` on `facts` is the backstop for a race.
- Measured by `./demo.sh`, customer B: three "confirmar" messages give one `order_confirm` fact, and the second and
  third answers are "Tu pedido ya estaba confirmado." (K10 report, run 1; RK10 reran it).

### 3. Claims are checked against live facts before anything is said

Before a reply reaches a customer, every claim in it ("Pedido listo", a total, a unit price) is re-read against the
ledger. A claim is true only if the fact it names is live now, so "ready" cannot go out after a cancel that landed in
between. An unknown claim is false, never an exception.

- Implemented in `Engine.verifyClaims` (`src/application/engine/order-engine.ts`; the signature and the `Claim`
  type are in `src/application/engine.ts` and `src/domain/contract/outcomes.ts`). On `main` the reply path calls it
  as the second claim check (`src/application/dispatch.ts:249`, port in `src/application/ports.ts`); on `main` the
  engine's own `verifyClaims` still throws `not implemented: issue #12`, and the implementation is on the K2 branch
  `claude/engine-issue-12`.
- This is the third thing in the code; it matches the brief's list and no substitution was needed.

## What this page does not claim

- The mapping is a vocabulary alignment, not an RDF export: Deed stores no PROV triples and ships no PROV-O
  serialisation. [TBD: whether a PROV-JSON export is wanted]
- Payments, fiado and stock claims are outside this cut: `verifyClaims` answers false for them.
- The adversarial result ("false facts admitted") is [TBD: K8 attacks and false facts admitted, not yet run].
