# Hackathon execution plan

All times are Honduras time (CST, UTC−6). Deadline: **Wednesday, November 4, 8:00 PM** (9:00 PM ET). Our target:
submitted by **noon on November 4**, leaving the afternoon as buffer.

Rules and sources: [hackathon-requirements.md](hackathon-requirements.md). Product: [PRD.md](PRD.md).

## What wins

| Criterion | Weight | What it needs from us |
|---|---|---|
| Impact | 30% | A real store and a real pain (the notebook). Numbers measured in a field test, not claimed. A second store showing it isn't a one-off. |
| Use of Meta AI Tooling | 25% | Meta models carry the core flow, not a side feature: Muse Spark reads invoices into a strict schema; Muse Voice Transcribe hears Honduran Spanish voice notes; Spark turns words into typed commands that a deterministic engine checks before anything is saved (the "verifiable agent" pattern of the Oct 28 session). Muse Code builds real parts. |
| Technical Depth & Execution | 20% | Exactly-once ledger, revision-bound approvals, tenant isolation proven by tests, visible failure handling. |
| Demo | 25% | A live WhatsApp flow on video, plus a web view judges can open. |

## Scope

The PRD's P0 list is the pilot target. It's more than one person can build and harden in nine days, so the
hackathon cut is below (D-15, proposed). P0 items that aren't "Must" stay P0 for the pilot; they just don't gate the
submission.

### Must-have

| # | Capability | PRD | Notes |
|---|---|---|---|
| M1 | WhatsApp intake: verified webhook, sender → membership, message-ID dedup, media saved privately, fast reply | FR-01, FR-02 | Unknown numbers get a fixed reply and no data |
| M2 | Invoice photo → validated draft through Muse Spark (vision + structured output) | FR-03, §8.5 | Absent means unknown; ambiguities listed |
| M3 | Catalog matching v0: exact name and alias match inside the store; otherwise ask or create. Pack sizes only when known | FR-04 | No fuzzy auto-merge |
| M4 | Review and correction in WhatsApp: received ≠ invoiced, Confirmar / Corregir / Cancelar, confirmation bound to the draft revision | FR-07, J1 | |
| M5 | Atomic, idempotent commit: movements, balances, receipt, audit in one `DB.batch()`; reply with receipt number and link | FR-08, FR-11 | |
| M6 | Voice note → transcript → the same typed intents as text (receive, adjust, inquire, clarify, cancel), proposed and still needing confirmation; voice can also correct an open draft (J1 step 5) | FR-06, J3 | Depends on T2 |
| M7 | Stock question answered with recorded quantity, freshness and baseline status ("not established" when unknown) | FR-09, J4, §3.4 | |
| M8 | Second synthetic store created by an admin script, plus automated cross-tenant denial tests | FR-01, FR-12, J6 | |
| M9 | Read-only receipt page: invoice image, extracted lines, movements, history, behind a signed link | FR-10 (part), FR-11 | The web "trusted result" shot |
| M10 | Deployed demo environment that judges can reach | Rules R11 | See requirements U7 |
| M11 | Field test with Johan and measured numbers: time to finalize a receipt, per-field accuracy, corrections per receipt | §10.1 | Real N reported, even if under 15 |
| M12 | Submission: public repo, "Built during the hackathon" README section, 3-minute video, form | Rules R4–R12 | Checklist below |

PRD acceptance tests that are must-have: 1, 2, 3, 5, 6, 7, 8, 9 and 11 ([testing.md](testing.md)).

### Valuable if time permits (in order)

| # | Capability | Why |
|---|---|---|
| V1 | Price-change alert: a new unit cost against the last one for the same product ("La Coca subió de L14 a L15.50") | Promised in our application; cheap once receipt lines store costs; a strong impact moment |
| V2 | Product photo → catalog entry without touching stock (J2) | FR-05; acceptance test 4 |
| V3 | Pending Reviews in the web app: correct and confirm drafts there | FR-10 |
| V4 | Damage and adjustment movements; correction reversals (J5) | Acceptance tests 10 and 12 |
| V5 | SAM 3.1 visible-item count on a product photo, labeled "visible count", never committed silently | FR-05 experiment; more Meta tooling |
| V6 | Rest of the web workspace: Home, Products, Settings | FR-10 |

### After the hackathon

PRD P1 (guided opening counts, low-stock thresholds, CSV import/export, sales deduction, more roles, multiple
locations, supplier profiles, cost reports), self-service onboarding, a store-owned WhatsApp number (Q-05), retention
and export tooling, a Honduran legal review, an open-weight model path (Muse Glimmer or Muse Spark Open), and the
fiado (credit) ledger from our application, if Johan's answer to Q-01 points there.

## Critical path

```text
Meta app + WhatsApp test number (Angel, day 0)
  → M1 intake → M2 invoice draft (needs real invoice photos by Oct 28) → M4 review → M5 commit → M7 stock question
  → deploy (M10) → field test (M11, Nov 2) → video (Nov 3) → submit (M12, Nov 4 AM)
Parallel: M6 voice (T2, Muse Code) · M8 tenants and tests · M9 receipt page
```

## Dependencies

| Who | What | Needed by |
|---|---|---|
| Angel | Meta Model API account: credits claimed and card added (done Oct 26); spend alert set | Oct 27 |
| Angel | Meta for Developers app with WhatsApp: test number, recipient phones registered, long-lived system-user token | Oct 26 (blocks M1) |
| Angel | Cloudflare account (done Oct 26: existing account, already on Workers Paid) | Oct 26 |
| Angel | GitHub repo (public by submission at the latest) | Before the first push |
| Johan | Consent for data, filming and naming (given Oct 26); 5+ invoice photos by Oct 28; field-test time on Nov 2; answers to Q-01–Q-04 | Oct 26–28 |
| Organizers | Answers to the posted questions (requirements U1–U4, U7) | Oct 28 |

## Highest-risk assumptions

| # | Assumption | Why it's risky | How we test it | By |
|---|---|---|---|---|
| H1 | Muse Spark reads real Honduran supplier invoices well enough that reviewing beats typing | No real samples tested yet; thermal paper, handwriting, abbreviations | Extract 5 consented invoices; measure per-field accuracy | Oct 28 |
| H2 | WhatsApp voice notes can be decoded to WAV inside a Worker | ASR takes WAV only; Workers refuse to compile WebAssembly from raw bytes at runtime (to verify with the chosen decoder). CPU matters less: the account is on Workers Paid (30 s by default) | T2 measures it and recommends | Oct 28 |
| H3 | Voice Transcribe handles colloquial Honduran Spanish in a noisy store | Spanish is supported, but there are no independent accuracy numbers | 10–20 consented notes, scripted and free | Oct 29 |
| H4 | Inventory intake is what Johan wants first | Our application pitched a fiado ledger; the PRD moved to inventory, and the store visit's outcome isn't written down | Ask him (Q-01) | Oct 27 |
| H5 | The WhatsApp test setup stays working for nine days | Temporary dashboard tokens expire after about a day (verify) | M1 on day 1 with a system-user token | Oct 27 |
| H6 | The commit fits in one D1 batch with every guard enforced in SQL | D1 rolls back a batch only when a statement fails; a 0-row `UPDATE` doesn't fail | Design it that way; acceptance tests 6 and 7 | Oct 30 |
| H7 | Judges can see a live product | WhatsApp test numbers reach only registered recipients | Public read-only demo store on the web; ask the organizers | Oct 30 |
| H8 | Nine days are enough | The PRD is broad | This scope cut; feature freeze on the evening of Nov 2 | Ongoing |

## Schedule

| Day | Date | Goal | Exit check |
|---|---|---|---|
| 0 | Mon Oct 26 | Day-0 admin (below). Kickoff 10:00 AM. T1 starts after the kickoff (D-17, proposed) | Meta verifies the webhook (GET challenge) |
| 1 | Tue Oct 27 | M1 done: photo and voice note round trip. T2 starts in Muse Code | Dedup and unknown-sender tests pass; media stored per store |
| 2 | Wed Oct 28 | M2: invoice → draft summary in WhatsApp. First real invoices measured (H1) | 5 invoices extracted, accuracy noted |
| 3 | Thu Oct 29 | M3 and M4: matching, clarifications, text corrections. T2 merged (H2, H3) | Revisions bump; stale confirmations rejected |
| 4 | Fri Oct 30 | M5 and M7: commit and stock answers with truth labels | Tests 1, 2, 3, 6, 7, 9 green |
| 5 | Sat Oct 31 | M6 integrated (voice corrections). M8 second store and isolation tests | Tests 5, 8 green |
| 6 | Sun Nov 1 | M9 receipt page; M10 deploy; V1 if ahead | End-to-end on the deployed environment |
| 7 | Mon Nov 2 | M11 field test at the store with Johan; fix what breaks; feature freeze at 9:00 PM | A real receipt confirmed by Johan |
| 8 | Tue Nov 3 | Benchmark numbers; failure paths (test 11); record and edit the video; README; last day for organizer questions | Video cut done |
| 9 | Wed Nov 4 | Final checks; submit by noon; buffer until 8:00 PM | Submitted; links tested logged out |

### Day 0 (today), Angel

1. Watch the kickoff (10:00 AM), then recheck [hackathon-requirements.md](hackathon-requirements.md). Save the
   Official Rules page as `docs/source/official-rules-2026-10-26.pdf` (git ignores it), next to the guide snapshot.
2. Credits claimed and card on file (done). Check the credits' expiry date on the Billing page, read the Credit
   Terms (PDF linked from the Official Rules), and set the spend-limit alert.
3. Meta for Developers: an app with WhatsApp, a test number, your phone (and Johan's) as recipients, and a
   long-lived system-user token.
4. Cloudflare: done. Angel's existing account, already on Workers Paid.
5. Message Johan: consent for invoices, voice notes, photos and filming; whether the store, the town and his name can
   appear publicly (the product is called "Johan AI"); and what he wants first (Q-01).
6. Muse Code: update, turn Contributor mode off, check the foreign-context settings, and check that its sandbox can
   run commands on this machine ([workflow.md](workflow.md#muse-code)).
7. Post the organizer questions ([hackathon-requirements.md](hackathon-requirements.md#questions-to-post)).
8. Review this repo and accept or change the proposed decisions. Make the first commit only after Johan answers
   about naming (step 5): git keeps everything, so a name committed now stays in the history. If he says no, or
   hasn't answered by the morning of Oct 27 (when T2 needs a commit to branch from), replace the store, the town and
   his name first, including the product name and the PRD PDF's file name. Names can be added back later; removing
   them from history is the hard direction. Tag the commit `pre-event-baseline`. Create the GitHub repo as private,
   and make it public once naming is settled, no later than submission.

## First three tasks

### T1: walking skeleton (Claude Code)

Why Claude: it sets the conventions everything else builds on, touches every layer, and needs back-and-forth with
Angel while he configures Meta and Cloudflare.

- Scaffold: TypeScript (strict), Hono, Wrangler config with D1, R2 and Queue bindings, Vitest with Cloudflare's
  Workers test pool, the folder layout from [architecture.md](architecture.md). Scripts: `dev`, `test`, `typecheck`.
  Then replace the "Commands" line in `AGENTS.md` and the setup section in the README.
- First migration: businesses, locations, memberships (phone → business, location, role), inbound messages (provider
  message ID unique, status), media assets.
- Webhook: GET verification; POST with `X-Hub-Signature-256` checked against the app secret; sender → membership;
  unknown sender gets a fixed Spanish reply and nothing else; message-ID dedup; media downloaded and stored privately
  under the store's prefix; job queued; quick 200.
- Queue consumer placeholder: replies "Recibí tu foto, la estoy revisando" (or voice note) until T2 and T3 land.
- Admin script: create a store, location and owner membership (Angel's number for tests; the synthetic store B).
- Tests: signature check, dedup, unknown sender, tenant-scoped media keys.
- Confirm against a real webhook payload how media is downloaded, and that voice notes match the documented
  `audio/ogg; codecs=opus`.

### T2: voice notes to text (Muse Code), the first Muse task

Why Muse: Meta API work with a clean interface, high uncertainty worth a separate investigation, and it runs in
parallel without blocking the critical path (text corrections work without it). It gives Muse Code a real,
checkable contribution.

Brief to paste into Muse Code (in its own worktree, after T1's scaffold commit; if that hasn't landed by the morning
of Oct 27, start in a standalone `spikes/voice/` folder):

```text
Task: turn a WhatsApp voice note (OGG/Opus bytes) into a Spanish transcript with Meta's Muse Voice Transcribe, in code
that can run in our Cloudflare Worker queue consumer. Measure what it costs in CPU.

Read first: AGENTS.md, docs/status.md, docs/architecture.md (voice pipeline, provider facts), docs/PRD.md FR-06 and J3.

Facts checked Oct 26 in Meta's docs: POST https://api.meta.ai/v1/asr/transcribe, multipart/form-data with a "request"
JSON part ({"mode":"ENDPOINTING","model":"muse-voice-transcribe-1.0","audioEncoding":"WAV", plus "languageBias":
["Spanish"]}) and an "audio" WAV part; Authorization: Bearer <MODEL_API_KEY>. WAV must be mono 16-bit PCM at 16 or 24
kHz; up to 32 MB and 10 minutes. $0.18 per audio hour. Opus decoders usually output 48 kHz, so resample to 24 or 16 kHz.

Deliver:
1. decodeVoiceNote(ogg) -> PCM, and toWav(pcm, sampleRate). Choose a decoder that runs in workerd. Workers refuse to
   compile WebAssembly from raw bytes at runtime, so the .wasm must be importable as a module; verify. Justify the
   dependency: license, size, maintenance.
2. A Transcriber interface and a MetaVoiceTranscriber that calls the endpoint. Tests use a fake.
3. Tests: WAV header and resampling unit tests; a contract test that replays a recorded ASR response (no network by
   default); one live test that runs only when LIVE_TESTS=1.
4. CPU numbers for 5 s, 30 s and 2 min notes. Timers don't advance during synchronous work inside workerd, so measure
   in Node with the same build, and on a deployed preview if Angel deploys one. The account is on Workers Paid
   (30 s CPU per request by default): confirm decoding fits well inside that, or recommend a separate transcoder.
5. Fixtures: commit only synthetic audio (a generated tone or a text-to-speech clip, encoded as OGG/Opus) and
   recorded ASR JSON responses. Angel's own recordings of the PRD J3 phrases stay outside the repo and are used only
   for the live test and the measurements.
6. A handoff in the format in docs/workflow.md, and your row in docs/muse-contributions.md.

Rules: work only on branch muse/voice-pipeline in your worktree. Touch only the voice integration folder, its tests
and fixtures, package.json and the lockfile (for the decoder), and the docs in item 6: your handoff, your row in
docs/muse-contributions.md, and a line in docs/status.md. No other new dependencies without asking. Read the key from
.dev.vars or the environment; never print or commit it. Keep Contributor mode off. Time box: one day. If blocked, write down what you found and stop.

Done when: npm test passes; a recorded Spanish phrase comes back with its key words; CPU numbers and a recommendation
are written down.

Out of scope: intent parsing, WhatsApp media download (T1 provides the bytes), database changes.
```

### T3: invoice photo → reviewed draft (Claude Code, Codex review)

Why Claude: it's the heart of the critical path. Why Codex reviews: the AI output contract is the riskiest trust
boundary, and a second model family catches different mistakes.

- Keep two schemas apart. The model's extraction output holds only what the invoice shows: source text,
  description, invoiced quantity and unit, units per pack and unit cost when printed, currency, ambiguities. The
  server's draft line adds the product match, received quantity, stock unit and revision.
- PRD §8.5 and Appendix A name fields differently (`invoice_qty` vs `invoice_quantity`, `proposed_product_id` vs
  `product_id`). Pick one set, Appendix A's full words by default, and record it in decisions.md.
- Write the extraction schema in Meta's strict structured-output subset: every key required, unknown values as
  `null`, `additionalProperties: false`, no recursion.
- Call `muse-spark-1.3` on the Responses endpoint with the invoice image in the user message and `text.format` set
  to the schema; a fixed system prompt; nothing from the invoice is ever treated as an instruction.
- Validate the output against domain rules (positive exact quantities, known units, lempiras, pack sizes only when
  printed); store draft revision 1 with the model ID and prompt version.
- Send the WhatsApp summary in the PRD §6.1 style.
- Tests: recorded responses, including an invoice that tries prompt injection, and an invoice with an unknown pack
  size.
- Measure the first 5 consented invoices (H1). They stay outside the repo.
- Review: `codex review --base main "Focus: AI output contract, prompt injection, ids taken from model output,
  unknown vs zero"`.

## More Muse Code tasks, for later

Each one is real scope with a clear boundary:

1. Extraction benchmark harness: runs a fixture corpus through the extractor and reports per-field accuracy. This
   independently checks Claude's extractor.
2. Cross-tenant attack suite (acceptance test 8 and FR-01 cases), written by an agent that didn't write the
   repositories.
3. V5: SAM 3.1 visible-item count experiment.
4. Spanish intent evaluation set: synthetic Honduran phrases with the typed intents they should produce.

## Submission checklist

- [ ] Repo public; history scanned for secrets; license chosen.
- [ ] README: what it does, how to run it, which Meta models do what, a "Built during the hackathon" list, team.
- [ ] Three-minute video showing only hackathon-built features, with consented or anonymized data. Link opens while
      logged out.
- [ ] A live product judges can reach (deployed URL plus a demo store, or instructions).
- [ ] Track: Indie. Theme: Build for Your World. Everyone who worked on it listed.
- [ ] [muse-contributions.md](muse-contributions.md) current; every claim in the submission matches evidence.
- [ ] Johan's consent covers everything shown.
- [ ] Optional: the demo posted on X, with the post link submitted (Most Viral prize).
- [ ] Submitted before noon on Nov 4; confirmation saved.

## Needs Angel's approval before implementation

1. The first commit (planning docs and agent config, after Johan's naming answer), and the GitHub repo (name;
   private until naming is settled).
2. The scope cut (D-15) and the other proposed decisions: D-09, D-10, D-14, D-16, D-17, D-19.
3. Spending: done (card on the Meta account, Workers Paid already on). Nothing else paid.
4. The repository license.
5. Johan's consent: done (Oct 26).
6. Muse Code: Contributor mode off, the foreign-context check, and whether Muse runs on your subscription or on an
   API key.
7. Team members for the submission form.
