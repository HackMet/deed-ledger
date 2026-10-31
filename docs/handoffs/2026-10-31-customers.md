## Handoff: customers, name and replies, the order flow (#14, #15, #16)

- **Agent and branch:** Claude Code, `claude/customers` (worktree `hackathon-claude-customers`). Uncommitted.
- **Objective:** anyone writing to the store's number becomes that store's customer (#14); replies reach customers
  and the name is asked and saved once (#15); an order handler sends readback taps and typed words to the engine
  with no model, and reads each burst exactly once (#16).
- **References:** issues #14, #15, #16; #5 gaps (d) and (g) (proposed answers below, not agreed with kercmari yet);
  `docs/architecture.md` rule 6; PRD v1.2 "A first order", "Registration and delivery"; Tech Spec v3 "Exactly once".

### Files changed

- Migrations: `migrations/0004_customers.sql` (new `customers`; `conversations` rebuilt on `customer_id`),
  `migrations/0005_burst_reads.sql` (new `burst_reads`; `conversations.last_readback_order_id/_version/_at_ms`).
- Application: `src/application/order-handler.ts` (new), `intake.ts`, `ports.ts`, `errors.ts`, `dispatch.ts`.
- Domain: `src/domain/burst.ts`, `customer.ts`, `order-copy.ts` (all new).
- Infrastructure: `src/infrastructure/d1/customer-repository.ts` (new), `intake-repository.ts`, `job-repository.ts`,
  `outbox-repository.ts`, `src/infrastructure/memory/memory-engine.ts` (customer answers).
- Wiring: `src/composition.ts`. Docs: `docs/architecture.md`. Script wording: `scripts/simulate.mjs`.
- Tests: new `test/order-flow.test.ts`, `test/customers-migration.test.ts`, `test/customer-rules.test.ts`,
  `test/helpers/engines.ts`; updated intake, intake-rules, isolation, delivery, jobs, outbox-fairness, sweep and
  secrets tests and the seed/whatsapp helpers; `vitest.config.ts` and `test/env.d.ts` add a test-only empty D1
  (`MIGRATION_TEST_DB`).

### What was done

- **0004.** `customers` per store (`business_id`, composite `UNIQUE (business_id, id)`, `UNIQUE (business_id,
  phone)`, phone nullable, `name` + `name_saved_at_ms`, `name_asked_at_ms`). `conversations` is rebuilt with
  `customer_id` and a composite FK to customers; existing rows keep their IDs, window and lease, and every member who
  had a conversation becomes a customer of that store. **Trap:** the usual copy-into-`_new` then rename fails on D1
  when messages point at conversations (the deferred FK count from `DROP` is only cleared by inserting parent rows
  into a table named `conversations`). 0004 stashes rows, drops, recreates `conversations` and re-inserts. Verified
  in vitest on a DB with rows, and with `wrangler d1 migrations apply --local` over rows (outside the repo, in /tmp).
- **Intake.** The customer, conversation, media and message are one batch; hourly cap kept; the unknown-sender path
  is no longer called. Phones are stored on the customer for replies only; logs carry IDs.
- **Outbox.** `customerPhone` (replaces `memberPhone`) reads the conversation's customer.
- **Name.** `CustomerRepository` builds commits the handler adds to the job's batch: save the name (first answer
  wins, no overwrite), mark it asked (once), remember the readback shown.
- **Order handler.** Readback answers (button ID `confirm|correct|cancel:<order>:v<n>`, ≤256 chars; or the word typed
  alone, any case or accent, against the conversation's last readback) go to `Engine.onCustomerAction` at their own
  job with the shared operation key. Other messages are read together at the burst's newest job, or at the last job
  before an answer; earlier jobs complete with no reply. `burst_reads` rows are written in the same batch as the
  engine's commits, guarded so a message is never used twice. A readback is remembered only if its reply is written.
  Without a reader (perception, #17) a burst gets the placeholder. Wired in `composition.ts` whenever an engine
  exists; `placeholderHandler` otherwise (production today, until #13).
- **Pretend engine.** `MemoryEngine.onCustomerAction` handles confirm/cancel/correct: operation keys, versions, and
  only the customer's own orders.

### Tests run

```text
env -C /home/angel-rodas/angel/hackathon-claude-customers npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p test/tsconfig.json      (no errors)

env -C /home/angel-rodas/angel/hackathon-claude-customers npm test
 Test Files  22 passed (22)
      Tests  176 passed (176)
```

Baseline before the change: 19 files, 158 tests. Unknown-sender webhook tests (notice once, slot, daily cap,
deactivated member, slow inline confirm) were removed or rewritten as customer tests, since that path is retired.

### Decisions made on my own (reversible)

1. A member writing to the store number is just a customer; deactivating a membership doesn't affect WhatsApp.
2. The unknown-sender tables, repository method, notice dispatch and maintenance stay as dead code until the team
   agrees to delete them; `IntakeOutcome.notices` is always empty.
3. The name's first answer wins; a later "me llamo …" doesn't overwrite it (the console can correct names later).
4. A duplicate answer (second tap, or the typed word after the tap) gets no reply.
5. A burst reads every unread message from the last hour, failing loudly (`BurstTooLargeError`, nothing read) above
   300, the hourly intake cap; it never reads part of a burst. Failed jobs are never re-read (they got their reply).
6. `order-copy.ts` is a stopgap renderer for the no-model path (Spanish templates; no claim check). The replies
   component should replace it.
7. Removed from `ports.ts`: `MemberMessageInput`, `MemberMessageOutcome`, `recordMemberMessage`, `memberPhone`
   (their SQL used the dropped `conversations.user_id`). Everything else in shared files is additive, except
   `composition.ts`'s `engine`/`jobHandler` lines, which the issue asks to change.

### Review fixes (coordinator, Oct 30)

1. A burst over 50 messages no longer strands lines: `unreadBurst` returns the whole burst or throws
   `BurstTooLargeError` above 300. Tests: 60-message burst read once; 301 unread throws and reads nothing.
2. A typed word answers the last readback only if it arrived after that readback was queued
   (`last_readback_at_ms`, 0005). Otherwise nothing is decided and the customer gets "Tu pedido cambió. Revisá cómo
   quedó arriba y respondé Confirmar, Corregir o Cancelar." (the new readback goes out first). Test included.
3. The name is marked asked only when the reply carrying the question is written (same check as a withheld
   burst-closing reply). Test: question withheld for a late message, then asked once.
4. Typed words use a `Map`, so "constructor", "toString" and the like are not answers. Test included.

### Contract questions (#5)

- **(d)** `CustomerContext` needs `customerName: string | null` and `customerNameAsked: boolean`. Local type
  `CustomerContextWithName` in `order-handler.ts` passes them today; the engine can't rely on them until the contract
  has them.
- **(g)** Proposed as written in the task: button IDs are operation keys; typed words answer the last readback queued
  and share its key. Who renders the buttons (the outbox sends text only today) is open.
- What does the engine return for `correct_order`? The pretend engine returns `nothing`, and the handler says
  "Va. Decime qué le cambiamos al pedido."
- `onBurst` gets `matches: []` here; catalog matching belongs to perception (#17).
- Should the engine's `notices` from a customer's own message ever be non-empty? They're logged and dropped.

### Not done, risks

- No perception: readings only happen in tests with a fake reader. The deployed app answers a button tap only once
  an engine is wired in (#13) and readbacks with buttons are sent (not built).
- "Last shown" readback means queued, not delivered.
- The real engine must check `customerId` ownership and versions itself; the handler passes untrusted order IDs.
- 0004 hasn't run against the remote D1. Angel runs remote migrations; take a backup (`wrangler d1 export`) first.
- Unread messages older than the one-hour lookback (an earlier job done, the burst's last job failed) aren't read
  again; the failed job's reply asked the customer to resend.

### Next steps

- Agree (d) and (g) with kercmari and move the two context fields into the contract.
- #13: plug the real engine into `composition.ts` (`engine` → `createOrderHandler`).
- #17: implement `BurstReader` (perception) and pass it to `createOrderHandler`.
- Delete the unknown-sender code once the team agrees.
