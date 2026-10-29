# deed-ledger
Agent claims become facts only after the effect is read back from the real system — idempotent, fail-closed, and auditable. A temporal fact memory gates downstream decisions, so cancellations stop what depended on them.

A WhatsApp inventory assistant for small stores. The owner photographs a supplier invoice, sends a voice note, or
asks what's left. Meta's models turn that into a draft, the owner confirms it, and an auditable ledger records it
exactly once.

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

| The owner sends | What happens | Meta model |
|---|---|---|
| A photo of a supplier invoice | Draft receipt: lines, quantities, units, costs; unclear items become questions | Muse Spark (image understanding, structured output) |
| A voice note: "Vinieron dos cajas de doce leches" | A proposed action, read back for confirmation | Muse Voice Transcribe + Muse Spark |
| "¿Cuántas Coca de dos litros me quedan?" | The recorded quantity, and how reliable it is | Muse Spark (intent) + the ledger |
| "Confirmar" | One atomic, idempotent ledger entry; a receipt number and a review link | None. Deterministic code decides |

The model only proposes. Nothing changes stock until the owner confirms the exact draft. Scope and what's deferred:
[docs/hackathon-plan.md](docs/hackathon-plan.md).

## Status

October 28, 2026: the foundation is built and tested. The engine, invoice and voice understanding, and stock
answers come next.

## Built during the hackathon

The first commit (tag `pre-event-baseline`) holds only planning documents and agent configuration prepared before the
kickoff: the PRD, `docs/`, `AGENTS.md`, `CLAUDE.md` and repository settings. It contains no application code.
Everything after it is hackathon work. This list grows as features land.

- October 28: the foundation. WhatsApp webhooks are verified and saved before they're acknowledged, worked through
  in order per conversation, and answered through an outbox. Numbers that aren't members get one fixed reply.

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

## Next steps

1. Walking skeleton: WhatsApp webhook → private media storage → reply (Claude Code).
2. Voice notes: OGG/Opus → WAV → Muse Voice Transcribe (Muse Code).
3. Invoice photo → reviewed draft with Muse Spark (Claude Code, reviewed by Codex).

## License

Not chosen yet.
