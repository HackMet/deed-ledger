## Handoff: the order flow, reading to reply (#17)

- **Agent and branch:** Claude Code, `claude/order-trip` (worktree `hackathon-claude-trip`, on the combined branch
  with #14–#16, #19–#20, #21 and the console). Nothing committed.
- **Objective:** a customer's burst goes reader → validated reading → code `LineMatch` → `Engine.onBurst` →
  replies templates with the claim check → `JobOutcome { replies, commits }` with the name commit; taps and typed
  words get their replies from the same templates.
- **References:** #17; #5 gaps (a), (b), (d), (g) as proposed in the contract worktree's "Proposed" section; PRD
  v1.2 "A first order"; handoffs `2026-10-31-customers.md`, `-replies.md`, `-reading.md`.

### Files changed

- New: `src/application/order-reading.ts` (`OrderReadingSource`, `readingSourceOf`, `BurstMediaResolver`,
  `unresolvedMedia`, `createOrderReading`).
- `src/application/order-handler.ts`: the reader seam returns `{ reading, matches, pendingQuestion }` and gets the
  customer context; replies come from `replyForOutcome`; `pendientes` is a new required dep.
- `src/domain/order-copy.ts`: cut to the two lines no template covers ("Va. Decime qué le cambiamos al pedido.",
  the typed-answer-crossed-a-readback line). Everything else was a stopgap the replies templates replace.
- `src/application/errors.ts` (add): `ReadingFailedError`.
- `src/composition.ts`: `RuntimeOverrides.modelProvider` and `.burstMedia` (add), `buildBurstReader` takes a
  `provider` override (add), new `buildOrderReading`; `pendientes` built once and passed to the handler.
- `src/infrastructure/memory/memory-engine.ts`: pretend `onBurst`, `perceptionContext`, `catalog`; optional
  catalog with prices in a second constructor argument.
- `docs/architecture.md`: "Reading a burst (#17)" under Processing.
- Tests: `test/order-flow.test.ts` (6 new, updated expectations to the replies copy), `test/helpers/engines.ts`
  (seam shape, `pendientes`), `test/helpers/harness.ts` (add: `modelProvider`, `burstMedia` options).

### What was done

- **Reading.** Each job is one burst message in order (text, button title, or a photo / voice note through
  `BurstMediaResolver`). The engine supplies the open order's labelled lines and the last question (gap a) and the
  catalog (gap b) through `OrderReadingSource`, a local interface: an engine that has both methods gets the reader.
  One Muse Spark call per burst; only code matches (barcode, exact name, known alias) reach `onBurst`. The model's
  label picks are logged as a count (`perception.label_picks_unused`) and dropped.
- **Failure.** Spend cap, provider refusal or outage, or output off the schema throws `ReadingFailedError`: the
  processor retries (3 attempts) and then sends "Perdón, no pude revisar tu mensaje. ¿Me lo mandás otra vez?".
  Nothing is saved.
- **Replies.** `replyForOutcome` for bursts and answers: templates, claims (first check before the save, second at
  dispatch), Confirmar/Corregir/Cancelar buttons on every readback waiting for an answer (including a stale tap's
  current readback). An answer's reply never closes the burst. The readback and the name question are remembered
  only when the reply goes out as rendered, not as the safe reply.
- **Name.** Saved from a `customer_name` observation, or from a `clarification` when the last question was the name
  (gap d, our records, first answer wins).
- **Wiring.** `buildRuntime` wires the reader when the engine has the reads and `MODEL_API_KEY` is set (or a
  provider override is passed). The swap to the real engine (#13) stays the one `engine` line.
- **Photos and voice (seam only).** `BurstMediaResolver.resolve(tenant, job)` is where #26 (photo bytes from R2,
  through `jobs.getMediaAsset`) and #27 (transcript) plug in, via `RuntimeOverrides.burstMedia`. The default,
  `unresolvedMedia`, gives a photo with no bytes ("no disponible" to the model) and an empty transcript. No
  `MediaStore` read was added.
- **Pretend engine.** Enough for the first order: lines from the reading, prices from an optional catalog, one
  question at a time (an unclear line, the name once, pickup or delivery, a delivery place), then the readback in
  `por_confirmar`. A size answer is settled by looking up "<line words> <answer>" ("aceite clover de litro") as a
  name or alias; no match leaves the line unpriced, and the question is never asked twice. Any change after a
  readback makes a new version. Also: status question (with queue position), cancel, set/remove by label, the
  same outcome again for a retried job. Payments, other questions and handoff get `handoff`; ALTO gets `stopped`.

### Tests run

```text
$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p test/tsconfig.json      (exit 0, no errors)

$ npm test
 Test Files  27 passed (27)
      Tests  308 passed (308)
```

New in `order-flow.test.ts` (24 tests there now, 18 before): the full first order end to end (webhook → intake →
processor → handler → reader with recorded readings → pretend engine → outbox → fake channel, then staff
Empezar and Pedido listo through `/console/acciones` with a real login, then "¿ya está?" → "Tu pedido ya está
listo."), asserting the exact seven replies in order, one outbox row per reply all `sent`, six model calls, name
saved and asked once; perception's input (burst order, one image part, the transcript, `L1…L4` labels, the pending
question; no content in logs); a replayed webhook changes nothing; a failing reading retries and sends the honest
reply, saving nothing; reader wiring conditions; Corregir; buttons on a stale tap's readback. No test calls the
network: the provider is a fake `ModelProvider` returning wire-format readings written by hand (authored, not
live).

### Not done, risks, open questions

- **"Tu pedido ya está listo" after staff tap Listo needs #18.** The console route drops the engine's notices. The
  test checks the notice renders as "Tu pedido ya está listo. Total L 315. Ya podés pasar a traerlo." and that the
  customer sees "Tu pedido ya está listo." when they ask; the push itself isn't sent.
- **Photos and voice notes in production:** the media download is still a stub and the resolver is unresolved
  until #26/#27, so the deployed app reads text only.
- **Dev engine has no catalog**, so with a key set in dev every price reads "te lo confirmo".
- Pretend engine limits: a change to an order on the list that needs a question moves it back to `armando` (off the
  list); a delivery place is taken as text only; no substitutes, saved places or fees. The pretend engine saves into
  memory at `onBurst` time, not through commits.
- The size question quotes the customer's words with the quantity ("¿De qué tamaño querés 1 aceite clover?"):
  `OrderLineView` has the full text but not the product words.
- An `invalid_output` reading is retried up to 3 times (about US$0.07 at most per burst, within the daily cap).
- **Contract questions:** (1) gap (a) and (b) as engine reads (`perceptionContext(customer)`, `catalog(store)`),
  local in `OrderReadingSource`; (2) `LineMatch.how: "label_pick"`, or model picks stay out (they're dropped now);
  (3) gap (d): `CustomerContext.customerName` / `customerNameAsked` (still the local `CustomerContextWithName`), and
  is a `clarification` answering the name question a name; (4) the outcome for `correct_order` (handler still asks
  itself); (5) `OrderLineView` could carry the product words for questions; (6) does the engine dedupe a retried
  burst by `jobId` (the pretend one does)?

### Next steps

- #18: route console notices to the customer's conversation, then extend the first-order test to the pushed
  "Tu pedido ya está listo".
- #26/#27: implement `BurstMediaResolver` and pass it through `RuntimeOverrides.burstMedia` (or the default in
  `buildRuntime`).
- #13: the real engine implements `OrderReadingSource` (or the contract adds those reads), then swap the `engine`
  line in `composition.ts`.
- Saturday: run the same flow on the deployed app from a real phone with the real Muse Spark adapter.
