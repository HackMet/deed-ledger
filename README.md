# deed-ledger

## Try it

- **Live link:** [TBD: live link]
- **Video (3 min):** [TBD: video link]
- **One command:** `./demo.sh` runs six synthetic customers (A to F) through the real engine, ledger and console on a local Worker. It exists on the branch `claude/demo-env`, not yet on `main`. **Perception is recorded**: the model's readings of the customers' messages are fixtures (6 fixture, 0 muse) until Angel records real Muse outputs. The engine, ledger and console are live code. `demo.sh` prints that label first and last.

Three numbers, each with where it was measured:

| Number | Value | Measured |
|---|---|---|
| Tests | 1014 passed, 68 files, 0 failed; typecheck exit 0 | `npm test` and `npm run typecheck` on this branch (`claude/submission-docs`, on `origin/main` `7bec048`), 2026-11-03. The tests of the unmerged engine stack: [TBD: `npm test` count on the stack top, `claude/adversary` does not exist yet] |
| Adversary attacks | [TBD: attacks N, false facts admitted M, from the K8 run] | The K8 run has not produced a report yet |
| Witness check | Every commit our agents claimed exists: 0 of 31 claimed commits missing (25 of the 31 stated by the agents themselves). Of the 31: 1 is an ancestor of `origin/main`, 8 landed rewritten (same `git patch-id`), 3 were superseded by a later run, 19 are not on `main` yet (16 on a live branch, 3 only on a backup ref) | RK9 review (PASS), `origin/main` `c15155b`, 2026-11-02. It shows the commits exist, not that their tests passed |

`./demo.sh` does not exit 0 yet. RK10's last run on `claude/demo-env` at `cbce8de` (`DEMO_PORT=8792 ./demo.sh --json`, twice): 29 steps, 21 passed, 8 failed, exit 1 both times. The failures are all staff-side steps (Preparación taps refused, console commits not saved, customer notices not written to the outbox). See `docs/demo-video-script.md` for what the video may and may not show.

## Built during the hackathon: the record

The hackathon's kickoff was Mon Oct 26, 2026, 10:00 AM Honduras time (16:00 UTC). The full per-commit list, with every commit dated before kickoff marked pre-event, is in [`docs/built-during-hackathon.md`](docs/built-during-hackathon.md). Regenerate it right before submitting with `node scripts/built-during.mjs`.

- There is no `pre-event-baseline` tag in the repo (only `backup/*` tags exist), so the boundary is the date. The section below this one that mentions that tag is out of date on this point.
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

Not yet on `origin/main`, on stacked local branches (commits counted against the parent, in merge order; `claude/adversary` is planned and does not exist yet):

| Branch | Commits | Parent |
|---|---|---|
| `claude/engine-issue-12` | 4 | `origin/main` |
| `claude/engine-facts` | 7 | `claude/engine-issue-12` |
| `claude/console-pedidos` | 3 | `claude/engine-facts` |
| `claude/change-requests` | 6 | `claude/console-pedidos` |
| `claude/dispatch` | 4 | `claude/change-requests` |
| `claude/demo-env` | 6 | `claude/dispatch` |
| `claude/adversary` | - | `claude/demo-env` |
| `claude/console-negocio` | 4 | `claude/dispatch` |
| `claude/facturas` | 4 | `claude/console-negocio` |
| `claude/engine-docs` | 4 | `origin/main` |

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

The first commit (tag `pre-event-baseline`) holds only planning documents and agent configuration prepared before the
kickoff: the PRD, `docs/`, `AGENTS.md`, `CLAUDE.md` and repository settings. It contains no application code.
Everything after it is hackathon work. This list grows as features land.

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
- **Invoice reading (K14):** the Facturas screens and a recorded reader exist on `claude/facturas`, but the Muse Spark adapter that reads a real invoice photo is pending. [TBD: confirm K14 status before submitting]
- **K16:** [TBD: what K16 is and whether it landed; it was not in the verified inputs]

## Next steps

1. Walking skeleton: WhatsApp webhook → private media storage → reply (Claude Code).
2. Voice notes: OGG/Opus → WAV → Muse Voice Transcribe (Muse Code).
3. Invoice photo → reviewed draft with Muse Spark (Claude Code, reviewed by Codex).

## License

Not chosen yet.
