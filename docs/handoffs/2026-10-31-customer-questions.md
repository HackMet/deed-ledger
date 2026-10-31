## Handoff: customer questions, price, availability, hours (#47)

- **Agent and branch:** Claude Code, `claude/customer-questions` (worktree `hackathon-claude-questions`). Nothing
  committed.
- **Objective:** "¿Hay X?" gets an honest answer: hay, se acabó, or "te lo anoto y te confirmo"; "¿A cuánto?"
  only a confirmed price, else "te confirmo"; store hours from settings, else "te confirmo".
- **References:** #47; #5 gap (f); #36, #37, #40 (kercmari's, not built); PRD v1.2 "Honest stock", "How the
  assistant talks"; `docs/contract.md` "Proposed (#47)".

### Files changed

- New: `src/domain/store-hours.ts` (check, format, compare a schedule), `test/customer-questions.test.ts` (20 tests).
- `src/domain/contract/outcomes.ts` (additive, marked proposed): `StoreHoursEntry`, `StoreHours`, outcome
  `store_hours`, claim `store_hours`.
- `src/domain/replies.ts`: `store_hours` template and claim; availability copy changed to "X: sí hay." /
  "X: se nos acabó." / "X: te lo anoto y te confirmo."; `COPY.hoursUnknown`; `unansweredCount`.
- `src/application/perception/matching.ts`: a question's products are matched by code (`line` indexes
  `products`); one leading article dropped only when the words as said match nothing.
- `src/application/perception/prompt.ts`: question topics get examples ("a cuanto", "a que hora abren" vs "a que
  hora esta" for the order); prompt version `order-v1` → `order-v2`.
- `src/application/order-handler.ts`: raises a `customer_question` Pendientes item when the reply said
  "te confirmo". `src/application/ports.ts` (add: `CustomerQuestionPendiente`, `AnyPendiente`),
  `src/infrastructure/logging-pendientes.ts` (logs it).
- Pretend engine: `memory-engine.ts` routes question topics (was: everything but status → handoff), `PretendProduct`
  gains optional `availability` and `restricted`, options gain `storeHours`, `verifyClaims` answers `unit_price`,
  `availability` and `store_hours`. `d1-pretend-engine.ts` passes `storeHours`. `demo-catalog.ts`: synthetic stock
  on two products (arroz hay, leche se acabó).
- Tests updated: `test/replies.test.ts` (new kind, new availability copy), `test/perception.test.ts` (prompt version).
- Docs: `docs/contract.md` ("Proposed (#47)"), `docs/architecture.md` (one bullet), `docs/status.md` (one line).
- No migration.

### How it works

- The model reads `question { topic, products }`; code matches the products to the catalog. The engine routes:
  `price`/`availability` → `answer` facts, `store_hours` → `store_hours`, `other` → `out_of_scope` ("Solo te
  puedo ayudar con pedidos, precios y tu cuenta de la tienda. ¿Qué te mando?"), `order_status` unchanged.
- No record means unknown: an unmatched product, an unconfirmed price, no stock evidence, or unset (or unreadable)
  hours all become "te confirmo". Restricted products: "eso solo lo vendemos aquí en la tienda.", never priced.
- Every price, availability and hours stated is a claim, checked before the save against the outcome and right
  before the send through `verifyClaims`. A price changed in between sends the safe reply (tested).
- A question answered from records comes before the name question; a burst that also changes the order gets the
  order's next step instead.

### Verification

```text
$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p test/tsconfig.json      (exit 0, no errors)

$ npm test
 Test Files  36 passed (36)
      Tests  481 passed (481)
```

`test/customer-questions.test.ts`: templates per topic with unknowns (availability, price, hours unset and five
unreadable schedules, day and time wording); code matching of question products (article, tie); the pretend
engine's facts, routing and `verifyClaims`; end to end through the Worker on local D1 with both pretend engines
(webhook → recorded reading → engine → claim checks → sent text, Pendientes raised, no customer words in logs);
hours from settings end to end; a price changed before the send → safe reply. No test calls the network. Not
tried on a phone or against the live model with the new prompt.

### Not done, risks, open questions

- **Real engine:** kercmari's #36/#37/#40 must fill `AnswerFact` and `store_hours` as proposed, and her
  `verifyClaims` must answer `unit_price`, `availability` and `store_hours`; until then every price, stock or hours
  answer on her engine goes out as the safe reply.
- **Demo hours are unset:** we don't know Johan's real hours, so the deployed demo says "El horario te lo
  confirmo." Pass `storeHours` to `D1PretendEngine` in `composition.ts` once Angel has them.
- **Unmatched alcohol:** "¿hay cerveza?" with no catalog match hears "te lo anoto y te confirmo"
  (`Question.products` carries no restricted flag). Proposed fix in contract.md.
- **New `LineMatch`es:** `onBurst` now also gets matches pointing at a question's products. An engine that
  assumes every match points at an order line must check the observation's kind (PR #62 should be checked).
- **One outcome per burst:** "¿hay arroz? mandame 2" gets the order step, not the stock answer.
- **Prompt changed** (`order-v2`) without a live check; the recorded fixtures were made with `order-v1`.
- **Pendientes still only logs** (gap c); a retried job can raise `customer_question` twice.
- Copy change: "No nos queda X." / "Te confirmo si hay X." became "X: se nos acabó." / "X: te lo anoto y te
  confirmo." in the `answer` template (the line-unavailable notice is unchanged).

### Next step

Angel reviews and commits; at the contract call, agree "Proposed (#47)" with kercmari (outcome, claim, question
matches, restricted flag), then she fills it from #36, #37 and #40.
