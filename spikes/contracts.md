# Day-one experiment contracts (v1)

Source: `/home/angel-rodas/angel/hackathon-kb/planning/experiment-contracts.md`
(frozen v1). The schemas, tool contracts, interfaces, runner CLI and result-card
template below are copied verbatim in meaning. Lanes may not change them.
Changes go through Angel.

Marked `[CONVENTION]`: day-one scoring and layout choices added October 26,
2026 with the fixed cases. They interpret the frozen shapes; they do not alter
them. If a convention fights a frozen rule, the frozen rule wins.

Status note: the KB file says "proposed, awaiting Angel's freeze". This
session treats it as frozen per the orchestrator brief. Angel's explicit freeze
is still open.

## Repo layout [CONVENTION]

```text
experiments/contracts.md   this file
cases/e1/E1-*.json         15 text cases
cases/e2/E2-*.json         6 image-case specs (binaries land Oct 27)
cases/e3/records.json      seeded fixture; cases/e3/E3-*.json (10 questions)
cases/e4/E4-*.json         6 voice cases (audio lands Oct 27)
cases/e5/catalog.json      trap catalog; cases/e5/E5-*.json (9 messages)
cases/e6/E6-*.json         4 approval/replay scenarios
cases/e7/NOTE.md           template-vs-model protocol (reuses E3)
cases/e8/E8-*.json         3 interruption/duplicate scenarios
results/                   created by lanes Oct 27 (gitignored if large)
runner/                    built by Lane A Oct 27 (not before)
```

## Hard rules for every lane

- Synthetic inputs only. No real invoices, voice notes, phone numbers, or
  store figures in code, cases, logs, or prompts.
- Secrets only from `.dev.vars` or environment. Never print, log, or commit
  them. App key is `MODEL_API_KEY`, never `META_API_KEY`.
- Standard model IDs only (`muse-spark-1.3`, `muse-voice-transcribe-1.0`).
  Never `*-contributor` IDs.
- Paid calls are opt-in, bounded by fixed case counts, one revision max in E2.
  Initial budget ~$5 list-price. Stop if cost cannot be bounded.
- Model output never writes records, never supplies tenant IDs, never
  approves. Absent means unknown, never zero.

## E1 - Typed operation (model output, no writes)

`kind`: `supplier_receipt`, `sale`, `expense`, `fiado_credit`,
`fiado_payment`, `adjustment`, `inquiry`, `correction`, `cancel`.

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": ["supplier_receipt", "sale", "expense", "fiado_credit", "fiado_payment", "adjustment", "inquiry", "correction", "cancel"]
    },
    "product_text": { "type": ["string", "null"] },
    "quantity_text": { "type": ["string", "null"] },
    "quantity_value": { "type": ["number", "null"] },
    "unit_text": { "type": ["string", "null"] },
    "amount_minor": { "type": ["integer", "null"] },
    "amount_basis": { "type": ["string", "null"] },
    "counterparty_text": { "type": ["string", "null"] },
    "targets_open_draft": { "type": "boolean" },
    "missing": { "type": "array", "items": { "type": "string" } },
    "ambiguities": { "type": "array", "items": { "type": "string" } },
    "owner_reply": { "type": "string" }
  },
  "required": ["kind", "product_text", "quantity_text", "quantity_value", "unit_text", "amount_minor", "amount_basis", "counterparty_text", "targets_open_draft", "missing", "ambiguities", "owner_reply"],
  "additionalProperties": false
}
```

Field notes (frozen): `*_text` echo the owner's words exactly, or null when
not stated. `quantity_value` and `amount_minor` are set only when unambiguous,
else null. `amount_basis` is one of `per_unit`, `per_pack`, `total`, or null.
`missing` names critical fields still needed. `owner_reply` is one short
Honduran Spanish message: a confirmation echo or one specific question.

Rules (frozen): the model never invents `quantity_value` or `amount_minor`.
Corrections set `targets_open_draft: true` and restate the corrected field.

Strict-mode note (frozen): every key required, `additionalProperties: false`.
Nullable `["string", "null"]` types must be verified against the live API on
first use; if rejected, use empty-string or sentinel conventions and record
the change here (through Angel).

`quantity_value` convention [CONVENTION]: `quantity_value` means stock-unit
quantity. "Two boxes of twelve" without a confirmed pack size stays null
(E1-03); a stated figure whose unit cannot convert to stock units also stays
null (E1-15). A bare stated count in stock units ("12 unidades") is exact
(E1-02). A stated money figure with unclear coverage is echoed in
`amount_minor` with `amount_basis: null` plus a question (E1-04); a derived
total (2 x 150) must never appear.

E1 `expected` keys [CONVENTION]:

- `must_equal`: `{field: value}` exact match on top-level output fields.
- `must_be_null`: `[fields]` that must be null.
- `must_ask`: true means the output must ask (non-empty `missing` or
  `ambiguities`, and `owner_reply` ends with "?"); false means no question.
- `must_not_contain`: `[strings]` that must not appear anywhere in the JSON
  output (e.g. a derived "24").
- `must_mention`: `[strings]` that must appear in `owner_reply` or
  `ambiguities` (case-insensitive).

## E2 - Paperwork extraction (model) vs draft line (server)

The model returns only what the paper shows. The server adds matching,
received quantities, and revision. Keep these two schemas apart.

Extraction line (model, frozen):

```json
{
  "type": "object",
  "properties": {
    "source_text": { "type": "string" },
    "description": { "type": ["string", "null"] },
    "invoice_quantity": { "type": ["string", "null"] },
    "invoice_unit": { "type": ["string", "null"] },
    "units_per_pack": { "type": ["string", "null"] },
    "unit_cost_minor": { "type": ["integer", "null"] },
    "currency": { "type": ["string", "null"] },
    "ambiguities": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["source_text", "description", "invoice_quantity", "invoice_unit", "units_per_pack", "unit_cost_minor", "currency", "ambiguities"],
  "additionalProperties": false
}
```

Field notes (frozen): `invoice_quantity` is the exact decimal string as
printed, or null. `units_per_pack` only when printed on the paper, else null.

Draft line (frozen): server adds `product_id` or null, `received_quantity`
(null until the owner confirms), `stock_unit`, `revision`, `tenant_context`
(server-populated only). A price list or notebook page becomes a draft for
review; it never becomes a transaction without explicit confirmation.

E2 case keys [CONVENTION]: `expected.lines[]` holds per-line expectations in
the extraction shape (subset matching; lane scores missed/extra lines and
exact fields separately). `expected.must_not_be_transaction: true` marks
non-transaction paper (E2-03). `image_spec` describes the synthetic image to
render Oct 27; it is a build instruction, not scored.

## E3 - Read tools (model may call; app executes and computes)

Tenant context is supplied by the application, never by the model. No write
tools. Cap the tool loop (max 4 calls) and total output. (Frozen.)

- `get_sales_total(date_from, date_to)` -> `{ total_minor, record_count, record_ids[] }`
- `get_expenses_total(date_from, date_to)` -> `{ total_minor, record_count, record_ids[] }`
- `list_pending_fiado()` -> `{ entries: [{ id, counterparty_text, amount_minor, date }], count }`
- `get_day_summary(date)` -> `{ sales_minor, expenses_minor, pending_count, record_ids[] }`
- `get_stock_record(product_query)` -> `{ product_id, recorded_qty, unit, baseline_status, as_of } | { unknown: true, reason }`

Refusal rule (frozen): profit, margin, or complete-stock questions with
missing inputs return an explicit unknown with what is missing. The model
explains tool results and cites record IDs; it never computes totals itself.

E3 case keys [CONVENTION]: `context.today` (fixed "today", `2026-10-27`) and
`context.store` (`A` unless stated). `expected.verdict` is `answer` or
`refuse`. Single-total questions use `expected.total_minor`, `count`,
`record_ids`. `must_mention` / `must_not_contain` apply to the answer text
(case-insensitive). `must_caveat_baseline: true` requires the no-baseline
caveat (recorded, not complete) in stock answers.

## E4 - Voice (only if E1 passes)

Input: `{ "type": "audio", "file": "e4-<E1-id>.wav" }`. Each case reuses one
E1 case: `reference_transcript` is the E1 input body,
`interpretation_case` names the E1 ID whose `expected` scores the downstream.
Score transcription errors separately from interpretation errors. (Frozen
shape; E4 set is day-one.)

Recording convention [CONVENTION]: synthetic speech or spoken-by-volunteer
renders of the reference transcripts only; WAV 16 kHz mono is the scored
artifact. The OGG-to-WAV spike stays isolated from the 45-minute box.

## E5 - Catalog disambiguation

Extends the E1 runner with a candidate list and an explicit "ambiguous - ask"
outcome; no writes. (Design from the independent review, day-one set.)

E5 case keys [CONVENTION]: `context.store` selects the catalog partition.
`expected.verdict` is `match`, `ask`, or `ask_create`. `match` carries
`product_id`. `ask` carries `candidates[]` (every plausible product ID, store
partition only). `must_ask` and `must_not_contain` follow E1.

## E6 / E8 - Trust scenarios (deterministic, no model calls)

Scenario shape [CONVENTION]: `scenario` (setup in plain words), `steps[]`
(`{step, action, args}` using Lane C's draft-store API, defined Oct 27),
`expected` (`{commits, rejects[], final}` plus case-specific keys). Actions
are behavior labels (`create_draft`, `confirm`, `ingest_message`,
`correct_draft`); Lane C binds them to real functions without changing the
expected behavior.

## Fixed-case file format (frozen)

One JSON file per case. Expected outcomes are written by hand before any call.

```json
{
  "id": "E1-03",
  "tags": ["pack-vs-unit", "ambiguity"],
  "input": { "type": "text", "body": "Entraron dos cajas de doce leches." },
  "expected": {
    "kind": "supplier_receipt",
    "must_be_null": ["quantity_value"],
    "must_ask": true,
    "must_not_contain": ["24"]
  },
  "notes": "Pack size unconfirmed; 24 must not appear anywhere in the proposal."
}
```

Image cases use `"input": { "type": "image", "file": "e2-01-invoice.png" }`
with expected line fields listed per line. Voice cases reuse E1 IDs with
`"input": { "type": "audio", "file": "e4-e1-03.wav" }` and score transcript
separately from interpretation.

## Provider interfaces and runner CLI (frozen)

```ts
interface ModelProvider {
  proposeOperation(text: string): Promise<TypedOperation>;
  extractPaper(image: Uint8Array): Promise<ExtractionLine[]>;
  answerWithTools(question: string, tools: ReadTools): Promise<GroundedAnswer>;
}
interface Transcriber {
  transcribe(wav16kMono: Uint8Array): Promise<{ transcript: string }>;
}
```

Runner (channel-independent, no WhatsApp, no database):

```text
node runner/run.js --exp E1 --cases ./cases/e1 --model muse-spark-1.3 --out ./results/e1.json
node runner/run.js --exp E3 --cases ./cases/e3 --model muse-spark-1.3 --out ./results/e3.json
```

The runner prints per-case pass/fail, keeps failures, and records latency and
estimated list-price cost next to each case. Paid calls stay opt-in.

## E7 - Template vs model control [CONVENTION]

Protocol: run the same ten E3 questions twice over identical seeded records:
once with Spark explaining tool results, once with the fixed template below.
Compare correctness, latency, and list-price cost per correct answer. No new
cases; see `cases/e7/NOTE.md`. Baseline template (review wording):

"Hoy vendiste L___ en ___ registros. Te falta costo en ___, asi que no puedo
decirte la ganancia."

## Result card template (frozen)

```markdown
## Result: E__ - <name> - <date>
- Model/provider and prompt version:
- Cases: passed __ / __ (list failed IDs, kept with outputs):
- Correction effort (clarifications asked, corrections needed):
- Latency p50/p95 and retries:
- Cost: estimated list-price __ / billed __ (state which):
- Decision: continue / revise / shelve, with reason:
- What the store visit must confirm:
```
