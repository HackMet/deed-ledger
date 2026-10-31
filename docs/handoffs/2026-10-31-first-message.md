## Handoff: first message, ALTO, deletion, "quiero hablar con Johan" (#30)

- **Agent and branch:** Claude Code, `claude/first-message` (worktree `hackathon-claude-firstmsg`, built on the
  combined customers + replies + reading + console branch). Uncommitted.
- **Objective:** customers can stop messages, delete their data or reach Johan, as WhatsApp requires; the first
  reply says who it is and links the privacy notice.
- **References:** issue #30; `docs/security-privacy.md` §12; PRD v1.2 "Registration and delivery", "How the
  assistant talks"; handoffs `2026-10-31-customers.md`, `2026-10-31-replies.md`.

### Files changed

- New: `migrations/0010_customer_controls.sql`, `src/domain/customer-controls.ts` (words and copy),
  `src/application/customer-gate.ts`, `src/application/customer-deletion.ts`,
  `src/infrastructure/d1/customer-control-repository.ts`, `src/infrastructure/r2-media-eraser.ts`,
  `src/interfaces/http/privacy.ts`, `test/customer-controls.test.ts`.
- Small edits to shared files:
  - `ports.ts`, add-only: `ReplyDraft.kind?`, `HandoffPendienteItem` (and `Pendientes.raise` accepts it),
    `CustomerControlRepository` and its types, `MediaEraser`, `Deps.customerControls`, `Deps.mediaEraser`.
  - `composition.ts`: builds the gate and the new deps; passes `gate` to `createOrderHandler` (one changed line);
    `RuntimeOverrides.mediaEraser`.
  - `order-handler.ts`: `OrderHandlerDeps.gate?` and one call (`createOrderHandler` wraps `handleJob` with
    `gateCustomerJob`). Nothing else in the handler changed.
  - `dispatch.ts`: one block after the claim (stopped customer → row failed, `customer_stopped`).
  - `intake.ts`: one line before saving a customer message (tombstone check).
  - `processor.ts`: one line, `kind: reply.kind ?? "reply"`.
  - `scheduled.ts`: runs the deletion purge after the sweep.
  - `app.ts`: mounts `/privacidad`. `config.ts`: `publicBaseUrl`. `wrangler.jsonc` and
    `worker-configuration.d.ts`: the `PUBLIC_BASE_URL` var ("" by default; d.ts edited by hand, not regenerated).
  - `logging-pendientes.ts`: logs the handoff item (IDs only).
  - Tests: `order-flow.test.ts` marks its customer introduced (2 lines; those tests count replies),
    `secrets.test.ts` lists 0010. Docs: `docs/architecture.md` (new section and the config var).

### What was done

- **Control words** (`controlWord`): the whole typed message, any case, accents or punctuation. ALTO/STOP,
  SEGUIR, "(quiero|necesito|…) hablar con <1–4 words>", and deletion only as an imperative or a stated wish about
  "mis datos"/"mi información" with no question mark. Text messages only; voice notes and model readings never
  trigger them.
- **First message:** the introduction goes first in the customer's first reply; `introduced_at_ms` is saved in the
  same batch, only if the reply is written. Copy (owner name and store name come from the database):
  "Hola, soy el asistente automático de {tienda}. No soy {Johan} ni una persona: te ayudo con tus pedidos. /
  Cómo usamos tus datos: {PUBLIC_BASE_URL}/privacidad / Para hablar con Johan, escribí: quiero hablar con Johan. /
  Si no querés recibir más mensajes, escribí ALTO."
- **ALTO:** stop time on `customers`; the ALTO message and every unread one before it are marked read. Dispatch
  fails any row for a stopped customer except `customer_control` rows (direct answers to control words).
  While stopped, a message gets one reminder per stop ("Tenés los mensajes pausados… escribí SEGUIR") and is
  marked read, so resuming never acts on it.
- **Handoff:** raises a `customer_handoff` Pendientes item (IDs only) and sends "Listo, le aviso a Johan para que
  te atienda.", stopped or not.
- **Deletion:** see `docs/architecture.md`, "Customer controls". The purge runs from the cron after the
  confirmation is sent (or after 2 hours), R2 first then one D1 batch; a failure retries the next minute.
  Tombstone: `customer_tombstones (business_id, HMAC(SENDER_HASH_SALT, "sender:" + phone), deleted_at_ms)`.
- **Privacy page:** `GET /privacidad`, one generic page, Spanish, no store data.

### Tests run

```text
$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p test/tsconfig.json      (no errors)

$ npm test
 Test Files  28 passed (28)
      Tests  318 passed (318)
```

Baseline before the change: 27 files, 302 tests. New: 16 in `customer-controls.test.ts` (word recognition incl.
messages that only mention data; first message content, once; privacy page; ALTO stops queued rows and a later
automated row; reminder once; a model reading of stop/delete changes nothing; SEGUIR; handoff raises one
Pendientes item and sends one line, also while stopped; deletion removes D1 rows and R2 objects for that customer
only, another customer and the same phone in another store untouched; a late webhook after deletion doesn't
recreate the customer, a later message starts a new one; a failed R2 cleanup leaves D1 as it was and is retried;
a mention of data never deletes). Checked that the ALTO and late-webhook tests fail with the dispatch and intake
checks disabled. Nothing was sent to a real phone.

### Decisions made on my own (reversible)

1. Only SEGUIR resumes; writing again doesn't (the customer said stop). One reminder per stop explains it.
2. ALTO and STOP both stop. A second ALTO while stopped gets no reply.
3. Handoff works while stopped; a handoff on a first message gets the introduction too.
4. No confirmation step before deletion: the explicit phrase is the request.
5. The purge keeps the customer row (no phone, no name) so engine records that point at it keep amounts.
6. A late webhook is recognised by Meta's message timestamp vs the purge time. A message sent after the purge is
   a new customer (they can come back); one sent before it is dropped.
7. Copy lives in `src/domain/customer-controls.ts`, not `copy.ts`/`replies.ts`, to avoid conflicts with the
   lanes editing those.
8. The gate is wired only on the order handler path (when an engine exists). The placeholder handler (production
   with no engine) has no gate: gating it would add the introduction to replies asserted in 9 existing test files.

### Wording questions for Angel

- Deletion confirmation and privacy page: is "Los montos de tus compras y fiados quedan en las cuentas de la
  tienda, sin tu nombre ni tu número" the right promise? A fiado with no name can't be collected.
- Privacy page leaves out, on purpose: who is legally responsible for the data and a contact; how long data is
  kept when nobody asks to delete it; any citation of Honduran law or Meta's terms; any "we never sell your data".
- Is "asistente automático" the right term? Is naming the owner (from the console's display name) OK, and is "No
  soy Johan ni una persona" too blunt?
- Should the confirmation say how long deletion takes (today: within minutes once the confirmation is sent)?

### Not done, risks, open questions

- **The reading's `handoff` kind** doesn't raise a Pendientes item: the gate runs before perception. The order
  handler lane can call `pendientes.raise({ kind: "customer_handoff", … })` when a reading has `handoff`.
- **Model `stop` outcomes:** `replies.ts` renders the engine's `stopped` outcome as "no te vamos a mandar más
  mensajes" (and with `deleteRequested`, "Recibimos tu pedido de borrar tus datos"), but nothing stops or deletes
  on a model reading. That reply would be a false promise; the replies or order-handler lane should map a model
  `stop` to the typed instructions instead ("Si querés que no te escriba más, escribí ALTO").
- **No gate in production without an engine** (decision 8). Once #13 wires the engine, it's on.
- Handoff's Pendientes item is raised before the job's batch: a retried job can raise it twice.
- `PUBLIC_BASE_URL` must be set before customers write, or the first message has no privacy link.
- Data that doesn't exist yet and the purge doesn't cover: delivery places, transcripts, stored readings, engine
  tables (orders, sales, fiado). Each needs its own purge step when it lands. Also not covered: `early_statuses`
  (keyed by a message hash, pruned by retention) and Worker logs (IDs only).
- The tombstone keeps a keyed hash of the phone indefinitely; the privacy page doesn't mention it.
- 0010 hasn't run against the remote D1 (Angel runs remote migrations). Another lane may own 0009.
- `worker-configuration.d.ts` was edited by hand; the next `wrangler types` regenerates it with the var.

### Next steps

- Angel: answer the wording questions; set `PUBLIC_BASE_URL`.
- Order-handler/replies lane: route a reading's `handoff` to Pendientes and stop promising on a model `stop`.
- Engine (#13): purge steps for places, transcripts and readings, and confirm sale/fiado rows keep only the
  customer ID.
