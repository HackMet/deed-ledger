# Testing and validation

No code exists yet. This is the plan that T1's scaffold implements. When commands exist, they go in `AGENTS.md`.

## Layers

| Layer | Covers | When it runs |
|---|---|---|
| Domain unit tests | Units and pack conversions, money, receipt state machine, intent → command mapping | Every run |
| Storage integration tests | D1 schema, the commit batch, idempotency, tenant isolation, ledger and balances agreeing | Every run, against local D1 (Vitest with Cloudflare's Workers test pool; T1 confirms the package) |
| Contract tests | Meta Model API (vision, structured output, transcription) and WhatsApp payloads, replayed from recorded fixtures through fakes | Every run, no network |
| Live smoke tests | Real API calls with synthetic inputs | Only with `LIVE_TESTS=1`; they spend credits |
| Benchmarks | Extraction accuracy, voice-intent accuracy, time to finalize a receipt | On demand, over consented data kept outside the repo |
| Manual end-to-end | Phone → WhatsApp test number → deployed Worker | Before the field test and before recording |

## Rules

- A default test run never calls a paid or external API and never needs the network.
- Fixtures are synthetic, or anonymized with consent. Strip phone numbers, tokens and IDs from recorded payloads.
- Every bug fix starts with a test that fails.
- Handoffs paste the exact commands and their results. Something that wasn't run is reported as not run.

## PRD acceptance suite: what the hackathon needs

| # | Test ([PRD §10.3](PRD.md#103-minimum-automated-acceptance-suite)) | Hackathon |
|---|---|---|
| 1 | Clear invoice: extraction → correction → approval → one committed receipt | Must |
| 2 | Supplier shortage: 12 invoiced, 10 received → stock rises by 10 | Must |
| 3 | Unknown pack size: stop and ask; never multiply silently | Must |
| 4 | New product photo: catalog entry, no stock change | Valuable (V2) |
| 5 | Voice note: Spanish transcript → proposed action that needs approval | Must |
| 6 | Duplicate webhook, duplicate job, double tap → one set of movements | Must |
| 7 | Stale approval token after a revision fails; the new revision rules | Must |
| 8 | Two stores with identical product names: no reads, writes or aliases across stores | Must |
| 9 | No opening count: the answer says unknown or partial, never zero | Must |
| 10 | Correction: reversal and new adjustment keep the original event | Valuable (V4) |
| 11 | Provider outage or broken image: the job fails visibly and retries safely | Must |
| 12 | Balances rebuilt from the ledger equal the stored balances | Valuable (V4) |

## Benchmark protocol

These numbers go in the demo's impact segment, so they must be real.

- **Invoices:** N consented photos (PRD target 15 or more; report the actual N). They stay outside the repo; the
  benchmark script takes their folder as an argument.
- **Ground truth:** for each line, typed by hand: description, quantity, unit, pack size, unit cost.
- **Metrics:** exact per-field match before human correction; corrections per receipt; minutes from photo to
  confirmed receipt in coached use. Report medians and the worst case, not the best.
- **Voice:** 10–20 consented notes, scripted and free speech. Metric: correct intent and quantities after
  transcription.

## Manual end-to-end checklist

- [ ] Message from an unregistered number → fixed reply, no data.
- [ ] Clear invoice → draft → correct one line → confirm → receipt number → stock question answered.
- [ ] Repeat the confirmation → nothing changes.
- [ ] Voice note → proposal → confirm.
- [ ] A store B number can't see store A's products, drafts or links.
- [ ] Interrupt a job and retry it → no duplicate movements.
- [ ] Signed receipt link: works before it expires; fails after, and fails for another store.
