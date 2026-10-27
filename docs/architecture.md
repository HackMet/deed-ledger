# Architecture

The baseline is [PRD §8](PRD.md#08-technical-architecture): TypeScript and Hono on Cloudflare Workers, D1, R2,
Queues, the Meta Model API and the WhatsApp Cloud API. This file doesn't repeat it. It adds what the build needs: the
request flow, module boundaries, provider facts checked on October 26, 2026, and the technical decisions still open.

No code exists yet. Nothing here describes a running system.

The PRD's stack holds up. Angel has shipped this exact stack before (Workers, Hono, D1, the WhatsApp Cloud API and
D1-backed Vitest tests), and on a nine-day solo build familiarity matters more than anything else. Two real problems
surfaced, and both are handled below rather than by changing the stack: voice notes need decoding before
transcription (A1), and D1 commits atomically only inside a single batch (rule 6).

## Flow

```text
WhatsApp Cloud API
  │ webhook
  ▼
Worker (Hono): check signature → sender → membership (unknown: fixed reply, no data) → dedup message ID
               → save media to R2 under the store's prefix → queue a job → 200
  │
  ▼
Queue consumer
  image: Muse Spark (vision, strict JSON schema) → validate → draft revision 1 (D1)
  audio: OGG/Opus → WAV → Muse Voice Transcribe → Muse Spark (typed intent, JSON schema) → proposal (D1)
  text:  Muse Spark (typed intent, JSON schema) → proposal or answer
  → WhatsApp reply: summary + Confirmar / Corregir / Cancelar
  │
  ▼
Owner confirms (button or text) → Worker: actor, store, revision and token checks → domain command
  → one D1 batch: operation key, guards, movements, balances, receipt, audit → reply: receipt number + signed link

Web (signed link) → Worker → receipt detail and movement history (read-only for the hackathon)
```

## Module boundaries

The PRD's layers (§8.2), applied pragmatically:

```text
src/
  domain/          pure rules: units and money (exact), receipt state machine, movement types, policies. No I/O.
  application/     commands and queries (receive invoice, correct draft, approve, commit, ask stock).
                   Every one takes a tenant context. Declares the provider interfaces below.
  integrations/    meta-model-api (vision, structured output, transcription), whatsapp (webhook, send, media),
                   audio (OGG → WAV)
  infrastructure/  D1 repositories, R2 media store, queue producer and consumer, signed tokens, config
  interfaces/      Hono routes: webhook, web pages, admin
```

- `domain/` imports nothing from the other folders. Dependencies point inward.
- Interfaces exist where they pay for themselves: `ModelProvider`, `Transcriber`, `MessagingChannel`, `MediaStore`
  and the repositories. Tests swap in fakes; nothing else needs one.
- Only `application/` starts writes. Repository methods require a tenant context argument.
- Web pages: server-rendered from Hono (no separate frontend build) unless T1 finds a reason otherwise. The PRD asks
  for 360 px screens, large touch targets and Spanish labels.

## Rules every change must keep

1. **The model proposes, the engine commits.** Model output never carries business, location or actor IDs we trust.
   The server fills them in. The model has no write tools and no database credentials.
2. **Schema-constrained, then validated.** Every model call uses structured output, gets parsed, then checked
   against domain rules. It is stored with the model ID and prompt version (FR-11).
3. **Absent means unknown.** No zero defaults for quantities, costs or stock.
4. **Exact numbers.** Money in integer centavos; quantities as scaled integers or decimal strings. No floats.
5. **Idempotency.** Provider message IDs are unique at ingestion. Every logical commit has one operation key, unique
   in the database.
6. **One batch per commit.** D1 runs a `batch()` as one SQL transaction and rolls back everything if any statement
   fails. So every precondition (draft state, revision, token not used, stock not negative) must make a statement
   *fail*: a UNIQUE or CHECK violation. A guarded `UPDATE` that matches 0 rows doesn't fail, and the rest of the
   batch would still apply. Materialized balances (FR-08) earn their keep here: a CHECK on the balance stops verified
   stock from going negative inside the same batch.
7. **Media text is data.** Invoice text and transcripts reach the model only as user content under a fixed system
   prompt. Instructions inside them are ignored by design, and tests prove it.
8. **Logs carry IDs, not content.** Tenant, message, job, draft and operation IDs; never invoice text, transcripts or
   phone numbers.

## Provider facts (checked October 26, 2026)

Sources are Meta's and Cloudflare's docs. Re-check anything that blocks a decision.

| Area | Fact | Source |
|---|---|---|
| Meta Model API | Base URL `https://api.meta.ai/v1`; `/responses` and `/chat/completions` (OpenAI-style) and `/messages`; `Authorization: Bearer` | [image understanding](https://dev.meta.ai/docs/image-understanding) |
| Models | `muse-spark-1.3` is recommended for new work: text, image, video, audio and PDF in; text out; 1,048,576-token context. Its audio input "isn't fully supported" and may be degraded | [models](https://dev.meta.ai/docs/models) |
| Models | `*-contributor` IDs are cheaper because Meta may train on the content. Not for our data (D-09) | [pricing](https://dev.meta.ai/docs/pricing-rate-limits) |
| Images | JPEG, PNG, GIF, WebP (no HEIC); up to 50 MB inline, 50 images per request; by URL, base64 data URL or file ID; only in user messages; about 1,300–1,500 tokens for a 1280 px image | [image understanding](https://dev.meta.ai/docs/image-understanding) |
| Structured output | Responses: `text.format`; Chat Completions: `response_format` with `json_schema`. Decoding is constrained to the schema. With `strict: true`: every key required, `additionalProperties: false`, no root `anyOf`, no recursion. Works with image input | [structured output](https://dev.meta.ai/docs/structured-output) |
| Speech to text | `POST https://api.meta.ai/v1/asr/transcribe`, multipart (`request` JSON + `audio`); model `muse-voice-transcribe-1.0`; **WAV only: mono, 16-bit PCM, 16 or 24 kHz**; up to 32 MB and 10 min; `languageBias` hint; 25 languages including Spanish; turn-level timestamps; no confidence scores; SSE streaming option; the realtime WebSocket also takes raw PCM only | [speech to text](https://dev.meta.ai/docs/speech-to-text) |
| Prices | Spark 1.3: $1.25 per million input tokens, $4.25 output, $0.15 cached input. Voice: $0.18 per audio hour. SAM 3.1: $2.50 per 1,000 images. Wonder: $4 / $20 | [pricing](https://dev.meta.ai/docs/pricing-rate-limits) |
| Rate limits | Per team: Spark 3,000 RPM and 4M TPM; Voice: 256 concurrent streams | [pricing](https://dev.meta.ai/docs/pricing-rate-limits) |
| Keys | Meta's API examples use `MODEL_API_KEY`. Muse Code reads `META_API_KEY` first, ahead of its sign-in, so the app must not use that name (D-19) | [Muse auth](https://dev.meta.ai/docs/muse-code/auth) |
| D1 | `batch()` statements run as one SQL transaction; if one fails, the whole batch rolls back | [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/) |
| Workers | CPU per invocation: Free 10 ms; Paid 30 s by default, up to 5 min | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Queues | On the Free plan since Feb 4, 2026: 10,000 operations a day, 24 h retention. Paid: 1M operations a month included, retention up to 14 days | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| WhatsApp | A voice recording arrives in the webhook as an audio message with `mime_type` `audio/ogg; codecs=opus` and `voice: true` | [audio message webhook](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/audio) |

To confirm in T1 with real payloads (not checked against docs today):

- How media is downloaded: media ID → URL → authorized GET, and how long the URL stays valid.
- The temporary access token on the app dashboard expires after about a day; a system-user token doesn't.
- How many recipient numbers a WhatsApp test number can message.

## Open technical decisions

| ID | Question | Options | Lean | Decide by |
|---|---|---|---|---|
| A1 | Where OGG/Opus → WAV decoding runs | (a) WebAssembly decoder in the queue consumer (the account is on Workers Paid: 30 s CPU by default); (b) a small external transcoder; (c) send audio to Spark directly (rejected: degraded, D-10) | (a), pending T2's numbers | Oct 28 |
| A2 | How owners reach the web pages | Signed links over WhatsApp (D-16); passwords; WhatsApp one-time codes | Signed links | Oct 30 |
| A3 | Which Cloudflare account and plan | — | Decided Oct 26: Angel's existing account, already on Workers Paid. Use API tokens scoped to this project's resources | Done |
| A4 | Which WhatsApp number | A Meta test number for the hackathon; PRD Q-05 is for later | Test number | Oct 26 |
| A5 | How judges see a live product | A public read-only demo store with synthetic data on the web; WhatsApp shown on video | Ask the organizers (requirements U7) | Oct 30 |

## Configuration

Local secrets live in `.dev.vars` (gitignored, blocked for Claude's Read tool). Deployed secrets live in Cloudflare
secrets. The expected names (T1 confirms them):

| Name | What |
|---|---|
| `MODEL_API_KEY` | Meta Model API key, standard models only |
| `WHATSAPP_TOKEN` | Long-lived system-user token for the WhatsApp Cloud API |
| `WHATSAPP_APP_SECRET` | App secret, for checking webhook signatures |
| `WHATSAPP_VERIFY_TOKEN` | Random string for the webhook GET challenge |
| `LINK_SIGNING_SECRET` | Key for signed web links and approval tokens |
