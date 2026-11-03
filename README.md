# deed-ledger

An AI agent that takes orders for small stores. Nothing it tells a customer counts as true until the store's own
records say so: every claim is read back from the database before the message goes out.

Customers order through WhatsApp with typed text, a photo of a handwritten list, or a voice note. Meta's models read
what they sent and plan the next step. Code checks every proposal, the customer confirms a readback of every line
and the total, and staff prepare the order from a console on their phone. Each message, decision and tap is saved
exactly once. WhatsApp is the first channel, not the product: it sits behind one interface (`MessagingChannel`).

Built for the [Meta Global AI Developer Hackathon](https://dev.meta.ai/events/global-hackathon), Indie track,
October 26 to November 4, 2026.

## Why

Many small stores in Honduras keep their records in a notebook. A notebook is fast and flexible, but it can't say
who is waiting for what, what an order came to, or whether it's ready, and it is gone if it gets wet. Store
software usually asks for forms, typing and a computer. The store and its customers already spend the day on
WhatsApp, so the agent works there, with the messages, photos and voice notes people already send.

## Pilot

Punto de Ventas Johan, a mercadito in Tocoa, Colón, Honduras, whose records live in a notebook. The live demo uses
none of its data: it runs a synthetic store with made-up products. Every read and write is scoped to one store, and
tests run two stores side by side (`test/isolation.test.ts`).

## What the agent does

| Who sends what | What happens | Meta model |
|---|---|---|
| A customer: a photo of a handwritten list, then "y agregale dos libras de azúcar" | One order. The agent asks only what's missing, one kind of question at a time, then reads back every line and the total | Muse Spark (reader and planner) |
| A customer: a voice note | Decoded from OGG/Opus to WAV inside the Worker, transcribed, then read like typed text | Muse Voice Transcribe, then Muse Spark |
| A customer: "¿A cómo está el aceite?" | Answered from the store's records; when they don't know, "te confirmo" and an item for the owner | Muse Spark reads the question; code answers |
| A customer: "Confirmar" (button or typed) | The order goes on the preparation list once; a second tap is a duplicate | None: code decides |
| Staff: Listo or No hay on the console | The customer hears "listo" only after the tap; a missing item is reported with the new total | None |

## How it works

The model proposes, code validates, the engine commits, and a person confirms (`AGENTS.md`, decision D-45).

1. **Intake.** The webhook checks Meta's signature, finds the store from the receiving number, and saves the
   message (deduplicated by WhatsApp's ID) before it answers 200. Messages sent close together are read as one.
2. **Reading.** Muse Spark turns text, a transcript or a photo into typed observations (strict JSON schema). Each
   points at its evidence (the exact words, or a box on the photo); code drops any whose evidence doesn't hold.
   Text inside a photo or a voice note is data, never instructions.
3. **Planning.** A second Muse Spark call, the planner, proposes the next step: which product each line is, what to
   ask, when to read back (`src/application/planner/`). It has no write tools. For text and voice, one call reads
   and plans (`one-call.ts`); photos take two.
4. **Checking.** Code keeps only products it offered for that line, quantities that were said, and phrases from a
   fixed set (`src/domain/planner/validate.ts`); the readiness gate (`src/domain/readiness.ts`) has the last word.
   If the planner fails, the message takes the classic path, and the failure is logged.
5. **Replies.** Code writes every reply from fixed Spanish templates (`src/domain/replies.ts`). Each reply's claims
   (a price, a total, "ya está en la lista") are checked against the engine's outcome before saving and against
   the records right before sending. A claim that doesn't hold sends a safe reply and raises an item for the owner.
6. **Commit.** Every tap carries an operation key, and its save runs in one D1 batch with the messages it causes.
   A repeated key answers "duplicate" with the first outcome; a tap on an older version of the order is refused.

Product matching uses no vector database (D-49): word search over the store's whole catalog, plus words customers
used ("catsup" for ketchup) that the store approved in the console. The planner's instructions come in layers: a
base file, one for the business type (`mercadito.md`), and the store's own data in D1 (D-48).

## Meta models

| Model | ID | Where |
|---|---|---|
| Muse Spark | `muse-spark-1.3` | The reader, the planner, the one-call text path and the console's Anotar reader (`src/integrations/meta/spark.ts`) |
| Muse Voice Transcribe | `muse-voice-transcribe-1.0` | Voice notes, after decoding to mono 16-bit WAV (`src/integrations/meta/transcribe.ts`, `src/integrations/audio/`) |

Standard model IDs only; the Muse Spark provider refuses `*-contributor` IDs (D-09). Every Muse Spark call goes
through a per-store daily spend cap, US$2 by default (`src/application/metered-call.ts`). Reasoning effort is set
per call (reader `low`, planner `minimal`), and prompt-cache keys name the instruction version, never a store or a
customer (D-52). The eval suite can also use Muse Spark to score the replies' Spanish (`npm run eval -- --judge`).

## Status (November 3, 2026)

- **Live** on Cloudflare Workers (D1, R2, Queues, a one-minute cron). Every merge to `main` runs the tests and
  deploys (`.github/workflows/deploy.yml`); every pull request runs the typecheck and the tests.
- **The demo** runs a synthetic store, "Tienda demo (sintética)", with 40 made-up products, the planner on, and
  test commands for the store's own members (`/new`, `/help`). Its engine is a pretend engine
  (`src/infrastructure/memory/d1-pretend-engine.ts`) that follows the real engine's contract (versions, operation
  keys, roles) and keeps each store's state in D1.
- **The order engine and the fact ledger** are merged into `main` and tested on local D1
  (`src/application/engine/order-engine.ts`, `src/infrastructure/d1/fact-ledger.ts`): versioned orders, operation
  keys as the idempotency anchor, an audit trail, cancellations as compensating entries. The running app doesn't
  use them yet: the engine still needs the preparation list, the claim check and prices ([status](docs/status.md)).
- **Tested from a phone** on the live number: a typed order, a voice-note order, and a photo of a handwritten
  11-item list (all 11 read, items the store doesn't carry kept and never priced), each through readback,
  Confirmar, the customer's name, the staff's Listo or No hay, and the customer's notice. Text replies take 9 to 21 s
  (4 to 7 s per model call, plus a 3 s wait for more messages); a photo about 34 s. The target is under 10 s.
- **Eval:** 32 scripted customer conversations on the local simulator (`npm run eval`). On November 3 the planner
  path completed 27 to 28 and the classic path 12 to 16. Neither had a truth failure: a wrong product, an amount
  the records don't back, a contradicted order state, or an injected instruction that worked.
- **Not done:** supplier invoices (tested, not wired in); Anotar shows what it read and saves nothing yet.

## Built during the hackathon

The first commit, `495573e` (tag `pre-event-baseline`), holds only planning documents, agent configuration and the
written cases for the first model experiments: the PRD, `docs/`, `AGENTS.md`, `CLAUDE.md`, repository settings and
the JSON cases now in `spikes/cases/`. It contains no application code. The repository's other root commit,
`7002275` (October 28), only created this README. Everything after them is hackathon work.

- **October 27:** day-one experiments in `spikes/`, run with Muse Code: Muse Spark turning Spanish messages and
  synthetic invoice photos into schema-checked output, Muse Voice Transcribe on six voice notes, and deterministic
  tests of the trust rules (merges `0e88c83`, `5e5428b`, `2eef1c3`, `bd1176c`, `aaf2c36`).
- **October 28:** voice notes decoded inside a Worker with libopus as WebAssembly (`0993b19`). The foundation:
  webhooks checked and saved before they're acknowledged, worked through in order per conversation, answered
  through an outbox, every read and write scoped to a store (`2b2cf6f`).
- **October 29:** docs only (the team split).
- **October 30:** the contract between reading, the engine and the console (`5ed312f`); engine saves in the batch
  that completes a job (`6979b06`); order reading with Muse Spark and a spend cap (`02bd4d9`); Spanish replies,
  the claim check and reply buttons (`6452973`); media download, transcription, and photos and voice notes in
  orders (`5806f19`, `b19e490`); console login, shell and Empleados (`dfce488`, `dd6591a`); the Anotar reader
  (`888cce6`); the first message, ALTO, handoff to a person and data deletion (`e412877`). Engine side: ledger
  tables and fact commits (`7c4cbf8`, `63afad3`, `20d00ec`), a read before every guard (`83c6f52`), the order
  engine with derived operation keys (`d44f175`, `39c1b88`, `62d1ce1`).
- **October 31:** review fixes: login forms, cut-off voice notes, spend bounds, an evidence check on every reading
  (`6358228`, `8cf8ddb`, `c9db45b`, `ec1de58`); the terminal chat simulator (`4ff74f9`, `bd5f343`); the pretend
  engine on D1 behind login (`f6c008b`); stock, price and hours questions answered from records (`0cbee76`);
  delivery to a saved place (`7137a97`). Engine side: cancellations (`b4aa6ac`).
- **November 1:** the console's tabs, Más, Pendientes and order pages; conversation rules: greetings and thanks
  decided by code, the name asked at Confirmar, never silent (`a05c8d5`).
- **November 2:** the engine merged into `main` (`d014bab`, `c15155b`); the store's products, prices, hours and
  delivery fee on the console (`3d09e59`); whole-catalog search and store-approved aliases (`bdcdb29`); the
  planner (`01e42e0`, `87b0d77`, `7b0b025`); reasoning effort and prompt-cache keys per call (`3a274a3`); text
  read and planned in one call (`d20e272`); the eval suite, built with Muse Code (`a6eab4e`, merged in `944a5bc`).
- **November 3:** option answers, and voice read like text (`902515c`); test commands for members (`0445da1`); a
  reply footer (`d5feba0`); an offer to write instead when a photo or voice note can't be read (`136aade`); real
  WhatsApp voice notes accepted, downloads checked against Meta's hash and size (`174d0cf`); final review fixes
  (`623dcdb`); deploy on every merge (`c408870`); pull request #63 merged and deployed (`7bec048`).

## Try it

<!-- TODO(Angel): production WhatsApp number + wa.me link -->

The WhatsApp number to message goes here. For now the Worker answers on Meta's WhatsApp test number, which only
delivers to phones registered in advance, so it isn't listed. Write in Spanish: an order as text, a photo of a
handwritten list, or a voice note, then tap Confirmar. `https://store-assistant.atiendeme.workers.dev/health`
answers `ok` while the Worker is up. The staff console (`/console`) needs a login link from the store's owner; in
the local simulator below it opens without one.

## Development setup

Node.js 22. Tests and the simulator need nothing else. Reading real messages needs a Meta Model API key; real
WhatsApp needs a Cloudflare account (Wrangler runs through `npx`) and a Meta for Developers app with a test number.

```bash
npm ci
npm test                            # Vitest in the Workers runtime, local D1 with every migration applied
npm run typecheck
npm run dev:sim                     # local Worker, fake secrets, a synthetic store; nothing is sent to WhatsApp
npm run chat                        # in a second terminal: chat with it as a customer
npm run simulate -- --text "Hola"   # or send one signed fake webhook and print the outbox
```

Without a model key, the simulator answers orders with a fixed placeholder. `npm run dev:sim -- --ai --planner`
has Muse Spark read and plan for real (about US$0.01 per message), with `MODEL_API_KEY` from the environment or
`.dev.vars`; the console is at `http://127.0.0.1:8787/console`. `npm run eval` needs a simulator started with
`--ai --store`. For a real WhatsApp test number, copy `.dev.vars.example` to `.dev.vars` (gitignored; never commit
it), fill it in, and run `npm run dev`. Tests blank every secret. Deploying: [docs/deploy.md](docs/deploy.md).

## Repository layout

- `src/`: `domain/` (pure rules: the contract, money, readiness, the planner check, reply templates),
  `application/` (the order handler, reading, the planner), `integrations/` (Meta models, WhatsApp, audio),
  `infrastructure/` (D1, R2, the queue, the pretend engine), `interfaces/` (webhook, console, queue, cron).
- `migrations/` (D1 schema), `test/` (Vitest on local D1, recorded model answers), `scripts/` (simulator, chat,
  eval, admin), `spikes/` (day-one experiments and results).
- `docs/`: [status](docs/status.md), [decisions](docs/decisions.md), [architecture](docs/architecture.md),
  [contract](docs/contract.md), [deploy](docs/deploy.md), [hackathon rules](docs/hackathon-requirements.md), and
  `handoffs/`. `PRD.md` and parts of `architecture.md` still describe the earlier inventory design.

## How it's built

Two people: one on conversations, reading, replies, the console and deploys; the other on the engine (orders and
the fact ledger). Claude Code is the main development tool. Meta's Muse Code takes separately scoped tasks: it ran
the day-one experiments and built the eval suite ([docs/muse-contributions.md](docs/muse-contributions.md)). Muse
Wonder and OpenAI Codex gave independent reviews of the planner design (D-45), and Codex reviews the riskiest
changes. All three coding agents read [AGENTS.md](AGENTS.md). Details: [docs/workflow.md](docs/workflow.md).

## License

Not chosen yet.
