# What was built during the hackathon

The event ran October 26 to November 4, 2026. This is the day-by-day record as of November 3, with the commit-level list in [built-during-hackathon.md](built-during-hackathon.md). Work after the November 4 deadline is in `git log`.

## Built during the hackathon

The first commit, `495573e`, holds only planning documents, agent configuration and the
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

As of November 3, not yet on `origin/main`, on stacked local branches (commits counted against the parent, in merge order; `claude/adversary` is the K8 attack run, reviewed PASS):

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
