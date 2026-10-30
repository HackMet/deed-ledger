# Johan AI: Product Requirements Document

Multimodal inventory management for neighborhood retail

| | |
|---|---|
| Version | 1.0, product and architecture baseline |
| Status | Proposed, pending pilot validation |
| Prepared | October 24, 2026 |
| Pilot partner | Punto de Ventas Johan |
| Pilot market | Tocoa, Colón, Honduras |
| Initial interface | WhatsApp, with a lightweight web workspace |
| Build window | Meta Global AI Developer Hackathon, October 26 to November 4, 2026 |

> Product requirements
> (v1.0, the frozen original). This file is the working copy that agents read and cite. Hackathon scope
> cuts live in [`hackathon-plan.md`](hackathon-plan.md), not here.

**The promise:** Run the store the way you already know. Photograph what arrives, say what changed, and ask what
is left. Johan AI turns those interactions into trustworthy inventory records.

**Product thesis:** An owner who can send a WhatsApp photo or voice note should be able to maintain a useful digital
inventory. The AI interprets inputs; the inventory engine, not the model, decides whether a change is valid and
commits it only after authorization.

**Defining product decision:** Build the first store on a platform designed for multiple tenants, locations and
staff. Onboarding the next mercadito must not require new application code or a separate deployment.

## 01. Executive summary

Johan AI is a Spanish-first, multimodal inventory assistant for small, owner-operated stores. The initial design
partner is Punto de Ventas Johan, a mercadito in Tocoa, Colón, where the owner has historically managed business
records using a notebook and pencil. The product converts photographs of supplier invoices, product pictures, and
spoken WhatsApp instructions into reviewable inventory actions. A compact web app provides search, corrections,
approvals and audit history.

The first release is deliberately narrow: product catalog creation, delivery intake, inventory movements, stock
lookup, and lightweight reconciliation. It is not a point-of-sale system, general accountant, autonomous purchasing
agent, or full ERP.

Success means the owner can receive merchandise, photograph an invoice, correct exceptions, approve actual received
quantities, and query the updated stock, with the transaction recorded exactly once. A second synthetic store must
run through the same workflows without seeing or changing Johan's data.

### 1.1 Product at a glance

| Dimension | Decision |
|---|---|
| First user | Owner / staff of Punto de Ventas Johan |
| Core job | Record and understand inventory with less manual entry |
| Primary input | WhatsApp photos, voice notes and text |
| Secondary interface | Responsive web app for review and administration |
| Core engine | Tenant-scoped, auditable inventory ledger |
| AI responsibility | Extract, interpret, match and propose; never directly commit stock |
| Data strategy | One shared tenant-isolated SQL database initially; repository boundary for later partitioning |
| Success criterion | A verified end-to-end delivery workflow, plus zero unauthorized or duplicate stock writes |

### 1.2 Design principles

1. **Conversation first, interface second.** No mandatory spreadsheet, desktop computer, or complex setup to
   complete a daily task.
2. **Proposal before mutation.** AI outputs are drafts; business state changes are deterministic transactions.
3. **Truth over fluency.** Say "I don't know" when a count, product identity, or package conversion is not
   established.
4. **Store data is private by construction.** Tenant isolation is part of the database and service design, not a
   chatbot prompt.
5. **Audit every change.** Stock has history, provenance and an accountable actor.
6. **Productize onboarding.** The second store should be configured, not custom-developed.
7. **Build for unreliable conditions.** Intermittent connectivity, ambiguous images, delayed webhooks and retries
   are expected.

## 02. Problem, users and context

### 2.1 Problem statement

Handwritten notebooks are flexible but difficult to search, reconcile, share or analyze. Store owners may know their
business intimately while lacking an accessible, current inventory record. Traditional POS/ERP tools can demand
upfront catalog creation, constant data entry and unfamiliar workflows. Johan AI aims to capture reliable records
through behaviors the owner already uses: sending a picture, recording a voice note and asking a question.

Important operational distinction: invoices record what a supplier charged; they do not prove what physically
arrived. Additionally, deliveries only increase recorded stock. Without recording sales, spoilage and physical
counts, the system cannot claim a fully accurate on-hand balance.

### 2.2 Primary users

- **Owner / operator.** Runs the mercadito, receives goods, knows prices, and approves corrections. Values speed,
  trust and plain Honduran Spanish; may work entirely from a phone.
- **Store employee.** Helps receive goods and check stock. Needs a restricted, understandable set of actions;
  cannot configure the business or view unrelated stores.
- **Business administrator (later).** Supports multiple locations, roles and oversight from the web app. This role
  exists in the domain model but does not drive the first demo.
- **Platform operator.** Monitors failures, cost and support escalations. Must not have routine, unrestricted access
  to merchants' private data.

### 2.3 Jobs to be done

- When a supplier arrives, help me record what actually came without copying every invoice line by hand.
- When I buy a new item, help me create a catalog entry from a photo and a few answers.
- When I'm busy, let me speak a correction instead of typing it.
- When I need a number, tell me the recorded stock and how reliable that number is.
- When something looks wrong, show how the number was calculated and let me correct it safely.

### 2.4 Assumptions to validate at Johan

What does the owner record today: purchases, sales, supplier debt, cash flow, or only selected notes? Are invoices
printed, handwritten or mixed? Are goods purchased as cases but sold as units? Is there a reliable barcode? Who
receives deliveries? How often is a physical count possible? Which phone and internet connections are available?
These are research questions, not established facts.

## 03. Goals, non-goals and release boundaries

### 3.1 Primary goals: pilot MVP (P0)

- Convert a supplier invoice photo into an editable receipt draft with line items, quantities, units and costs where
  legible.
- Match draft lines to the store's catalog; request clarification or creation when uncertain.
- Distinguish invoiced quantity from actually received quantity; require explicit approval.
- Convert product photos into suggested identities, never inferred counts of hidden merchandise.
- Interpret Spanish voice notes into typed actions or clarification questions.
- Record confirmed receipts and adjustments once, with an immutable stock-movement audit trail.
- Answer product inventory questions from authorized, tenant-scoped records, showing "not established" when
  appropriate.
- Provide a minimal web dashboard with products, pending actions, receipt review and movement history.
- Prove isolation using a second test tenant and automated cross-tenant attack cases.

### 3.2 Near-term follow-ons (P1)

Opening-stock guided counting; per-product low-stock thresholds; CSV import/export; simple manual sales deduction;
employee roles beyond owner/staff; multiple locations in one business; improved supplier profiles and aliases;
per-store usage and AI cost reports.

### 3.3 Explicitly out of scope (P2)

Full checkout/POS, tax accounting, automatic invoicing, supplier payments, purchase-order automation, predictive
replenishment, accounting integrations, customer-facing sales chatbot, automated procurement, cross-tenant product
analytics and universal shelf counting. These are potential future modules, not MVP commitments.

### 3.4 The stock-truth contract

A product/location begins in opening stock unknown until counted or explicitly initialized. Confirmed receipts and
adjustments are recorded, but the UI must not imply that a partial ledger proves complete on-hand quantity. Stock
balances carry a baseline status and "as of" timestamp. Unrecorded sales can make a previously verified balance
stale; the assistant should say so when material.

## 04. Core user journeys

### 4.1 J1: Supplier invoice to received stock (critical path)

Trigger: Owner sends a readable supplier-invoice photograph through WhatsApp.

1. Webhook validates the channel event, resolves tenant and staff identity, stores the message ID, and acknowledges
   it quickly.
2. Background worker retrieves media, stores the private original, extracts supplier name/date/line
   descriptions/units/quantities/costs and retains provenance.
3. Catalog matcher links confident items to existing store SKUs and labels ambiguous or unmatched items.
4. System sends a compact draft summary and asks: "¿Esto fue lo que realmente recibiste?"
5. Owner corrects missing units, shortages, package sizes or prices by text, voice or web review.
6. Server validates authorization, current draft version and explicit final confirmation.
7. One database transaction creates the receipt, stock movements, balance changes and audit event. The draft
   becomes committed and cannot be committed again.
8. WhatsApp returns a receipt number, count of updated SKUs and review link.

Exception examples: blurry invoice; repeated upload; omitted product; two different pack sizes sharing a label;
invoice shows 12 but delivery contains 10; owner abandons approval; system restarts mid-processing.

Definition of done: Replaying the same webhook, queue message or confirmation cannot double inventory; edits after
confirmation become new documented corrections, not hidden revisions.

### 4.2 J2: Product photo to catalog

Owner photographs a newly stocked item. AI extracts visible brand, product name, variant, package size and barcode
only when readable. The system checks this store's catalog for candidates. It asks for missing purchasing/selling
units and selling price if applicable. Human confirmation creates or links the product. A product photo alone never
increases inventory unless the owner also specifies an accepted quantity and confirms the resulting action.

### 4.3 J3: Voice note to typed action

Owner says: "Vinieron dos cajas de doce leches; cada unidad me salió a veintidós lempiras." Voice is transcribed in
Spanish, the model proposes received 24 sellable units, and the system asks which product and whether the quoted L22
is cost per unit. If the owner says "Se dañaron tres yogures," the bot prepares a damage adjustment, not a new
receipt. No ambiguous cost, unit or product identity is silently guessed.

### 4.4 J4: Ask what remains

Owner asks "¿Cuántas Coca de dos litros me quedan?" Search is tenant-scoped and resolves aliases. Response states
the recorded quantity, unit and freshness status, e.g., "Tengo 18 unidades registradas, actualizado hoy. Esto no
incluye ventas que no me hayas reportado." If baseline stock is unknown, the assistant states that plainly and can
offer a quick count.

### 4.5 J5: Correct or reconcile

Owner initiates a physical count or adjustment. The app asks for the product, current count, reason and
authorization. For stock correction, post a variance movement with the source count and snapshot reference. Retain
original movements. Never overwrite old quantities or delete committed receipts to conceal mistakes.

### 4.6 J6: Onboard the second store

An administrator creates a second business and location, authorizes its employee, adds products, receives a sample
invoice and views its stock. No code changes or redeployment. Tests must prove that a staff member or message from
Store B cannot access Store A's catalog, media, review links or pending approvals.

## 05. Functional requirements and acceptance criteria

Priority model: P0 = required for the demo and pilot; P1 = planned next; P2 = intentionally deferred. Each
requirement is a contract for engineering and QA, not a claim that it has been implemented.

**FR-01: Tenant, location and actor resolution (P0).** Every request must resolve an authenticated actor,
authorized business and location before touching domain records. A shared WhatsApp assistant maps a verified sender
to explicit membership; an actor belonging to more than one business selects an active business. Web permissions use
the same policy model.
*Accept when:* A message from an unknown number cannot read inventory; a Store B actor cannot guess Store A IDs to
read or mutate records; missing/ambiguous location selection fails closed.

**FR-02: Secure message and media intake (P0).** Verify webhook authenticity using supported provider mechanisms;
deduplicate provider message IDs; download media using authorized credentials; store originals privately with source
metadata. Queue processing must expose states: received, processing, needs_review, committed, failed and expired.
*Accept when:* Duplicate or out-of-order delivery produces no duplicate business actions; unsupported media receive a
helpful Spanish error; failed processing is retryable without losing status.

**FR-03: Invoice extraction (P0).** Return a versioned structured draft: supplier, date, line text, proposed
product, invoiced quantity, received quantity (initially unconfirmed), unit, unit cost, currency and source image
reference. Surface unreadable or uncertain fields rather than filling them arbitrarily.
*Accept when:* The owner can review every detected line, add a missed line, correct quantities, and confirm only
received items. The bot does not quietly reinterpret case prices as unit prices.

**FR-04: Catalog and unit normalization (P0).** Products have tenant-owned canonical records, optional barcode,
packaging attributes, supplier SKU and aliases. Handle case→unit conversions explicitly and distinguish purchasing
units from sellable units. Numeric calculations happen in deterministic code using exact arithmetic.
*Accept when:* "2 cajas × 12" yields exactly 24 units only with a verified pack size; ambiguous matching returns
candidates or requests input; an alias from Store A is not automatically trusted for Store B.

**FR-05: Product-image capture (P0).** Image analysis proposes visible product identity and attributes; it cannot
establish the number of units in an unopened case or outside the image. Photo-based counting of visible items is
optional experimental research and cannot be a silent source of committed quantity.
*Accept when:* Owner may confirm catalog creation without changing stock; a photo with partially obscured branding
triggers a clarification.

**FR-06: Voice interpretation (P0).** Transcribe supported WhatsApp voice notes and normalize colloquial Honduran
Spanish into the same typed intents as text: receive, adjust, inquire, clarify and cancel. Preserve the transcript
for review while respecting media retention policies. Validate audio-format conversion before launch.
*Accept when:* A clear voice note produces a proposed action, not a direct write; uncertainty about "caja,"
"unidad," or "precio" causes a clarification; unsupported/overlong audio receives fallback instructions.

**FR-07: Human approval and versioning (P0).** Mutating AI proposals remain pending until a permitted actor confirms
the complete current revision. Corrections increment draft revision; an approval token binds to tenant,
actor/context, action and revision and expires. Duplicate approval is harmless.
*Accept when:* A stale button or link cannot approve an old draft; the same receipt cannot commit twice; a user
cannot approve another tenant's action.

**FR-08: Immutable stock and balance maintenance (P0).** A single authorized, atomic write posts stock movements,
updates materialized balances and marks the draft committed. Use one idempotency key per logical operation and a
database uniqueness constraint. Corrections use compensating movements. Prevent negative stock by default for
verified inventory unless an explicit future policy permits it.
*Accept when:* Concurrent approvals, worker retries and simultaneous edits produce one correct result; stock and
ledger remain consistent after an injected failure.

**FR-09: Natural-language inquiry (P0).** Search tenant-owned products by canonical name and aliases. Return
product, location, recorded balance, units and status/freshness. Do not manufacture values when records or opening
counts are missing.
*Accept when:* A valid request returns an authorized, source-grounded answer; ambiguous product names return a
choice; unverified inventory is clearly labeled.

**FR-10: Minimal web workspace (P0).** Responsive login-protected interface with Home, Products, Pending Reviews,
Receipt Detail and Movement History. Reuse domain commands and permission checks from the WhatsApp channel. Allow
corrections and approvals of drafts and manual inventory adjustment.
*Accept when:* Owner can complete the full receipt review from a phone or laptop, and all changes are reflected
identically in WhatsApp queries.

**FR-11: Audit and supportability (P0).** Store timestamps, source channel/message, actor, tenant, location,
before/after reference, AI model/prompt version and relevant validation decisions. Log errors without emitting
personal or commercial invoice content into general-purpose logs.
*Accept when:* A committed change can be traced to its approval and source media; an operator can diagnose a failed
job without accessing an unrelated tenant's content.

**FR-12: Productized onboarding (P0 foundation; P1 self-service).** Configuration and provisioned records, not code
branches, define a store. MVP may use assisted onboarding. Future flow adds self-service invitations, importing,
guided opening counts, billing and WhatsApp number connection.
*Accept when:* Two tenants can be created via application/admin flows with no code changes and survive the same
end-to-end acceptance suite.

## 06. Experience requirements

### 6.1 WhatsApp conversation rules

Use concise Honduran Spanish and one decision per message. Prefer receipts as summaries rather than paragraphs.
Confirm all stock-changing actions; use interactive controls only where the current WhatsApp message type, session
rules and API support them. Always provide a plain-text fallback: Confirmar / Corregir / Cancelar. Do not expose raw
model confidence scores to owners; translate uncertainty into specific questions.

Suggested messages:

- **Receipt draft:** "Encontré 8 productos. Antes de guardarlos, revisá lo que sí llegó. Hay 2 productos que
  necesito confirmar."
- **Clarification:** "La factura dice 'Leche caja 12'. ¿Recibiste 1 caja con 12 unidades o 12 cajas?"
- **Commit confirmation:** "Listo. Entrada #REC-0024 guardada: 6 productos actualizados. Podés revisar los detalles
  aquí: [enlace seguro]."
- **Unknown balance:** "Todavía no tengo un conteo inicial confiable de ese producto. He registrado 12 unidades
  recibidas desde el 24 de octubre; eso no significa que solo tengas 12."

### 6.2 Web interface information architecture

- **Home:** pending reviews, recently processed receipts, stock warnings, last synchronization.
- **Products:** name, SKU/barcode, unit, stock state, aliases, cost information appropriate to role.
- **Pending Reviews:** exceptions first, line-item corrections, one explicit "Confirmar entrada" action.
- **Receipt Detail:** original invoice side-by-side with extraction results and history.
- **Movements:** searchable ledger with type, quantity, reason, actor and source.
- **Settings (minimal):** business name, location, owner and staff access; advanced settings later.

Design constraints: responsive at 360 px; large touch targets; clear loading and error states; avoid requiring
horizontal scroll for routine actions; Spanish labels; currency displayed as L with two decimals; dates in the shop's
configured timezone.

### 6.3 Accessibility and degraded modes

Allow text alternatives to audio/photo; keyboard-accessible approvals; screen-reader labels in the web workspace;
contrast meeting WCAG AA where practical. A delayed job must show "En proceso," not a false success. On connectivity
interruption, refresh from the authoritative server and never replay a stock mutation without idempotency controls.

## 07. Domain model and data integrity

### 7.1 Logical relationships

- business → many locations → many inventory_balances and stock_movements.
- business → many memberships, products, suppliers, receipts and channel_accounts.
- receipt → many receipt_lines → resolved products, optional media_assets and one or more stock_movements.
- pending_action → source inbound_message, current revision and eventual single committed operation.

| Record | Critical invariant |
|---|---|
| Businesses / locations | Every owned record has a defensible tenant and location scope. |
| Memberships | Rights are assigned by business and optionally location, not by phone number alone. |
| Products / aliases | Identity is store-owned; never merge on similar text alone. |
| Purchase receipts / lines | Billed and actually received quantities are distinct fields. |
| Stock movements | Append-only, signed quantity, reason, actor, source and unique operation key. |
| Inventory balances | Transactionally derived cache; rebuildable from movements and opening count. |
| Pending actions | Finite state machine, revision and approval expiration. |
| Messages / jobs | Provider identifiers, processing state, attempts, deduplication keys. |
| Media assets | Private object key, checksum, business scope, retention state. |

### 7.2 Quantity and money representation

Use typed units such as unit, case, pack, lb, and kg with explicit, product-specific conversion factors. Never mix
package count with sellable units. Store currency in integer minor units and quantities in exact decimals or
product-defined scaled units. Preserve supplier's original units on receipt lines for audit.

### 7.3 Receipt and movement state machines

Receipt draft: `received → processing → needs_review → approved → committed` with explicit `failed` / `expired` /
`canceled` exits. A processing retry may not move a committed receipt backwards. Committing is an idempotent terminal
transition.

Movement types: `opening_count`, `supplier_receipt`, `sale_adjustment`, `damage`, `return`, `reconciliation` and
`correction_reversal`. Future transfer events are distinct outbound/inbound linked movements, not a direct change to
both balances without history.

### 7.4 Stock quality metadata

Maintain whether a location/SKU has a verified opening count, last count date and whether sales capture is enabled.
Responses should distinguish verified baseline with recorded movements from partial receipts-only history. Avoid a
single vague green check mark implying absolute accuracy.

## 08. Technical architecture

### 8.1 Reference stack

- **Frontend and API:** TypeScript + Hono on Cloudflare Workers.
- **Relational state:** Cloudflare D1 / SQLite, initially shared and tenant-scoped.
- **Media:** private Cloudflare R2 objects with short-lived authorized access.
- **Jobs:** Cloudflare Queues; persistent processing state and dead-letter handling.
- **AI adapter:** Meta Model API image understanding (Muse Spark family) and Spanish speech-to-text (Muse Voice
  Transcribe), subject to verified account access and challenge terms.
- **Inbound channel:** Meta WhatsApp Cloud API; authenticated web access as a second adapter.

Request path:

```text
WhatsApp / Web → authenticated adapter → tenant resolver → command/query layer → domain validation → D1 ledger
Media → private storage + processing queue → AI extraction → structured proposal → approval → domain command
```

The AI model has no production database credentials and no stock mutation tool. It produces structured, versioned
candidate data. The domain engine owns calculations, transitions and writes.

### 8.2 Modular monolith boundaries

- **Domain:** catalog, inventory, purchasing, unit/value types, identity and policy.
- **Application:** commands, queries, validation, approvals, transaction coordination.
- **Adapters:** WhatsApp, web, model provider, object storage, queue and SQL repository.
- **Shared:** exact money/quantity arithmetic, observability, schema validation and errors.

Suggested implementation separates `domain/*`, `application/*`, `integrations/*`, `infrastructure/*` and
`interfaces/*`. Dependency direction points inward toward pure business rules.

### 8.3 Multitenancy strategy

Start with a shared D1 database for speed. Require tenant/context arguments in repository methods and composite
tenant-aware foreign keys and uniqueness rules. Never trust a tenant ID embedded in an LLM response or user-supplied
URL. Use security tests to prove cross-tenant denial. Monitor contention and keep migration paths to per-tenant
databases or sharded groups if growth justifies them; do not implement provisioning complexity now.

### 8.4 Asynchronous, at-least-once processing

Acknowledgment and ingestion should be fast; image/audio processing runs asynchronously. Assume jobs can be retried,
duplicated and reordered. Persist workflow state, use idempotency keys on logical operations and unique provider
message IDs on ingestion, and make transitions conditional on current revision. Failed jobs go to a reviewable
dead-letter path. User-visible status remains pending until the database transaction commits.

### 8.5 AI output contract

Every model result must satisfy a schema; parse, validate and version it. Representative line fields:

`source_text, proposed_product_id?, description, invoice_qty?, received_qty?, purchase_unit?, units_per_pack?,
unit_cost_minor?, currency, ambiguities[], source_region?`

An absent value means unknown, not zero. "Confidence" may aid triage but cannot independently authorize a write.
Save prompt/model/version and allow replay against a non-production test corpus.

### 8.6 Model and channel integration risks

Meta documents image understanding for Muse Spark and Spanish speech transcription with Muse Voice. However,
deployment must verify keys, permission scopes, rate limits, current costs and challenge rules. The recorded-audio
endpoint has format/length constraints; WhatsApp voice notes may require an audio conversion service before
transcription. Validate this end-to-end early rather than assuming Cloudflare Workers can transcode arbitrary audio
formats.

## 09. Security, privacy and responsible AI

### 9.1 Threat model and controls

| Threat | Required control |
|---|---|
| Cross-tenant ID guessing | Authenticated tenant context, scoped SQL and integration tests. |
| Forged or replayed webhook | Provider signature verification, unique message IDs and idempotent state transitions. |
| Stolen review link | Expiring signed token bound to the action/revision plus actor authorization. |
| Malicious invoice instructions | Treat invoice/media text as untrusted data, never as system instructions. |
| Accidental large stock mutation | Draft review, explicit quantities, permission checks, anomaly flags. |
| Leaked supplier/commercial data | Private objects, least privilege, no raw media in telemetry, controlled retention. |
| Queue retry / double approval | Unique operation IDs and atomic database transaction. |
| Unauthorized support access | Separate audited support grants; no routine global content browsing. |

### 9.2 Data handling

Collect only what the workflow needs. Obtain the owner's explicit permission for real supplier invoices, images and
audio. Keep raw media private. Proposed policy: short retention for uncommitted voice media and abandoned drafts;
configurable storage for committed supplier documents pending local legal/accounting review. Establish
deletion/export processes before broad commercial onboarding. Document which third-party model processors receive
data and check their current usage/training terms.

### 9.3 AI safety boundaries

Prompt injection inside a photographed invoice can attempt to ask the model to reveal data or change balances; the
extractor must only produce data under a fixed schema. AI cannot authorize itself, invent SKU prices, substitute a
visually similar product, or declare stock complete. Any uncertain or exceptional item routes to user clarification.

## 10. Quality targets, analytics and release gates

Targets below are engineering goals for pilot evaluation, not measured performance or service guarantees.

### 10.1 Pilot success metrics

| Measure | Pilot target / interpretation |
|---|---|
| Unauthorized or duplicate stock writes | Zero, enforced by automated tests and observed pilot events. |
| Traceability | 100% of committed movements linked to an authorized actor and origin. |
| Tenant isolation | 100% pass of two-store negative authorization suite. |
| Invoice completion | Owner can finalize a legible 5–15 line receipt in ≤ 3 minutes in coached testing; collect actual median. |
| Extraction accuracy | Benchmark on ≥ 15 consented sample invoices; report exact per-field accuracy before human correction. |
| Human correction workload | Track corrections and unresolved fields per receipt; reduce across iterations. |
| Cost per receipt | Measure actual model/transcription/storage cost; set gross-margin target after real samples. |
| Processing responsiveness | Status acknowledgment within a few seconds; target p95 ≤ 90 s for typical clear-image draft generation, subject to provider latency. |

These targets should be revised after field observation rather than treated as discovered customer requirements.

### 10.2 Observability

Correlate tenant_id, message_id, job_id, draft_id and operation_id without logging source text by default. Capture
processing duration, per-step errors, model/provider usage, extraction correction rate, duplicate suppression, queue
age, failed jobs and manual support resolutions. Add per-tenant cost limits and basic throttling before opening
broad signup.

### 10.3 Minimum automated acceptance suite

1. Clear invoice: extraction → correction → approval → one committed receipt.
2. Supplier shortage: 12 invoiced / 10 received → only 10 increase stock.
3. Unknown pack size: stop and clarify; do not multiply silently.
4. New product photo: catalog creation does not alter stock.
5. Voice note: Spanish transcription results in a proposed action requiring approval.
6. Duplicate webhook, duplicate job and double-tap: one committed movement set.
7. Concurrent revision: stale approval token fails; revised draft is authoritative.
8. Two stores with identical product names: no cross-tenant reads/writes or shared aliases.
9. Uninitialized opening stock: reply says unknown/partial rather than zero.
10. Correction: reversal and new adjustment retain the original event.
11. Provider outage or malformed image: job fails visibly and can retry safely.
12. Reconciliation: ledger-derived balance equals materialized balance after replay.

### 10.4 Pilot go / no-go gates

GO only when the entire purchase receipt path succeeds with genuine consented examples, tenant isolation and
idempotency tests pass, approval cannot be bypassed, and the owner can recover from a bad extraction without
engineering help. NO-GO if any workflow writes unconfirmed quantities or displays partial stock as a guaranteed
on-hand count.

## 11. Delivery plan and demo

### 11.1 Hackathon work plan

| Window | Deliverable and exit gate |
|---|---|
| Oct 24–25 | Interview checklist, sample data permission, requirements lock, integration credentials and official-rules review. |
| Oct 26–27 | Tenant/auth scaffolding; webhook ingestion; shared inventory model; real WhatsApp media round trip. |
| Oct 28–29 | Image extraction draft; catalog matching; first invoice end-to-end (without stock commit until safe). |
| Oct 30–31 | Review/approval; transaction ledger; idempotency; two-store isolation test. |
| Nov 1–2 | Voice transcription and typed actions; minimal responsive dashboard; baseline/unknown stock messaging. |
| Nov 3–4 | Field test, correctness benchmark, failure-path hardening, recorded demo and final submission. |

Submission checkpoint: The event lists November 4, 2026, at 9:00 PM Eastern Time as the deadline; verify any
official updates and participant-specific requirements before submission.

### 11.2 Demo narrative: 3 minutes

- **0:00–0:25, the problem.** Film the notebook/pencil workflow with permission, then show the ordinary WhatsApp
  conversation.
- **0:25–1:10, multimodal intake.** Send a real, anonymized invoice photo; show structured extraction, including one
  deliberately ambiguous item.
- **1:10–1:50, human correction.** Explain that invoice quantity differs from received quantity; correct by voice or
  text; approve the exact receipt revision.
- **1:50–2:20, trusted result.** Query recorded inventory; show receipt, provenance and movement history in web UI.
- **2:20–2:45, SaaS proof.** Switch to a second test business; demonstrate identical item names with fully
  separated data.
- **2:45–3:00, impact.** Show measured time, field accuracy, corrections and next milestone; avoid unsupported
  savings claims.

### 11.3 Post-hackathon stages

- **Pilot stabilization:** 2–4 weeks of supervised use, better catalog aliases, physical opening-count workflow and
  operator support.
- **Repeatability:** Assisted onboarding of 3–5 independent stores, import tools, store-level quotas and basic usage
  analytics.
- **Commercial readiness:** Robust roles, billing, retention/export, support workflows, production WhatsApp
  onboarding and unit economics.
- **Expansion:** POS and purchasing integrations only after inventory data quality is consistently demonstrated.

## 12. Open questions and explicit decisions

### 12.1 Confirmed product decisions

- **D-01:** WhatsApp-first, Spanish-first; web is complementary.
- **D-02:** Inventory intake/management is the MVP, not full store management.
- **D-03:** AI proposals require human confirmation before stock changes.
- **D-04:** Audit ledger and transaction idempotency are P0.
- **D-05:** Business/location scoping is P0 even with only one pilot store.
- **D-06:** Initial SQL backend uses a shared D1 database, with a tenant-aware repository contract.
- **D-07:** No claim of complete on-hand accuracy without an opening count and continued transaction capture.

Later decisions continue in [`decisions.md`](decisions.md).

### 12.2 Discovery decisions to close

| ID | Question | Decision owner / due |
|---|---|---|
| Q-01 | What does Johan track today and what does he want first? | Product + Johan / pilot interview |
| Q-02 | What invoice styles and product units appear most? | Product + Johan / sample collection |
| Q-03 | How will opening inventory be established? | Product + Johan / before trustworthy stock claim |
| Q-04 | Can staff report sales/losses consistently? | Product / pilot study |
| Q-05 | Shared assistant number or Johan-owned WhatsApp account? | Engineering / integration setup |
| Q-06 | What audio transcoding is needed for actual WhatsApp notes? | Engineering / early integration test |
| Q-07 | Which Meta models, credentials and quotas are available? | Engineering / challenge kickoff |
| Q-08 | Which store records require longer legal retention? | Business + local legal/accounting advice / precommercial |
| Q-09 | Is the submission entered as indie developer or startup? | Founder / rules checkpoint |

Current answers, where research has produced one, are tracked in [`decisions.md`](decisions.md) and
[`status.md`](status.md).

## Appendix A. Example structured proposal (illustrative)

```json
{
  "schema_version": "1.0",
  "kind": "supplier_receipt_draft",
  "business_id": "server-populated-only",
  "location_id": "server-populated-only",
  "source_message_id": "wa-message-123",
  "revision": 2,
  "lines": [
    {
      "source_text": "LECHE 1 L CAJA X12",
      "product_id": "prod_456",
      "invoice_quantity": "1",
      "invoice_unit": "case",
      "units_per_pack": "12",
      "received_quantity": "10",
      "stock_unit": "unit",
      "unit_cost_minor": null,
      "ambiguities": ["Unit price not confirmed"]
    }
  ],
  "status": "needs_review"
}
```

Interpretation: The model may suggest a line but may not populate `business_id` or `location_id` as a trusted
authority. A verified user corrected actual received quantity to 10 units. Unit cost is unknown until confirmed.
Server-side schema checks and revision approval remain mandatory.

## Appendix B. Reference sources and verification notes

1. [Meta Global AI Developer Hackathon, official event page](https://dev.meta.ai/events/global-hackathon)
2. [Meta Model API: overview, models and speech capabilities](https://dev.meta.ai/docs/overview)
3. [Meta Model API: image understanding](https://dev.meta.ai/docs/image-understanding)
4. [Meta Model API: speech-to-text](https://dev.meta.ai/docs/speech-to-text)
5. [Cloudflare D1: limits and tenancy considerations](https://developers.cloudflare.com/d1/platform/limits/)
6. [Cloudflare Queues: delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
7. [Cloudflare Queues: ordering behavior](https://developers.cloudflare.com/queues/reference/how-queues-works/)

Source note: External platform facts were reviewed October 24, 2026. Provider eligibility, permitted WhatsApp
workflows, model/pricing quotas, local legal requirements and hackathon rules must be rechecked before production
reliance. Product targets, assumptions and architecture choices are proposals, not claims about a deployed system.

**Product north star:** The owner can say "Tomale foto a lo que vino, revisemos, y guardalo", and the records can be
trusted.
