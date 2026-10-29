## Handoff: foundation part 1 (WhatsApp intake, processing, outbox)

- Agent and branch: Claude Code, `claude/foundation` in the worktree `../hackathon-claude-foundation`. Codex
  reviewed rounds 1 to 3 read-only, and Muse also grilled the first two. Nothing is committed, pushed or deployed, no
  remote command was run, and `.dev.vars` was never read. Angel commits.
- Objective: the base the rest plugs into. WhatsApp webhooks are verified and saved before they're acknowledged,
  worked through in order per conversation under a lease, and answered through an outbox that sends in order, at
  most once, inside WhatsApp's 24-hour window. A number that isn't a member gets one fixed reply and leaves only
  hashes. A placeholder reply stands in for perception and the engine.
- References: plan T1 (walking skeleton); PRD FR-01, FR-02, §6.1, §8.3, §8.4; architecture rules 4, 5, 6 and 8;
  D-09, D-19. What runs, and its limits: [architecture.md, Part 1 as built](../architecture.md#part-1-as-built).
- Files changed:
  - New: `src/` (domain, application, integrations, infrastructure, interfaces), `migrations/0001_tenancy.sql`,
    `migrations/0002_messaging.sql`, `test/` (15 test files and helpers), `scripts/` (local simulator, store
    admin), `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`,
    `worker-configuration.d.ts` (generated), `.dev.vars.example`, `.github/workflows/ci.yml`, this handoff.
  - Edited: `AGENTS.md` (commands), `README.md` (setup, what's built), `docs/architecture.md` (Part 1 as built,
    `SENDER_HASH_SALT`), `docs/security-privacy.md` (`SENDER_HASH_SALT`), `docs/testing.md` (the Workers test
    pool), `docs/status.md`.
- What was done:
  - Round 1, the build. A TypeScript (strict) Worker: Hono routes, D1, R2, a Queue used only as a doorbell, and a cron sweep
    every minute, in the layers `AGENTS.md` sets. Providers sit behind `MessagingChannel`, `MediaSource`,
    `MediaStore`, `Doorbell` and `JobHandler`, so tests use fakes. Tests run inside the Workers runtime against
    local D1 with every secret blanked. A local simulator (`npm run dev:sim`, `npm run simulate`) sends signed fake
    webhooks and sends nothing to WhatsApp.
  - Round 2 fixes (F1–F19, after Codex's "do not merge"). Every job transition is one batch fenced by the lease, the job's
    state and the lease ID. Lease expiry uses D1's clock. Media goes to immutable, content-addressed R2 keys,
    published by a fenced write. Retry times persist, and later jobs wait behind a deferred one. One statement
    decides "settled" and lists the jobs. A failed download is retried, then fails visibly. Ordering uses the
    clamped provider time; the window uses our receive time. Intake answers 200 to permanent errors and 500 to
    transient ones; memberships are never deleted. Duplicates are caught per store and don't ring. The notice is
    retried inline, and only a sent notice holds the 24-hour slot. Spam caps and 7-day retention. At most once:
    the attempt is reserved at claim time, sends time out at 10 s, and unknown outcomes are never resent. Closed
    windows can't starve dispatch. Every reply expires. Replies are split before the batch. Early delivery
    statuses are kept and applied. The verify token compares in constant time. A test proves the 200 comes only
    after the write commits.
  - Round 3 fixes (G1–G11, after "merge after fixes"). A 5xx is an unknown outcome. Replies keep a send order per
    conversation (`seq`), and a group stops after an unsent row (`predecessor_not_sent`). Every outbound row
    expires; failure replies after an hour. Claims use D1's clock and are confirmed right before the send; settles
    check their claim. A burst's closing reply is withheld when a message arrives during its last job. The
    membership is checked inside the intake batch. A photo or voice note without a media ID gets an honest reply.
    Migration 0003 is folded into 0001 and 0002 (no database was ever deployed). Media rows obey admission.
    Notices are pruned by their latest activity. Splitting keeps graphemes whole.
  - Round 4 fixes (H1–H7, after "merge after fixes"; this session).
    - H1. A burst closes only on its last open job. The handler is told `isNewestOfBurst` (renamed from
      `isNewestInRound`) only when the round took every open job, and a closing group is written only if no other
      job of the conversation is open inside its completion batch. Tests: "gets exactly one closing reply from 26
      settled messages, across rounds and processor invocations"; "writes a closing reply only from the burst's
      last open job, whatever the handler marks".
    - H2. Closing is decided per job: `completeJob` takes one `closesBurst` for the job's whole group, and every
      reply of the group carries the same check, so all are written or none. Test: "writes neither a closing draft
      nor the confirmation after it when a newer message arrived, and leaves other jobs' replies alone".
    - H3. The arrival check runs before every job, the first included. The start batch also requires the job to
      be its conversation's next (no open message sorts before it); otherwise it writes nothing, throws
      `StaleSnapshotError`, and the consumer hands off. Tests: "processes a message that arrives between the
      snapshot and the first job's start, and sorts first, before that job"; "refuses to start a job when a message
      that sorts before it arrived after the arrival check".
    - H4. Expiry and the window are judged with a time taken after the claim's confirmation. A confirmation that
      took over 5 s (`CLAIM_CONFIRM_MAX_MS`) isn't sent on: the row is released (a notice's last inline try ends
      it, so its 24-hour slot frees). Tests: the window closing, and the reply expiring, while the confirmation is
      in flight; a slow confirmation; a notice whose last try confirmed slowly.
    - H5. `markSent` and every settle run as one batch guarded by the claim (`guardedBatch`, which `fencedBatch`
      now uses too), so a stale or repeated call writes nothing at all. This replaces the per-statement result
      check. Tests: "a repeated markSent writes nothing"; "a stale settle writes nothing: it stops no group".
    - H6. The splitter's comments say a single grapheme longer than the limit is cut by code units, as the last
      resort. Test: a stacked accent and a family emoji. No behavior change.
    - H7. This handoff, the architecture section and the status entry.
    - Existing tests changed with the behavior. F5's two tests: a round now starts no job once a message arrived
      after its snapshot, and the mid-round arrival sorts after the next job, so the arrival check (not the new
      start guard) is what it tests. F4's "later jobs wait" test also checks that an early doorbell re-rings for
      the retry time without trying the later job, since the start guard alone now keeps the order. The
      unknown-sender test allows `batch_guards`, which holds no data.
- Tests run (round 4, Oct 28, on the final tree):
  - `npm run typecheck` → exit 0, no errors.
  - `npx wrangler types --check` → "Types at worker-configuration.d.ts are up to date."
  - `npm test`, twice → "Test Files 15 passed (15)", "Tests 115 passed (115)" both times.
  - Undo checks (each swaps out one protection, runs its tests and expects them to fail): 54, the 42 from earlier
    rounds plus 12 for H1–H5, all caught, none hung. The first run missed F4b, fixed as described above. The
    checksums of `src/`, `migrations/` and `test/` (60 files) were identical before and after the run.
  - Earlier rounds, for the record: round 2 ended at 87 tests and 28 undo checks, round 3 at 102 tests and 42.
  - The local simulator wasn't rerun this round.
- Not done, risks, open questions:
  - Not done: the real media download (a stub, so every photo and voice note ends with "No pude descargar…");
    interactive messages (the client sends text only); the engine, drafts, perception and the web pages;
    deployment (`database_id` is unset, and remote commands are Angel's).
  - Not tested: deployed D1, the real WhatsApp API, the real media download, and how WhatsApp counts characters.
    `seq` numbering, subqueries inside updates, `UPDATE … FROM`, `RETURNING`, the trigger,
    `unixepoch('subsec')` and `Intl.Segmenter` ran on local D1 and workerd only.
  - Risks: two clocks (leases and claims on D1's, the rest on the Worker's); `unknown_delivery` rows need a person;
    whether Meta can answer 5xx after sending is unknown; a dispatcher that dies mid-send holds its conversation's
    later replies for about 90 s and stops the rest of that group; orphaned R2 objects from stale writers aren't
    cleaned up.
  - Open: none from this round.
- Next steps:
  1. Angel reviews the diff and commits.
  2. The real media download, checked against a real webhook (T1's remaining item).
  3. Deploy (Angel): `wrangler d1 create`, the migrations on the remote database, the secrets, then a populated
     smoke test and `PRAGMA foreign_key_check`.
