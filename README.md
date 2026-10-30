# deed-ledger
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

## Next steps

1. Walking skeleton: WhatsApp webhook → private media storage → reply (Claude Code).
2. Voice notes: OGG/Opus → WAV → Muse Voice Transcribe (Muse Code).
3. Invoice photo → reviewed draft with Muse Spark (Claude Code, reviewed by Codex).

## License

Not chosen yet.
