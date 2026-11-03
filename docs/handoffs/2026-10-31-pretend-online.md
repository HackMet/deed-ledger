## Handoff: the pretend engine online (PRETEND_ENGINE)

- **Agent and branch:** Claude Code, `claude/pretend-online` (worktree `hackathon-claude-pretend`). Nothing committed.
- **Objective:** tonight's demo runs the whole customer order trip on the deployed app before the real engine (PR
  #62) is ready. The in-memory pretend engine can't do that deployed: the queue consumer and the console can run in
  different isolates, and `DEV_CONSOLE=1` also skips login.

### Files changed

- New: `migrations/0016_pretend_engine_state.sql` (one row per store: `business_id` PK, `version`, `state_json`,
  `updated_at_ms`).
- New: `src/infrastructure/memory/d1-pretend-engine.ts` (`D1PretendEngine`, `PretendStateMovedError`).
- `src/infrastructure/memory/memory-engine.ts`: `exportStore` / `importStore` and the `PretendStoreSnapshot` type
  (Maps as entry lists, insertion order kept). Nothing else changed; its tests are untouched.
- `src/infrastructure/config.ts`: `pretendEngine` from `PRETEND_ENGINE`.
- `wrangler.jsonc`: `PRETEND_ENGINE: ""` under `vars`. `worker-configuration.d.ts` regenerated (`npx wrangler types`).
- `src/composition.ts`: `engine = overrides.engine ?? (devConsole ? devEngine : pretendEngine ? new D1PretendEngine(db,
  { catalog: DEMO_CATALOG }) : null)`. The claim check uses the same engine.
- Tests: new `test/pretend-online.test.ts` (9); `test/order-flow.test.ts` runs the first-order trip on both pretend
  engines (`it.each`); `test/secrets.test.ts` lists migration 0016.
- `docs/architecture.md`: "Pretend engine online" under the engine boundary.

### Design

- **Snapshot, not tables.** Each call loads the store's snapshot, runs the existing `MemoryEngine` on it, and
  compares the JSON before and after. Unchanged (a duplicate, a refusal, a read): no write.
- **Saved in the caller's batch.** A change comes back as a `Commit` in `EngineResult.commits`: an INSERT guarded on
  "no row yet", or an UPDATE guarded on the version read (compare-and-swap). So the snapshot, with its operation
  keys, lands with the job's replies and read marks, or the console action's notices, or not at all. No separate
  write, so nothing to reconcile.
- **Lost race.** The batch fails loudly with `PretendStateMovedError` and saves nothing. Retries are the callers'
  existing paths: the processor defers and retries the job (backoff, then the honest failure reply after the last
  attempt); the console redirects with `aviso=guardar` and the staff member taps again. No in-process retry loop.
- **Scope.** The store is the context's `businessId` (lease or session). Model output and form fields never pick it.
- **Switches.** `DEV_CONSOLE=1`: in memory, no login, local simulator only (unchanged). `PRETEND_ENGINE=1`: D1, login
  required. Both: `DEV_CONSOLE` wins. Neither: engine is null as before.

### Verification

- `env -C /home/angel-rodas/angel/hackathon-claude-pretend npm run typecheck`: exit 0.
- `env -C /home/angel-rodas/angel/hackathon-claude-pretend npm test`: `Test Files  35 passed (35)`,
  `Tests  458 passed (458)`.
- `env -C /home/angel-rodas/angel/hackathon-claude-pretend npx wrangler types --check`: `Types at
  worker-configuration.d.ts are up to date.`
- Covered: two engine instances over one D1 share orders (a customer's order on the other's list; its `mark_ready`
  gives `order_ready`, rendered "Tu pedido ya está listo…"); a lost race rejects with `PretendStateMovedError` and the
  retry keeps both updates; two first writes for a new store; store isolation (list, claims, a foreign order's tap is
  `not_found`, no row written for the other store); a retried job writes nothing; reads write nothing; the console
  answers 401 without a session with `PRETEND_ENGINE=1`; engine selection for each switch; a console tap through
  the Worker queues the ready notice for an order made by another instance; the full first-order trip through the
  Worker on the D1 engine.
- Not tested: a deployed run with real isolates and remote D1.

### Risks and open questions

- **Personal data.** The snapshot holds customer IDs, names and order text. Customer deletion doesn't purge it.
  Demo data only; drop the table (or its rows) after the demo.
- **Size.** The snapshot keeps every operation's outcome and every order forever; each call reads and writes the
  whole JSON. Fine for a demo's dozens of orders, not for real use.
- **Contention.** One row per store: two jobs of different customers finishing at the same moment conflict, and the
  loser waits for the job retry delay. Rare at demo volume; the window is between `onBurst` and the job's batch.
- **Deploy steps (Angel):** apply migration 0016 to the remote D1, set `PRETEND_ENGINE` to `"1"` for the deploy,
  leave `DEV_CONSOLE` blank. Remove the switch, the table and this engine when PR #62 lands.

### Next step

Angel reviews, commits, applies migration 0016 remotely, deploys with `PRETEND_ENGINE=1`, and runs the trip on a phone.
