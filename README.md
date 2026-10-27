# Johan AI

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

October 26, 2026, before the kickoff: planning documents and agent setup only. There is no application code yet.

## Built during the hackathon

The first commit (tag `pre-event-baseline`) holds only planning documents and agent configuration prepared before the
kickoff: the PRD, `docs/`, `AGENTS.md`, `CLAUDE.md` and repository settings. It contains no application code.
Everything after it is hackathon work. This list grows as features land.

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

Prerequisites: Node.js 22, a Cloudflare account (Wrangler runs through `npx`), a Meta Model API key, and a Meta for
Developers app with a WhatsApp test number.

There is nothing to install or run yet. The first engineering task adds `npm install`, `npm test` and `npm run dev`,
and updates this section. Local secrets go in `.dev.vars`, which git ignores. Never commit them.

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
