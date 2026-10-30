## Handoff: engine commits, contract v1 draft, preparation list

- Agent and branch: Claude Code, `claude/job-outcome-commits` in the worktree `../hackathon-claude-local`, from
  `claude/base-layer`. Nothing is committed, pushed or deployed; `.dev.vars` was never read. Angel commits. Meant
  as three commits: the commits change, the contract, the console.
- Objective: unblock the engine (its writes must save with the job), give both sides a contract to build against
  before the spec meeting, and start the console's preparation list ahead of Saturday's gate.
- References: Tech Spec v3 ("Exactly once", "Perception", "Console", "Plan to November 4"), PRD v1.2 flows "A first
  order", "A change while my order is being prepared", "Out of stock while packing"; two independent reviews of the
  spec (Codex and Muse Code, Oct 30) whose fixes the contract takes in.
- Files changed:
  - Commits: `src/application/ports.ts` (`BatchGuard`, `Commit`, `JobOutcome.commits`), `src/application/processor.ts`,
    `src/infrastructure/d1/fence.ts`, `src/infrastructure/d1/job-repository.ts`, new `test/commits.test.ts`.
  - Contract: new `src/domain/contract/` (numbers, observation, actions, outcomes), `src/application/engine.ts`,
    `test/fixtures/contract.ts`, `test/contract.test.ts`, `docs/contract.md`.
  - Console: new `src/infrastructure/memory/` (pretend engine, demo orders), `src/interfaces/http/console.ts`,
    `src/interfaces/http/env.ts`; edited `src/interfaces/http/app.ts`, `src/composition.ts`,
    `src/infrastructure/config.ts`, `wrangler.jsonc` and `worker-configuration.d.ts` (`DEV_CONSOLE`),
    `scripts/dev-sim.mjs`, `scripts/lib/sim.mjs`, `test/helpers/harness.ts`; new `test/console.test.ts`.
  - Docs: `docs/status.md`, `docs/architecture.md`, `AGENTS.md`, `README.md`, this handoff.
- What was done:
  - `completeJob` takes the job's commits and runs their guards after the lease and job guards, their statements
    after the job's completion and before its replies, in one batch. The processor retries a job whose commit guard
    fails and fails, with its failure reply, a job whose commit breaks a constraint. Before, any error from
    `completeJob` other than a stale write escaped the processor.
  - The contract: 15 observation kinds (13 from Tech Spec v3 plus `clarification` and `customer_name`), evidence by
    burst position, line labels for edits, several observations per burst, customer versus console kinds, actions
    with operation keys and actors, engine outcomes, the order view, customer notices, claims, and the `Engine`
    interface with `preparationList`.
  - The preparation list at `/console/preparacion`, dev mode only, on a pretend engine.
- Tests run (Oct 30, on the final tree):
  - `npm run typecheck` → exit 0.
  - `npm test` → "Test Files 18 passed (18)", "Tests 143 passed (143)".
  - Undo checks on the commits change: dropping the commit statements from the batch fails 4 of its tests; putting
    the commit guards before the job guard fails the `JobConflictError` test (added after that check first passed).
  - By hand on `npm run dev:sim`: the page renders (200); "Empezar" on an order answers 303 and the order shows
    "Preparando"; a screenshot at 360 px matched the layout.
- Not done: console login, sessions, roles and CSRF; "Ofrecer otro" (needs the barcode scanner); replies and the
  claim check; perception; the two-minute fallback; a deploy.
- Risks and open questions: the contract hasn't been read by the teammate, whose own spec isn't on this machine; the
  open questions are in [contract.md](../contract.md#open-for-the-meeting). `Commit` names `D1PreparedStatement` in
  the application layer, a small break in the layering the spec's design asks for.
- Next step: the spec meeting, then console login and a first deploy for the Saturday gate.
