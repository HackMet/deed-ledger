# deed-ledger

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
| **C3** ★ | **The verdict is issued by fixed arithmetic, never by a model.** Re-runnable by a third party from the entry alone. | ✅ built and tested |
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

## Try it

- **Live link:** [TBD: live link]
- **Video (3 min):** [TBD: video link]
- **One command:** `./demo.sh` runs six synthetic customers (A to F) through the real engine, ledger and console on a local Worker. It exists on the local branches `claude/demo-on-main`, `claude/owner-on-main` and `claude/deed-on-main` (the engine stack merged onto `main` after #63), not yet on `main`. **Perception is recorded**: the model's readings of the customers' messages are fixtures (6 fixture, 0 muse) until Angel records real Muse outputs. The engine, ledger and console are live code. `demo.sh` prints that label first and last.

Three numbers, each with where it was measured:

| Number | Value | Measured |
|---|---|---|
| Tests | 1269 passed, 89 files; typecheck exit 0 | `npm test` and `npm run typecheck` on `claude/deed-close` at `ba7aa87`, 2026-11-03. This branch (`claude/submission-docs`) runs 1014 passed, 68 files |
| Attacks | 9 attacks that reach the engine: 0 false facts admitted. One more attack is intake only and is not counted | `node scripts/adversary.mjs` on `claude/adversary` at `dd3a342`, exit 0, reviewed PASS (RK8). Removing a defence on purpose turns its row red, except one K12 scope that an older read still catches (RK8 N1). Perception is recorded fixtures; the engine, ledger and console are live code |
| Harness runs | 109 run names, last attempt of each (48 earlier attempts were overwritten with no verdict): 53 confirmed, 0 contradictions, 56 with no claim. The printed line is `{'n': 53, 'rho1': 0.0, 'vif': 1.0, 'n_eff': 53}` | `deed_check_harness.py` on 2026-11-03, rows in `docs/deed-verdicts.csv`, page in `docs/deed-scale.html`. Confirmed only means the commit exists and the runner recorded it for that run; tests are not re-run, and a false statement with no sha is not detected. The verdicts ran on our clone with a checker and runs that aren't published, so a reader can recompute the counts and look up shas, not repeat the verdicts. With no contradictions, n_eff and the CUSUM show nothing about dependence |

`./demo.sh` exits 0: 29 steps, 29 passed, on `claude/demo-on-main` (`47a2d5c`, twice) and on `claude/owner-on-main` (`e446233`) and on `claude/deed-on-main` (`8ec9f87`), `DEMO_PORT=8795 ./demo.sh`, 2026-11-03. The staff-side steps that failed on `claude/demo-env` (Preparación taps, console saves, customer notices) pass there: each console tap saves through `runConsoleAction` (#63) and the customer's notice is read back from the outbox. See `docs/demo-video-script.md` for what the video may and may not show.

On `claude/deed-on-main` two more things exist, both local and reviewed PASS:

- **The Deed view.**
  - `/console/deed/<order>` draws the order's facts as a graph: live, closed, blocked by a closed ancestor, or pending review. Each refused attempt is drawn beside the fact that decided it.
  - `/console/deed/verificaciones` lists every refusal and claim check the engine made, from an append-only `deed_checks` table that holds IDs and codes only.
  - On customer E in the demo, measured by the coordinator: the graph has 2 closed facts, 2 live ones and 1 "Intento rechazado". The feed reads "Intentos rechazados 4", by reason "ya se hizo antes" 2 and "el estado no lo permite" 2, with the row "✗ Intentó marcar listo · ancestro cancelado".
  - The demo runs no claim check. Claim-check rows are proven by tests only.
- **`DEED_ENGINE=1`.** It runs the app on this engine, with Angel's Muse reader reading through it. It is off by default and waits for Angel's OK.

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

## Why

Many small stores in Honduras keep their records in a notebook. A notebook is fast and flexible, but it can't answer
"how much is left?", can't show what a supplier actually delivered, and is gone if it gets wet. Store software usually
asks for forms, typing and a computer. The owner already spends the day on WhatsApp, so the product works through
photos, voice notes and questions there.

## Pilot

Punto de Ventas Johan, a mercadito in Tocoa, Colón, Honduras, whose records live in a notebook. A second, synthetic
store runs through the same flows to show the product serves other businesses with fully separated data.

## What it will do

| Who sends what | What happens | Meta model |
|---|---|---|
| A customer: a photo of a handwritten list, then "y agregale dos libras de azúcar" | One order, one question at a time, then a readback with every line and the total | Muse Spark (image understanding, structured output) + Muse Voice Transcribe |
| A customer: "Confirmar" | The order goes on the preparation list, exactly once | None. Deterministic code decides |
| Staff: Listo, No hay, on the console | The customer hears "listo" only after the tap; an out-of-stock line becomes one question | None |
| Staff: a voice note of a walk-in sale | A sale with its prices, saved in one tap | Muse Voice Transcribe + Muse Spark |

The model only proposes. Nothing is saved until a person confirms it, and nothing is said without a record behind it.

## Status

October 30, 2026: the foundation is built and tested. The contract between understanding and the engine is a draft,
and the staff's preparation list runs locally. The engine, order understanding, replies and the console's login come
next.

## Built during the hackathon

Every commit on `origin/main` is dated after the kickoff (the first is 2026-10-27); the full record, with each commit,
PR and branch, is in [`docs/built-during-hackathon.md`](docs/built-during-hackathon.md) and summarised above. This list
grows as features land.

- October 28: the foundation. WhatsApp webhooks are verified and saved before they're acknowledged, worked through
  in order per conversation, and answered through an outbox. Numbers that aren't members get one fixed reply.
- October 30: the engine's saves land in the same batch that completes a message's job. The draft contract between
  understanding, the engine and the console. The staff's preparation list, running locally on a pretend engine.

## Repository layout

```text
AGENTS.md                      rules every coding agent follows
CLAUDE.md                      Claude Code entry point (imports AGENTS.md)
docs/
  status.md                    what's in flight, open questions, traps
  hackathon-requirements.md    official rules, with sources and what they mean for us
  hackathon-plan.md            scope, schedule, first tasks, submission checklist
  PRD.md                       product requirements (working copy of the PDF)
  architecture.md              flow, boundaries, checked provider facts, open decisions
  decisions.md                 decision log
  contract.md                  the contract between perception, the engine and the console (draft)
  security-privacy.md          security, privacy and legal checklist
  testing.md                   test layers, acceptance suite, benchmark protocol
  workflow.md                  how Claude Code, Muse Code and Codex share the repo
  muse-contributions.md        record of work done with Muse Code
  source/                      original PDFs
```

## Development setup

Prerequisites: Node.js 22. Tests and the local simulator need nothing else. Running against real WhatsApp needs a
Cloudflare account (Wrangler runs through `npx`) and a Meta for Developers app with a WhatsApp test number.

```bash
npm ci
npm test                            # Vitest in the Workers runtime, local D1 with every migration applied
npm run typecheck
npm run dev:sim                     # local Worker, fake secrets, a synthetic store; nothing is sent to WhatsApp
npm run simulate -- --text "Hola"   # in a second terminal: a signed fake webhook, then the outbox
```

To run against a real WhatsApp test number, copy `.dev.vars.example` to `.dev.vars`, fill it in, and run
`npm run dev`. Git ignores `.dev.vars`; never commit it. Tests blank every secret, whatever `.dev.vars` holds.

## How it's built

Claude Code is the main development tool. Meta's Muse Code takes separately scoped tasks, recorded in
[docs/muse-contributions.md](docs/muse-contributions.md). OpenAI Codex does independent reviews. All three read
[AGENTS.md](AGENTS.md). Details: [docs/workflow.md](docs/workflow.md).

## Next

Cut from the hackathon scope, in the order we would build them:

- **Campaigns as facts.** A `campaign` fact with a validity window; promo prices `dependsOn` it, so ending the campaign expires the promo prices through the gate, the way a cancellation already stops what depended on an order.
- **Invoice reading (K14):** the Facturas screens and a recorded reader of synthetic invoices are on `claude/owner-on-main`; every other photo is refused as unreadable. The Muse Spark adapter that reads a real invoice photo is pending, with its prompt draft in `docs/prompts/receipt-reading.md` on that branch, for Angel's review.

## Next steps

1. Walking skeleton: WhatsApp webhook → private media storage → reply (Claude Code).
2. Voice notes: OGG/Opus → WAV → Muse Voice Transcribe (Muse Code).
3. Invoice photo → reviewed draft with Muse Spark (Claude Code, reviewed by Codex).

## License

Not chosen yet.
