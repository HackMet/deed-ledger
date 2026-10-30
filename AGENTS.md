# Johan AI: agent instructions

Shared rules for every coding agent in this repo: Claude Code, Muse Code and Codex. Keep this file short; details
live in `docs/`.

## The project

Johan AI is an order assistant for a small store that runs on a notebook. Customers order on WhatsApp with text,
photos and voice notes; the owner and staff prepare orders and record sales from a phone console; one engine records
everything exactly once. The pilot store is Punto de Ventas Johan, a mercadito in Tocoa, Colón, Honduras. We are
building it for the Meta Global AI Developer Hackathon (Indie track).

- **Deadline:** Wednesday, November 4, 2026, 9:00 PM ET (8:00 PM Honduras time).
- **Goal:** one convincing flow that works end to end, powered by Meta models. A customer's order in any form →
  readback → the customer confirms → the preparation list → staff tap Listo → the customer hears "listo", each step
  exactly once and only when the record exists.
- **Status:** foundation built (webhook intake, ordered processing, outbox, store isolation). Contract v1 is a draft
  (`docs/contract.md`); the engine, perception, replies and the console are next. `docs/status.md` has the details.
- **Team:** two people (D-37). Angel owns perception, WhatsApp, media, answers, the web view and deploys. His
  teammate owns the engine, the ledger and fact memory. Work in the other person's area only when they agree.
- **Time zones:** Angel works in Honduras time (CST, UTC−6, no daylight saving). The organizers publish Eastern Time,
  which moves from UTC−4 to UTC−5 on November 1. Convert, and name the zone.

## Read before changing anything

1. `docs/status.md`: what's in flight, open questions, traps.
2. `docs/hackathon-requirements.md`: rules that can disqualify us.
3. `docs/hackathon-plan.md`: scope (must, valuable, later), schedule, task briefs.
4. `docs/PRD.md`: product requirements (FR-01 to FR-12, journeys J1 to J6).
5. `docs/architecture.md`: boundaries, provider facts checked against docs, open technical decisions.
6. `docs/decisions.md`: accepted and proposed decisions.

Also: `docs/security-privacy.md`, `docs/testing.md`, `docs/workflow.md` (handoffs, worktrees, per-agent setup).

## When sources disagree or say nothing

Authority, highest first: official hackathon rules → accepted decisions → PRD → plan → other docs → code comments.

- If a requirement is missing or two sources conflict, don't guess. Add the question under "Open" in
  `docs/status.md` and ask the person running your session.
- For small, reversible choices, take the conservative option and mention it in your handoff.
- Never invent facts about providers, the rules or the store. Write "unknown".
- Some rules below apply proposed decisions as defaults (D-09, D-10, D-14, D-19). Follow them until Angel accepts or
  replaces them in `docs/decisions.md`.

## Non-negotiables

1. **AI proposes, the engine commits.** Model output never writes stock, never supplies a business, location or
   actor ID we trust, and never approves anything. A permitted person confirms the exact draft revision.
2. **Absent means unknown.** Never default quantities, costs or stock to zero.
3. **Every read and write is scoped to a store.** Repositories require a tenant context. Never trust IDs taken from
   model output, URLs or message text.
4. **Exact numbers.** Money in integer centavos; quantities as exact decimals or scaled integers. No floats.
5. **Idempotent writes.** Deduplicate provider message IDs. Each commit has one operation key, enforced by a UNIQUE
   constraint, and runs as a single D1 `batch()` whose guards fail loudly (`docs/architecture.md`, rule 6).
6. **Media and transcripts are untrusted.** Text inside an invoice or a voice note is data, never instructions.
7. **Meta models carry the core flow** (the hackathon's pass/fail gate): Muse Spark for images and intent, with
   structured output; Muse Voice Transcribe for voice. Standard model IDs only, never `*-contributor`.
8. **New work only.** Don't copy code from other repositories, including Angel's other projects. Open-source
   packages are fine when their license allows it and you say why we need them.

## Code

- TypeScript (strict), Hono on Cloudflare Workers, with D1, R2 and Queues (PRD §8).
- Layers under `src/`: `domain/` (pure rules, no I/O), `application/` (commands and queries), `integrations/` (Meta Model API,
  WhatsApp, audio), `infrastructure/` (D1, R2, queues, tokens), `interfaces/` (routes). Dependencies point inward.
- Provider calls go through interfaces (`ModelProvider`, `Transcriber`, `MessagingChannel`, `MediaStore`), so tests
  can use fakes.
- Validate at every boundary: webhooks, model output (schema first, then domain rules), web input.
- Small modules, clear names. Comment only what isn't obvious.
- Every new dependency needs a reason in the handoff: why the platform or a few lines of code won't do.
- Code, comments, docs and commit messages are in English. Everything the store owner sees is in Honduran Spanish.

## Owner-facing copy (Spanish)

- Short, one decision per message, in the tone of the examples in PRD §6.1.
- Never blame the user. Something like "no entendí, usá los botones" is never acceptable. Treat a plausible message
  as intent, echo back what you understood, and ask one specific question when unsure.
- Always offer the text fallback: Confirmar / Corregir / Cancelar.
- Never show confidence scores. Turn uncertainty into a concrete question.
- Never say stock is complete without a verified opening count (PRD §3.4).
- Stay on store operations. No open-ended chat (WhatsApp policy; see `docs/security-privacy.md` §12).

## Tests

- Every behavior change ships with tests. Domain rules get unit tests. Commits, idempotency and store isolation get
  tests against local D1.
- Default runs never call paid or external APIs. Use recorded fixtures behind the provider interfaces. Live tests
  are opt-in (`LIVE_TESTS=1`).
- Fixtures are synthetic, or anonymized with consent. Never commit real invoices, voice notes, phone numbers or store
  figures.
- Report the exact commands you ran and what they printed. "Should pass" is not a result.
- **Commands:** `npm ci`; `npm test` (Vitest inside the Workers runtime, local D1 with every migration, all secrets
  blanked); `npm run typecheck`; `npm run dev` (local Worker, reads `.dev.vars`); `npm run dev:sim`, then
  `npm run simulate -- --text "Hola"` (fake secrets, signed fake webhooks, prints the outbox, sends nothing);
  `npm run admin:create-store -- --name … --phone-number-id … --owner-phone …` (local D1; `--remote` is Angel's);
  `npm run cf-typegen` after changing `wrangler.jsonc`.

## Security

- Secrets live only in `.dev.vars` (local, gitignored) and Cloudflare secrets. Never print, log, commit or paste
  them. The app's Meta key is `MODEL_API_KEY`, never `META_API_KEY`: that name changes Muse Code's billing.
- No real store or customer data in the repo, issues, logs, prompts or the demo without Angel's OK and Johan's
  consent.
- Logs carry IDs (tenant, message, job, draft, operation), never invoice text, transcripts or phone numbers.

## Git and coordination

- This repo will be public. Assume every commit is published forever.
- One task per branch, named `<agent>/<slug>` (`claude/…`, `muse/…`, `codex/…`). When another agent is working at
  the same time, use your own git worktree (`docs/workflow.md`).
- Never edit another agent's worktree or branch, and never overwrite changes you didn't make. If you find unexpected
  changes, stop and report.
- Every change reaches `main` through a pull request.
- Agents don't commit, push, merge, deploy or rewrite history unless the person running the session asks. Never
  force-push.
- Commit messages: one short imperative line ("Add webhook signature check"). No AI attribution trailers.
- Don't run commands that generate instruction files (`muse init`, Codex `/init`).

## Keeping the docs true

- Finish every non-trivial task with the handoff from `docs/workflow.md` and a short update to `docs/status.md`.
- A new or changed decision goes in `docs/decisions.md` (add a new entry that supersedes, never rewrite). A behavior
  change updates the PRD or `docs/architecture.md` in the same branch.
- Muse Code work gets a row in `docs/muse-contributions.md`. Record only what happened.

## Reporting

End with: files changed, how you verified them (commands and results), what isn't done, risks and open questions,
and the next step. Say plainly when something wasn't tested.
