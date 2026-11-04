# deed-ledger

An AI agent that takes orders for small stores. Nothing it tells a customer counts as true until the store's own
records say so: every claim is read back from the database before the message goes out.

Customers order through WhatsApp with typed text, a photo of a handwritten list, or a voice note. Meta's models read
what they sent and plan the next step. Code checks every proposal, the customer confirms a readback of every line
and the total, and staff prepare the order from a console on their phone. Each message, decision and tap is saved
exactly once. WhatsApp is the first channel, not the product: it sits behind one interface (`MessagingChannel`).

Built for the [Meta Global AI Developer Hackathon](https://dev.meta.ai/events/global-hackathon), Indie track,
October 26 to November 4, 2026.

## Qué es Deed

**Deed is an architectural pattern: a double-entry ledger for an agent's effects.** The agent's claim is one leg of
the entry; the world writes the other. A fact exists only when the two balance, and facts govern what the agent is
allowed to do next.

Deed is the product that implements three levels. They are not the same thing:

| Level | What it is | Analogue |
|---|---|---|
| **Pattern** | The design rule: who may write what, and when something counts as a fact | Saga, Outbox, Event Sourcing |
| **Protocol** | The shape of the entry: who · what · witness · verdict · dependencies | A bank statement; TCP's segment |
| **Measurement** | The arithmetic on top: balance, liveness, and reliability under dependence | Statistical process control; an audit |

The pattern's name is **Double-Entry Effect Ledger**; "Agentic ledger" is the short name.

### What it is NOT

- **Not an audit log.** A log records what the actor says it did, written by the actor. Deed records what an
  independent party can corroborate.
- **Not LLM-as-judge.** No model issues a verdict, ever.
- **Not output verification.** The question is not "is the answer good" but "did the effect happen in the world".
- **Not a hallucination detector.** A claim with no trace in any system is marked unverifiable, not refuted.
- **Not a signed-receipt library.** Those exist (about twenty projects, and three IETF SCITT drafts as of October
  2026). A receipt records one party's observation. Deed is the bookkeeping on top of receipts.

### The eleven conformance criteria

Each one is testable. Fail one of the four load-bearing ones (★) and it isn't Deed; it's an audit log with good
branding. The other seven can be partial and it is still recognisably Deed.

| # | Criterion | Status |
|---|---|---|
| **C1** ★ | **A claim is not a fact.** The actor writes only the claim leg and a pointer to where its counter-leg must appear. Separation of write permissions, enforced structurally. | ✅ built and tested |
| **C2** ★ | **Every fact carries evidence from a source the actor does not control.** No evidence, no fact. | ✅ built and tested. The order's Libro view (`/console/deed/:pedido/libro`) pairs each claim with its witness. The demo has no WhatsApp statuses, so delivery reads *en duda* there |
| **C3** ★ | **The verdict is issued by fixed arithmetic, never by a model.** Re-runnable by a third party from the entry alone. | ⚠️ partial: no model issues a verdict, built and tested. `node scripts/deed-recheck.mjs <entry.json>` re-runs an order's verdicts from its exported entry alone (`docs/deed-entry-example.json` is a synthetic one), and `python3 scripts/deed_check_harness.py --evidence docs/deed-run-evidence.jsonl --compare docs/deed-verdicts.csv --out v.csv` re-runs the harness verdicts, counting any commit a clone lacks apart. The commit guards run in D1, not over an entry |
| **C4** | **Admission is atomic with the effect.** The fact, the reply and the job's completion live or die in one transaction. "Saved" cannot exist without the fact. | ✅ built and tested |
| **C5** | **Append-only, with validity.** Never updated, never deleted. A correction is a new fact; a cancellation closes an interval. | ✅ as stated above: append-only enforced by schema; no hash chain, no signatures |
| **C6** ★ | **Dependencies gate at commit time, not with an `if`.** Liveness is derived from closures, never cascaded by writes. | ✅ built and tested |
| **C7** | **Uncertainty is a first-class outcome.** Silence is not failure; a fetch error is never a contradiction. | ⚠️ **partial, and say so:** the view surfaces *en duda*; the engine does not model an in-doubt state in the order flow. Showing it is not the same as having it. |
| **C8** | **Reliability is measured per (agent id, effect class), under dependence.** Agent errors arrive in bursts, so a Bernoulli interval is mis-specified. | ⚠️ partial: `docs/deed-scale.html`, from harness runs only, not store orders. There the id is sha256(model + brief), not `facts.agent_id`. It shows no contradictions, and no group reaches the 30 claims n_eff needs, so n_eff is one aggregate that proves no independence |
| **C9** | **Nothing identifies, scores, profiles or tracks a person.** The unit is an agent version and an effect class. | ✅ built and tested |
| **C10** | **The core is agnostic.** No business nouns inside it; a new business flow is a new policy, never an edit to the core. | ❌ cut. Never claimed. |
| **C11** | **The agent is identified, and the identity travels.** Every fact records which agent version made the claim; every customer-facing output carries a code that resolves to that entry. | ⚠️ partial: every customer fact records the agent version (see the limit below). No customer-facing output carries a code yet |

C7, verbatim from the status table: *mostrar 'en duda' en una pantalla no es lo mismo que modelarlo en el motor*
(in English: showing "en duda" on a screen is not the same as modelling it in the engine).

**C11, built:** `facts.agent_id` is 8 hex characters of SHA-256 over the model, the prompt versions and the schema
names. The runtime stamps it, and the model never supplies it. Customer facts carry it, staff and owner facts are
NULL, and the order trail shows the agent beside each customer fact. Planner calls are not in the hash yet.

**C11's honest limit:** an identity the agent writes about itself is self-declared. What makes it trustworthy is that
it sits in the same batch as a fact an independent witness corroborated. The identity is worth exactly as much as its
entry, no more.

### Next for Deed

Agnostic core (C10, K17), signatures, watermarks, C2PA, hash chain.

## Deed: what was measured

| Number | Value | Measured |
|---|---|---|
| Tests | @@TESTS@@ | `npm test` and `npm run typecheck` on this branch, November 4, 2026 |
| Attacks | 9 attacks that reach the engine: 0 false facts admitted. One more attack is intake only and is not counted | `node scripts/adversary.mjs`, exit 0. Removing a defence on purpose turns its row red, except one K12 case noted in the script's review |
| Harness runs | 109 run names, last attempt of each (at least 51 earlier attempts were overwritten with no verdict): 53 confirmed, 0 contradictions, 56 with no claim. The printed line is `{'n': 53, 'rho1': 0.0, 'vif': 1.0, 'n_eff': 53}` | `deed_check_harness.py` on 2026-11-03, 11:10 PM Honduras time, rows in `docs/deed-verdicts.csv`, page in `docs/deed-scale.html`. Confirmed only means the commit exists and the runner recorded it for that run; tests are not re-run. Only the first sha on the `RESULT: COMMITTED` line is read, so any other false statement, with a sha or without one, is not detected. so a reader re-runs them from the published evidence, and about a quarter of those shas exist only in local copies. With no contradictions, n_eff and the CUSUM show nothing about dependence |

`./demo.sh` runs six synthetic customers (A to F) through the real engine, ledger and console on a local Worker, on recorded perception, and ends by re-checking three exported entries over HTTP.

Screens: `/console/deed/<order>` (the order's facts as a graph), `/console/deed/<order>/libro` (AGENTE, LIBRO and MUNDO paired), `/console/deed/verificaciones` (every refusal and claim check), `docs/deed-scale.html` (harness runs, static).

**`DEED_ENGINE`:** `wrangler.jsonc` sets it to `"1"`, so a deployed Worker runs on this engine. It wins over `PRETEND_ENGINE`. With no planner read on this engine, `CONVERSATION=planner` falls back to the classic reader.

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

## Built during the hackathon: the record

The hackathon's kickoff was Mon Oct 26, 2026, 10:00 AM Honduras time (16:00 UTC). The full per-commit list, with every commit dated before kickoff marked pre-event, is in [`docs/built-during-hackathon.md`](docs/built-during-hackathon.md). Regenerate it right before submitting with `node scripts/built-during.mjs`.

- **Baseline (agreed with Angel):** everything dated before Mon Oct 26, 2026 10:00 AM Honduras time is baseline, and so
  are the tools used to build this (Claude Code, Muse Code, Codex, and the local agent harness, which is not in the
  repo). Neither is claimed as new work.
- There is no `pre-event-baseline` tag in the repo (only `backup/*` tags exist), so the boundary is the date.
- `origin/main` at `7bec048` has 146 commits, 0 dated before kickoff (author dates, UTC), by Angel-Rodas (117), kerly (21), kercmari (7) and x (1), as `git log --format=%an` shows them.

Pull requests (`gh pr list --state all`, 2026-11-03):

| # | Title | Author | Opened (UTC) | State |
|---|---|---|---|---|
| #1 | Add planning docs, agent instructions and experiment cases | Angel-Rodas | 2026-10-29 15:15Z | merged 2026-10-30 06:57Z |
| #2 | Add model and voice spikes with results | Angel-Rodas | 2026-10-29 15:15Z | merged 2026-10-30 06:57Z |
| #3 | Add foundation: webhook intake, ordered processing, outbox, store isolation | Angel-Rodas | 2026-10-29 15:16Z | merged 2026-10-30 06:57Z |
| #4 | Add engine commits, contract v1 draft and dev preparation list | Angel-Rodas | 2026-10-30 15:27Z | merged 2026-10-30 20:02Z |
| #61 | Add console login with single-use invites and sessions | Angel-Rodas | 2026-10-30 22:49Z | merged 2026-10-31 14:31Z |
| #62 | Order engine and fact memory: the save batch, read-before-guard, and the engine wired behind a fixture adapter | kercmari | 2026-10-31 08:17Z | merged 2026-11-02 17:45Z |
| #63 | Add the customer order flow, replies, reading, media and console screens | Angel-Rodas | 2026-10-31 12:13Z | merged 2026-11-03 16:53Z |
| #64 | Renumber our migrations to 0020-0022 to clear Angel's 0004-0017 | kercmari | 2026-11-02 18:28Z | merged 2026-11-02 18:36Z |

Not yet on `origin/main`, on stacked local branches (commits counted against the parent, in merge order; `claude/adversary` is the K8 attack run, reviewed PASS):

| Branch | Commits | Parent |
|---|---|---|
| `claude/engine-issue-12` | 4 | `origin/main` |
| `claude/engine-facts` | 7 | `claude/engine-issue-12` |
| `claude/console-pedidos` | 3 | `claude/engine-facts` |
| `claude/change-requests` | 6 | `claude/console-pedidos` |
| `claude/dispatch` | 4 | `claude/change-requests` |
| `claude/demo-env` | 6 | `claude/dispatch` |
| `claude/console-negocio` | 4 | `claude/dispatch` |
| `claude/facturas` | 4 | `claude/console-negocio` |
| `claude/engine-docs` | 4 | `origin/main` |
| `claude/stack-on-main` | 2 | `origin/main` |
| `claude/demo-on-main` | 4 | `claude/stack-on-main` |
| `claude/owner-on-main` | 2 | `claude/demo-on-main` |
| `claude/engine-reads` | 5 | `claude/owner-on-main` |
| `claude/deed-graph` | 10 | `claude/owner-on-main` |
| `claude/deed-on-main` | 2 | `claude/engine-reads` |
| `claude/adversary` | 2 | `claude/demo-on-main` |

`claude/stack-on-main` is the stack above (through `claude/dispatch`) merged onto `main`, `claude/demo-on-main` adds `claude/demo-env` on top of it, `claude/owner-on-main` adds `claude/facturas` (with `claude/console-negocio`), and `claude/deed-on-main` joins `claude/engine-reads` (K21) and `claude/deed-graph` (K20). Their counts leave out the commits already counted in the rows above (`git log B ^parent ^claude/dispatch`, `git log B ^parent ^claude/demo-env` `git log B ^parent ^claude/facturas` and `git log B ^parent ^claude/deed-graph`), so only the new ones remain, merges included.

Angel's PR #63 is merged; it is on `main` and no longer a local branch.

Agent claims become facts only after the effect is read back from the real system — idempotent, fail-closed, and auditable. A temporal fact memory gates downstream decisions, so cancellations stop what depended on them.

An order assistant for small stores. Customers order on WhatsApp with text, photos of their list or voice notes;
Meta's models read what they sent, the customer confirms a readback, and staff prepare the order from a phone. An
auditable ledger records every step exactly once.

Built for the [Meta Global AI Developer Hackathon](https://dev.meta.ai/events/global-hackathon), Indie track,
October 26 to November 4, 2026.

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
