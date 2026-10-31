# Architecture

The baseline is [PRD §8](PRD.md#08-technical-architecture): TypeScript and Hono on Cloudflare Workers, D1, R2,
Queues, the Meta Model API and the WhatsApp Cloud API. This file doesn't repeat it. It adds what the build needs: the
request flow, module boundaries, provider facts checked on October 26, 2026, and the technical decisions still open.

Part 1 of the foundation is built: intake, processing and the outbox, described in
[Part 1 as built](#part-1-as-built). Everything else in this file is the plan.

The PRD's stack holds up. Angel has shipped this exact stack before (Workers, Hono, D1, the WhatsApp Cloud API and
D1-backed Vitest tests), and on a nine-day solo build familiarity matters more than anything else. Two real problems
surfaced, and both are handled below rather than by changing the stack: voice notes need decoding before
transcription (A1), and D1 commits atomically only inside a single batch (rule 6).

## Flow

```text
WhatsApp Cloud API
  │ webhook
  ▼
Worker (Hono): check signature → store from the receiving number → sender becomes the store's customer → dedup message ID
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
| Structured output | Responses: `text.format`; Chat Completions: `response_format` with `json_schema`. Decoding is constrained to the schema. With `strict: true`: every key required, `additionalProperties: false`, no root `anyOf`, no recursion. Works with image input. Verified live Oct 30: `muse-spark-1.3` accepts an `anyOf` of object variants nested in an array inside the root object, and `["type", "null"]` (`docs/handoffs/2026-10-31-reading.md`) | [structured output](https://dev.meta.ai/docs/structured-output) |
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
| `SENDER_HASH_SALT` | Key for the HMAC that replaces phone numbers and message IDs of numbers that aren't members (message IDs embed the sender's phone number) |
| `LINK_SIGNING_SECRET` | Signs the console's CSRF values; required, or the console answers 503 |

## Part 1 as built

The WhatsApp foundation: messages come in, are worked through in order per conversation, and are answered through an
outbox. The engine, drafts, perception and the web pages aren't built; a placeholder handler stands where the engine
plugs in. Where this differs from the planned [flow](#flow) (media is downloaded by the queue consumer, after the
200), this section is what runs. Constants live in `src/domain/processing.ts` and `src/domain/outbox.ts`.

### Intake (`POST /webhooks/whatsapp`)

- The `X-Hub-Signature-256` HMAC is checked over the raw bytes before anything is parsed. The GET subscription check
  compares SHA-256 hashes of both verify tokens in constant time.
- The store comes from `metadata.phone_number_id`, by exact match in `channel_accounts`. With no match, the event is
  dropped and only its type is logged.
- Every event is saved before the 200. A transient failure answers 500, so Meta retries; a constraint violation
  answers 200 with an ID-only log.
- Anyone writing to the store's number is that store's customer (0004); memberships only matter for the console. A
  message is one batch: the customer (one per store and phone, so the same phone in two stores is two customers),
  the conversation (one per store number and customer), a pending media asset, the inbound message (which is also
  its job) and `last_inbound_at_ms`. Every message and media insert checks admission itself: the provider message ID
  isn't stored yet in this store, and the conversation has fewer than 300 messages in the last hour. A message that
  isn't admitted leaves no message or media row. The phone is kept on the customer only to send replies, and never
  logged.
- Ordering uses the provider timestamp clamped to [received − 7 days, received + 5 minutes]. The 24-hour window uses
  our own receive time of a new message; a redelivery doesn't move it.
- After the 200, each conversation with a new message gets a doorbell: a Queue message with only the store and
  conversation IDs. D1 holds the work, and the cron sweep re-rings what a lost doorbell left.
- The unknown-sender path (one fixed reply, keyed hashes only) is retired: intake no longer calls it. Its tables,
  repository method and the notice dispatch stay until the team agrees to remove them; the sweep still expires and
  prunes rows written before 0004.
- Delivery statuses only move a sent row's status forward. One that arrives before the send result is stored is
  kept for up to an hour under a hash of the message ID, and applied when the result is stored.

### Processing: one conversation at a time

- **Lease.** A doorbell's consumer leases the conversation for 60 s by the database's clock and extends it before
  each job. The lease ID is a fencing token: every write is one D1 batch whose guards (the lease is held, the job is
  in the state the transition expects) fail the whole batch (rule 6). A stale consumer's writes are refused and it
  stops. A consumer that finds the lease busy re-rings in 3 s.
- **Settle.** One statement counts the open jobs and lists them, oldest first by (ordering time, receive time, ID),
  but only once every open job is at least 3 s old, so a burst is handled together. Until then the consumer hands
  off: it releases the lease and re-rings for when the newest message has settled. A round takes up to 25 jobs; an
  invocation runs up to 5 rounds, then hands off.
- **Order.** Before every job, the round's first included, the consumer checks whether a message arrived after the
  round's snapshot; if one did, it hands off and continues in order once that message has settled. A job's start
  batch also checks that the job is its conversation's next one: when an open message sorts before it (one that
  arrived after that check), nothing is written and the consumer hands off the same way. A job waiting for its retry
  time holds back every later job of its conversation.
- **Retries.** A failed attempt is retried after 5 s times the attempt number. The third failure ends the job with
  an honest reply in Spanish, as does a job whose last attempt died with its consumer. A photo or voice note without
  a usable media ID ends at once with its own reply.
- **Media.** The consumer downloads a message's media and stores it in R2 at `stores/<store>/media/<asset>/<sha256>`,
  an immutable key. D1 records the key only through a fenced write. The download is still a stub, so every photo and
  voice note ends with "No pude descargar…" after its retries.
- **Handler.** `JobHandler` (`src/application/ports.ts`) is where the engine plugs in: it gets the job and
  `isNewestOfBurst`, and returns replies already rendered plus optional `commits`. With an engine wired in, the order
  handler (`src/application/order-handler.ts`) runs; without one, `placeholderHandler` acknowledges a burst with one
  reply from its newest message.
- **Readback answers.** A reply button's ID is the operation key `confirm:<order>:v<version>` (or `correct`,
  `cancel`; at most 256 characters), untrusted, and resolved by the engine only among the customer's own orders. The
  same word typed alone ("confirmar", any case, with or without accents) answers the readback last queued to the
  conversation (`conversations.last_readback_*`), only if it arrived after that readback was queued, and shares the
  button's key, so the second of the two is a duplicate. An answer is its own step: it goes to `Engine.onCustomerAction` at its own job, after every earlier save.
- **Burst reads.** Other messages are read together at the burst's newest job, or at the last job before an answer.
  Earlier jobs complete with no reply. The reading's job loads the conversation's unread messages (`burst_reads`,
  0005: done jobs, or itself; failed ones never; the last hour; all of them, or a loud failure above 300) and saves which ones it used in the same
  batch as the engine's commits, guarded so a message is never used twice. A crash or lost lease before the save
  leaves them unread for the retry; a message arriving during handling waits for its own reading. A readback is
  remembered (and the name marked asked) only when its reply is written, so a typed word never answers a readback the
  customer didn't get.
- **Customers.** `CustomerRepository` builds the channel-side commits the handler adds to the job's batch: the name
  (saved once, first answer wins), that the name was asked (once), and the readback shown. Business records are the
  engine's.
- **Commits.** A `Commit` is the engine's guards and statements. `completeJob` runs them in the batch that completes
  the job, after the lease and job guards, so a stale writer gets `StaleWriteError` first. The facts, the job's
  completion and its replies save together or not at all; commits save even when a closing reply is withheld. A
  commit guard that doesn't hold rolls back everything and the job retries (`commit_refused`), reading the records
  again; a constraint violation fails the job with its failure reply (`commit_rejected`). A commit's `post` guards
  (checked after its statements) are refused the same way until the fence runs them (D-40 covers the D1 types).

### How a burst closes

- A job is told `isNewestOfBurst` only when it was its conversation's last open job as its round began; never the
  last job of a full round with more open jobs behind it.
- A reply marked `closesBurst` closes the burst. That is decided per job: if any reply of a job closes the burst, the
  job's completion batch writes all of its replies only when no other job of the conversation is open, and otherwise
  writes none of them (logged as `burst_reply_withheld`). The job still completes, and the burst's later job answers.
  Other jobs' replies are written as they come.
- So a burst gets one closing reply, from its last job, however many rounds or invocations it takes. When that last
  job fails, the burst gets the job's failure reply instead.

### The outbox

- **Writing.** Replies are written in the same batch as the job transition that produced them. They are split
  before the batch into parts of at most 4096 UTF-16 code units: at whitespace, else between graphemes. A single
  grapheme longer than the limit is cut by code units, never inside a surrogate pair. Each row gets a send order
  (`seq`, unique across the outbox; the insert takes the next number, and D1 runs one batch at a time) and its group:
  the job, the reply's index and the part's index. Every row expires; the placeholder, failure replies and the
  unknown-sender notice after an hour.
- **Send order.** A conversation's rows go out one at a time, in `seq` order: a row can go only when every earlier
  row of its conversation has settled (sent, failed, expired or `unknown_delivery`). The dispatcher runs after each
  doorbell for that conversation, and from the sweep. It lists only the oldest unsettled row of each conversation
  whose window is open, so rows that can't go out never fill its page.
- **Groups.** When a row ends unsent (failed, expired or `unknown_delivery`), the later rows of its group are failed
  as `predecessor_not_sent` in the same batch, and the sweep repeats that. A confirmation never goes out without the
  draft before it. Other groups aren't affected.
- **Claims.** A dispatcher claims a row for 30 s by the database's clock, which reserves one send attempt; the claim
  re-checks the conversation's order and the group in the same statement, and a row in `sending` is never claimed
  again. After its reads, the dispatcher confirms the claim and extends it by 30 s. A fresh time, taken after that
  confirmation, decides expiry and the window right before the send. A confirmation that took over 5 s isn't sent
  on, since the claim might not outlast the send's 10 s timeout: the row goes back to pending (a notice's last try
  ends it). `markSent` and every settle run as one batch guarded by the claim: a stale or repeated call writes
  nothing, early statuses and group stops included, and logs `outbox_claim_lost`.
- **Outcomes.** Sent: the provider message ID is kept for members only, since it embeds the phone number. A 429 is
  retried, up to 5 attempts; another 4xx fails the row. A 5xx, a timeout, a dropped connection or an unreadable 200
  becomes `unknown_delivery` and is never sent again automatically: at most once. A dispatcher that dies mid-send
  leaves its row `sending`; once the claim has run out, the sweep marks it `unknown_delivery`.
- **24-hour window.** It runs from our receive time of the member's newest message. A reply whose window has closed
  waits as `waiting_window`, with its attempt given back, and goes out when the member writes again if it hasn't
  expired by then.
- **Sweep, every minute.** Re-rings conversations with due jobs older than 30 s and no live lease, expires rows,
  settles claims that ran out, stops groups, marks closed windows, ends notices pending for over 15 minutes, deletes
  old unknown-sender records and early statuses, then sends up to 50 rows.

### Replies and the claim check

- `src/domain/replies.ts` renders every engine outcome and customer notice from a fixed Spanish template
  (`OUTCOME_TEMPLATES`, `NOTICE_TEMPLATES`: a new kind fails typecheck until it has one). Numbers, names, prices
  and states come from the outcome; customer words quoted back are flattened and capped at 60 characters.
- Each reply carries its claims as `ClaimCheck`s: a check holds when any of its alternatives does ("ya está en la
  lista" holds while the version is confirmado, preparando or listo). Order-line prices are pinned by the version
  claim; there is no per-line price claim in the contract yet.
- First pass (`src/application/replies.ts`), before the save: claims are read back from the outcome; an order
  total counts only when it equals the sum of its lines (gap j proposal: per line, half up; unknown makes the
  total unknown; unavailable and restricted lines left out; the delivery fee shown apart).
- Second pass (`dispatch.ts`), right before the send, through `Deps.claimVerifier` (the engine's `verifyClaims`).
  A check that fails, or no engine wired, sends the safe fixed reply instead, sets `claims_blocked_at_ms` on the
  row, fails the reply's later parts and raises a Pendientes item. An engine error retries the row later. Claims
  and buttons live on the row (migration 0006); a stored value that can't be read never holds.
- Pendientes from outside the engine (gap c) go through the `Pendientes` port; today it only logs.
- Reply buttons: up to three, IDs are operation keys (`confirm:<order>:v<version>`, `correct:…`, `cancel:…`,
  `substitute:<order>:v<version>:<line>`, `remove:…`). `WhatsAppCloudChannel.sendButtons` sends Meta's
  interactive reply-button shape, or plain text when the buttons don't fit; the body always carries
  "Respondé Confirmar, Corregir o Cancelar". Typed words map to the same keys (`typedDecision`).

### The engine boundary and the console (dev only)

- The contract between perception, the engine and the console is `src/domain/contract/` with the `Engine` interface
  in `src/application/engine.ts`; [contract.md](contract.md) explains it. It is a draft until the spec meeting.
- `Runtime.engine` is null until the real engine is wired in. With `DEV_CONSOLE=1` (only the local simulator sets
  it) it is an in-memory pretend engine (`src/infrastructure/memory/`) seeded with synthetic orders. It follows the
  contract's version, operation-key and role rules but saves to memory and forgets on restart.
- `/console/preparacion` renders the preparation list server-side for a 360 px screen and refreshes every 15 s.
  Each button posts one action to `/console/acciones` with the version on screen and its own operation key; the
  result redirects back with a notice when the tap was refused. Without a real engine the list answers 503.
- **Login** (`src/interfaces/http/console/auth.ts`, migration 0003). An invite is a 32-byte random code, stored as
  its SHA-256 hash, valid 15 minutes, one use, for one member. `GET /console/entrar?codigo=…` only shows it (a link
  preview can't use it up); the "Entrar" POST uses it and opens a session in one guarded batch, so two taps can't
  both win. The session cookie (`consola`, Path `/console`, HttpOnly, Secure, SameSite=Lax, 30 days) holds another
  random token, also stored hashed. Every request re-reads the session and requires an active membership; "Quitar"
  sets `revoked_at_ms`. Every POST carries a CSRF value, an HMAC of the session ID with `LINK_SIGNING_SECRET`;
  without that secret the console answers 503. The store and the actor always come from the session.
- **First login:** `npm run admin:invite -- --phone-number-id … --phone … --role owner|staff [--remote]` adds the
  person as a member if needed and prints a link. The raw code is only printed, never written to disk.
- **Dev mode** (`DEV_CONSOLE=1`, local simulator only) skips login and CSRF with a fixed demo member.
- **Screens** live in `src/interfaces/http/console/`, one file each, rendered through the shared layout in
  `layout.ts` (header, tabs, notice). A new screen is a file that registers its routes, one line in `index.ts`, and
  a tab in `NAV` if it needs one.
- **Empleados** (`empleados.ts`, owner only): invite by phone (a new person becomes staff; an owner's number is
  refused), "Código nuevo", the fiado permission, and "Quitar", which deactivates the membership, expires unused
  invites and revokes every session. Only staff memberships of the session's store can be changed there, so an
  owner can't lock themselves out; owners are managed with `admin:invite`. Inviting a removed person again
  reactivates them with fiado off.
- **Voice-note notice** (`bienvenida.ts`, migration 0008): until a member taps "Entendido", logging in shows that voice
  notes are kept as the store's records.
- **Console reader** (`src/application/console-reader.ts`, #26): `readConsoleInput(deps, member, { purpose, inputs })`
  reads up to three pieces (typed text, a transcript, photos) as one burst. `report` uses the console prompt and
  kinds; `order` (Pedido a mano) uses the order prompt with no open order and keeps only `customer_order`,
  `fulfillment`, `customer_name` and `other`. The store is the member's. Photos (at most 5 MB, JPEG/PNG/GIF/WebP by
  their bytes) are stored at `stores/<business>/console/<sha256>` before the call; text is capped at 2,000
  characters; audio answers "not yet" until #27. It returns the reading, matches and stored media for display and
  saves no observation. **Anotar** (`anotar.ts`, owner and staff) is its screen; its body limit runs before the
  CSRF check reads the body.

### Known limits

- Two clocks: leases and claims run on D1's clock; settling, retries, reply expiry and the 24-hour window use the
  Worker's.
- `unknown_delivery` rows need a person to follow up. Whether Meta can answer 5xx after sending is unknown.
- A dispatcher that dies mid-send holds back its conversation's later replies until the first sweep after its claim
  ends (about 90 s), and stops the rest of that group.
- The shared "Tienda" account isn't designed yet: every login is one member with a phone number.
- The media download is a stub. A stale writer can leave an unpublished R2 object behind, and nothing cleans those up.
- Messages over a conversation's hourly cap are dropped and logged, not queued. A conversation that keeps receiving
  messages less than 3 s apart keeps waiting to settle.
- The send order relies on D1 running one batch at a time. Subqueries inside updates, `UPDATE … FROM`, `RETURNING`,
  the membership trigger, `unixepoch('subsec')` and `Intl.Segmenter` are verified on local D1 and workerd only, not
  on a deployed database. How WhatsApp counts characters is unknown.
