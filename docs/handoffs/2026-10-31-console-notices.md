## Handoff: console taps save with their customer messages (#18)

- **Agent and branch:** Claude Code, `claude/console-notices` (worktree `hackathon-claude-notices`, on the combined
  branch with the console, customers, replies, reader, order trip, media, console reader and two-minute notice).
  Nothing committed.
- **Objective:** a staff tap and the WhatsApp message it causes ("Tu pedido ya está listo") save together, once.
- **References:** issue #18; `docs/contract.md` ("The engine saves nothing itself", "The claim check runs twice");
  `docs/architecture.md` rule 6; handoffs `2026-10-31-order-trip.md`, `-replies.md`, `-console-shell.md`.

### Files changed

- New: `src/application/console-actions.ts` (`runConsoleAction`, `consoleNoticeDedupeKey`),
  `migrations/0014_console_notices.sql` (`outbound_messages.operation_key` + index), `test/console-actions.test.ts`.
- `src/application/ports.ts` (add-only): `ConsoleNoticeDraft`, `QueuedConsoleNotice`,
  `OutboxRepository.conversationOfCustomer`, `OutboxRepository.saveConsoleAction`, `NoticeWaitingPendiente`;
  `Pendientes.raise` widened to take it.
- `src/infrastructure/d1/outbox-repository.ts`: the two methods; groups are now "same job, or same operation key in
  the same conversation" in the claim, the group stop and `markClaimsBlocked`'s rest-of-reply.
- `src/application/errors.ts` (add): `NoticeConversationMissingError`.
- `src/infrastructure/logging-pendientes.ts`: logs the new item (IDs only).
- `src/interfaces/http/console/preparacion.ts`: `/console/acciones` calls `runConsoleAction`, dispatches the
  notified conversations after the response (`waitUntil`), and shows "No se pudo guardar. Revisá el pedido y tocá
  otra vez." when the save is refused.
- Tests: `test/order-flow.test.ts` (first order now expects the pushed notice, once, also after a double tap),
  `test/helpers/engines.ts` (add: `CommitEngine`, `StaleOrderError`), `test/secrets.test.ts` (migration list).
- `docs/architecture.md`: "Console notices (#18)" under the outbox; console paragraph points at it.

### What was done

- The engine decides; `runConsoleAction` renders each `CustomerNotice` with `replyForNotice` (templates, claims,
  first check before the save), finds the customer's conversation inside the session's store, splits for the
  channel, and saves: commits' guards, one guard per notice conversation, commits' statements, then the outbox rows,
  in one `guardedBatch`. A failing guard rolls back everything and throws its own error.
- Rows have `job_id` NULL and `operation_key` set; reply index = notice index. Per-conversation send order is by
  `seq` as before; job rows and slow notices behave as before (NULL never matches).
- Dedupe key `console_notice:<store>:<operation key>:<notice>:<part>`, `ON CONFLICT DO NOTHING`.
- Window closed at save time → row written as `waiting_window` (same status the dispatcher and sweep use), one
  `notice_waiting_window` Pendientes item per notice; it goes out when the customer writes, until its 3-hour expiry.
- IDs from the form go only to the engine with the session's member; notice customers are looked up by store.

### Tests run

```text
$ env -C /home/angel-rodas/angel/hackathon-claude-notices npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p test/tsconfig.json      (exit 0, no errors)

$ env -C /home/angel-rodas/angel/hackathon-claude-notices npm test
 Test Files  33 passed (33)
      Tests  391 passed (391)
```

Baseline before the change: 32 files, 379 tests. New in `console-actions.test.ts` (12, local D1, no network): Listo →
one row (conversation, no job, operation key, dedupe key, claims) and it is sent; double tap → one; an engine that
returns the same notice twice → one; stale version → none; commits and notice saved together; failing commit guard →
no engine row, no outbox row, no guard rows left; same through the route (redirect `aviso=guardar`, nothing sent);
closed window → `waiting_window` + Pendientes, not sent until the customer writes, then sent once; another store's
order from a session → `not_found`, no rows in either store; a notice naming another store's customer → no row;
a failed notice row stops its own action's later row only; logs carry no text or phone. Mutation checks: reverting
the group SQL fails the group test; a random dedupe key fails the two dedupe tests.

### Not done, risks, open questions

- **Pretend engine:** `MemoryEngine` still saves in memory before the batch and returns no commits, so with it a
  refused batch leaves the memory change and a retry with the same key answers `duplicate`. The real engine's
  commits (with its `operations` row) are what make this all-or-nothing; the batch path is tested with `CommitEngine`.
- `post` guards are refused (`PermanentWriteError`), as in `completeJob`.
- A customer with several conversations (several store numbers) gets the notice in the one they wrote in last.
- The window is judged at save time with our clock; a notice saved pending whose window closes before dispatch is
  marked waiting by the existing dispatch path, but without a Pendientes item.
- Pendientes still only logs (gap c).
- `test/secrets.test.ts` lists migrations by name, and 0009–0013 belong to other lanes: expect a merge conflict there.
- Not tried on a real phone or the deployed app.
- **Contract questions:** (1) should `CustomerNotice` carry the conversation (or channel) so the engine, not this
  side, picks where a notice goes? (2) Is "group = operation key within a conversation" the agreed meaning of
  "group by the operation key"? (3) Should a waiting-window notice be a Pendientes item from the engine side (gap c)?

### Next steps

- On the deployed app, a Listo tap reaches the customer's phone once (#18's success criterion).
- When #13 lands, rerun `console-actions.test.ts` against the real engine (swap `MemoryEngine` for it).
