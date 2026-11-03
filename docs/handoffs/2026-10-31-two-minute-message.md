## Handoff: the two-minute message (#31)

- **Agent and branch:** Claude Code, `claude/two-minute-message` (worktree `hackathon-claude-slowmsg`, built on the
  combined customers + order handler + replies branch). Uncommitted.
- **Objective:** no customer is left hanging when something is slow. A burst still unanswered after 2 minutes gets
  one fixed notice and an urgent Pendientes item; the real answer still goes when ready.
- **References:** issue #31; PRD v1.2 "When something fails, and PAUSA"; Tech Spec v3 "Failures";
  `docs/architecture.md` rule 6 and the new "The two-minute message" bullet.

### Files changed

- New: `src/domain/slow-notice.ts` (limits, kind, dedupe key, empty claims), `test/slow-notice.test.ts`.
- `src/application/sweep.ts`: `queueSlowNotices` runs after the re-rings and before maintenance and the outbox pass;
  `SweepSummary.slowNotices`.
- `src/infrastructure/d1/job-repository.ts`: `findSlowBursts` (new query) and `queueSlowNotice` (one guarded insert).
- `src/application/ports.ts` (add-only): `JobRepository.findSlowBursts`, `JobRepository.queueSlowNotice`,
  `SlowBurst`, `SlowNoticeDraft`, `PendienteUrgency`, `PendienteItem.urgency?`, `SlowReplyPendiente`;
  `Pendientes.raise` now takes `PendienteItem | SlowReplyPendiente` (a widening; existing callers unchanged).
- `src/infrastructure/logging-pendientes.ts`: logs the new item (IDs, `reason: slow_reply`, `status: urgent`).
- `src/domain/replies.ts`: one line added to `COPY` (`slowNotice`).
- `test/helpers/harness.ts`: optional `pendientes` override (add-only).
- `docs/architecture.md`: the sweep section describes the notice.

No migration: the existing UNIQUE `outbound_messages.dedupe_key` is the once-per-burst constraint.
`order-handler.ts`, `composition.ts`, `wrangler.jsonc` and contract files are untouched.

### What was done

- **The query.** `findSlowBursts` returns, across stores, each conversation's oldest open message (pending or
  processing, by receive time) that is more than 2 minutes old and under an hour, when no outbox row of that
  conversation was written at or after it arrived. Leases are ignored on purpose: a model stalled under a live lease
  is the case this is for.
- **The write.** `queueSlowNotice` is one `INSERT … SELECT … ON CONFLICT (dedupe_key) DO NOTHING`. Its `WHERE`
  re-checks, as it writes, that the message is still open and nothing was written to the conversation since. The
  dedupe key `slow_notice:<inbound id>` is UNIQUE. A sweep racing another sweep, or racing the job's completion,
  either writes it or writes nothing: never twice, never after the answer. It is a single statement, so rule 6's
  "0 rows doesn't roll back the rest" doesn't apply: the Pendientes item is raised only when this call wrote the row
  (`changes === 1`).
- **The row.** `kind = 'slow_notice'`, `job_id` NULL (no job group, so a notice that ends unsent never stops the
  answer with `predecessor_not_sent`), `claims_json` NULL. `SlowNoticeDraft.claims` is typed `readonly []`, so the
  notice can't carry a claim and the claim check's second pass returns "none". It expires after 10 minutes and
  dispatch treats it like any member row (order in the conversation, 24-hour window, retries).
- **The copy.** "Recibimos tu mensaje, te respondemos en un momento." (in `COPY.slowNotice`, text from the issue).
  No claims about orders, no blame.
- **Pendientes.** `{ kind: "slow_reply", urgency: "urgent", conversationId, inboundId, outboxId }`. Today that is a
  `pendiente_raised` warn line (IDs only), as for blocked claims.
- **Logs.** `slow_notice_queued` (business, conversation, inbound and outbox IDs), `slow_notice_failed`,
  `slow_notice_scan_failed`; `sweep_done` adds `slow:<n>`.

### Tests run

```text
$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p test/tsconfig.json      (exit 0, no errors)

$ npm test
 Test Files  28 passed (28)
      Tests  313 passed (313)
```

New, in `test/slow-notice.test.ts` (11, local D1, no network): a stalling handler holds every job under its live
lease until released. A burst of three gets nothing at 1 and 2 minutes, one notice at 3, nothing more at 4 and 5;
the notice is sent as written with no engine wired (a row with claims would have gone out as the safe reply); one
urgent `slow_reply` item for the oldest message; after release the answer follows (`[notice, answer]`); logs have
no phone or text. The first tick that queues it lies in (2 min, 3 min] for cron phases 5 s, 30 s and 59.999 s. None
when the answer already went; none when the answer lands between the sweep's scan and its write (hooked D1). Two
concurrent sweeps, and a second sweep run between the first's scan and write, queue it once and raise one item. The
UNIQUE dedupe key alone refuses a second notice when the "nothing written since" check is defeated. A notice that
fails to send doesn't stop the answer. Bursts older than an hour are left alone. Mutation check: dropping the
insert's re-checks makes the race test fail.

### Decisions made on my own (reversible)

1. "Got no reply since" means any outbox row of the conversation written at or after the oldest open message
   arrived: an answer, a failure reply, or an earlier notice. So a stall gets one notice, even when the oldest open
   message changes as earlier jobs finish; a customer who writes again after the notice gets a second one only
   once every message from before the notice is done.
2. A one-hour lookback, so a deploy over long-stuck messages doesn't send stale notices.
3. The notice expires after 10 minutes.
4. The notice is raised from the sweep only; the burst's age is our receive time, not the provider timestamp.
5. "A fake model that stalls" is a stalling `JobHandler`: it stands where perception and the engine run.
6. Widened `Pendientes.raise` to a union instead of overloading `PendienteItem`'s `stage` with a meaning it
   doesn't have.

### Not done, risks, open questions

- **Pendientes only logs.** Nobody sees the urgent item on the console until gap (c) lands.
- A reply written for an earlier message that doesn't close the new burst (say a failure reply for one message of a
  burst) also counts as "written since" and suppresses the notice. Rare; erring toward fewer messages.
- The 24-hour window wasn't tested for this row specifically: the customer just wrote, so it's open. It uses the same
  dispatch path as every member row.
- Not run against a real phone or the remote D1.

### Next steps

- Agree gap (c) and show `slow_reply` items as urgent on the console.
- #41 builds on this.
