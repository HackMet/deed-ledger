# Deed: the pattern, its conformance criteria and what was measured

The full technical record behind the [README](../README.md). The test and attack counts here are from November 4, 2026; the README has the latest.

## What Deed is

**Deed is an architectural pattern: a double-entry ledger for an agent's effects.** The agent's claim is one leg of
the entry; the world writes the other. A fact exists only when the two balance, and facts govern what the agent is
allowed to do next.

Deed is the product that implements three levels. They are not the same thing:

| Level | What it is | Analogue |
|---|---|---|
| **Pattern** | The design rule: who may write what, and when something counts as a fact | Saga, Outbox, Event Sourcing |
| **Protocol** | The shape of the entry: who · what · witness · verdict · dependencies | A bank statement; TCP's segment |
| **Measurement** | The arithmetic on top: balance, liveness, and reliability under dependence | Statistical process control; an audit |

The pattern's name is **Double-Entry Effect Ledger**; "Agentic ledger" is the short name.

### What it is NOT

- **Not an audit log.** A log records what the actor says it did, written by the actor. Deed records what an
  independent party can corroborate.
- **Not LLM-as-judge.** No model issues a verdict, ever.
- **Not output verification.** The question is not "is the answer good" but "did the effect happen in the world".
- **Not a hallucination detector.** A claim with no trace in any system is marked unverifiable, not refuted.
- **Not a signed-receipt library.** Those exist (about twenty projects, and three IETF SCITT drafts as of October
  2026). A receipt records one party's observation. Deed is the bookkeeping on top of receipts.

### The eleven conformance criteria

Each one is testable. Fail one of the four load-bearing ones (★) and it isn't Deed; it's an audit log with good
branding. The other seven can be partial and it is still recognisably Deed.

| # | Criterion | Status |
|---|---|---|
| **C1** ★ | **A claim is not a fact.** The actor writes only the claim leg and a pointer to where its counter-leg must appear. Separation of write permissions, enforced structurally. | ✅ built and tested |
| **C2** ★ | **Every fact carries evidence from a source the actor does not control.** No evidence, no fact. | ✅ built and tested. The order's Libro view (`/console/deed/:pedido/libro`) pairs each claim with its witness. The demo has no WhatsApp statuses, so delivery reads *en duda* there |
| **C3** ★ | **The verdict is issued by fixed arithmetic, never by a model.** Re-runnable by a third party from the entry alone. | ✅ built and tested, with the limits below. No model issues a verdict. `node scripts/deed-recheck.mjs <entry.json>` re-runs an order's verdicts from its exported entry alone (`docs/deed-entry-example.json` is a synthetic one), and `python3 scripts/deed_check_harness.py --evidence docs/deed-run-evidence.jsonl --compare docs/deed-verdicts.csv --out v.csv` re-runs the harness verdicts, counting any commit a clone lacks apart. Two limits: re-runnable means with this repo's source and `npm ci` (for esbuild), which needs the network once; and the check shows the verdicts follow from the entry's input, not that the input is the book. An entry edited consistently on both sides still exits 0, because entries are not signed. The commit guards run in D1, not over an entry |
| **C4** | **Admission is atomic with the effect.** The fact, the reply and the job's completion live or die in one transaction. "Saved" cannot exist without the fact. | ✅ built and tested |
| **C5** | **Append-only, with validity.** Never updated, never deleted. A correction is a new fact; a cancellation closes an interval. | ⚠️ in the store, ✅ in the core. Append-only: the code has no UPDATE or DELETE path on `facts`, `fact_evidence`, `fact_dependencies` or `fact_closures`, and unique keys prevent duplicates. The core's schema (`src/deed-core/schema.sql`) enforces this with triggers; in the store, the triggers are still to do. |
| **C6** ★ | **Dependencies gate at commit time, not with an `if`.** Liveness is derived from closures, never cascaded by writes. | ✅ built and tested |
| **C7** | **Uncertainty is a first-class outcome.** Silence is not failure; a fetch error is never a contradiction. | ⚠️ **partial, and say so:** the view surfaces *en duda*; the engine does not model an in-doubt state in the order flow. Showing it is not the same as having it. |
| **C8** | **Reliability is measured per (agent id, effect class), under dependence.** Agent errors arrive in bursts, so a Bernoulli interval is mis-specified. | ⚠️ partial: `docs/deed-scale.html`, from harness runs only, not store orders. There the id is sha256(model + brief), not `facts.agent_id`. The page gives counts only; it makes no claim about dependence |
| **C9** | **Nothing identifies, scores, profiles or tracks a person.** The unit is an agent version and an effect class. | ✅ built and tested |
| **C10** | **The core is agnostic.** No business nouns inside it; a new business flow is a new policy, never an edit to the core. | ✅ built and tested, with the known limits below |
| **C11** | **The agent is identified, and the identity travels.** Every fact records which agent version made the claim; every customer-facing output carries a code that resolves to that entry. | ⚠️ partial: every customer fact records the agent version. Every message the agent sends about an order carries an order claim, including the change approved and declined notices, so it resolves to its entry through the ID WhatsApp gave it. The customer sees no code. A member of the store finds that ID in each reply's detail on the order's Libro and posts it to the search at `/console/deed/buscar`; the exported entry leaves it out, because it embeds the phone number. These don't resolve: the owner's own words from Pendientes, which carry no claim and can be about an order, which is why this stays partial; a safe reply sent in place of a blocked message; a send whose delivery is unknown; and an erased customer's messages |

**Known limits of C3.** These have no test:

- Entries aren't signed, so one edited consistently on both sides still exits 0. The check doesn't judge whether the input is the book.
- An empty entry passes, and the parser accepts negative prices, long decimals and unknown keys. The `DECIMAL` check can be removed with no test failing.
- `rowKey` is positional, an entry doesn't name its judge's version, and an entry carries a staff member's full UUID and claims the judge ignores.
- Without esbuild the command exits 1, as if a verdict differed.
- The demo prints `RESULT: every expectation held` before its recheck, and its tallies can't see a path no demo order reaches, such as a closed fact or a total.
- `entrada.json` has no `Cache-Control: no-store` and no explicit no-login test (the route does answer 401). "20 pairs" counts rows, 9 of them with no pair.

**C10, met.** A host whose effects are only facts writes a policy. A host that needs its own writes in the same batch adds an extension outside the core. In no case is the core edited. (Like an adapter in hexagonal architecture.)

| Industry | Policy (file) | Extension | Core lines changed |
|---|---|---|---|
| Store | `src/domain/store-policy.ts` | `src/infrastructure/d1/store-extension.ts` | 0 |
| Clinical lab | `test/helpers/deed-core-policies.ts` | none | 0 |
| Freight | `test/helpers/deed-core-policies.ts` | none | 0 |
| Insurance | `test/deed-core-fourth-industry.test.ts` | none | 0 |
| Building inspections | `test/deed-core-inspections-industry.test.ts` | none | 0 |

What it rests on: `test/deed-core-boundary.test.ts` fails on a listed business noun or an outside import inside the core, and the last two industries were written by the reviewing agent, which took no part in building the core.

An independent review gave C10 PASS: the three judges agreed on the shared table and on 33,753 exhaustive and 21,000 fuzzed steps, on local workerd, not on real Cloudflare D1.

**Known limits of C10.** None of these wrote a fact on D1, but a third party's re-check built on the memory store can answer differently:

| Case | Pure judge and memory store | D1 |
|---|---|---|
| A value the schema refuses: `validFromMs` of `1.5`, `NaN` or `Infinity`, a `body` that can't be serialized, a null `actor` or `refId` | admitted | throws a raw `D1_ERROR`, no fact written |
| A policy with a bad bound (`min: 1.5`, `-1`) in a reachable rule, or a NUL in a kind | admitted | every entry the judge would admit throws, even of other kinds |
| A very large policy: 100 two-rule kinds work, 300 do not | admitted | every entry the judge would admit throws `SQLITE_TOOBIG` |
| A cancel racing a `sameBatch` entry | not applicable | throws a raw error, not `dependency_not_live`; no fact written |
| Two concurrent identical entries that close a fact | not applicable | the loser gets `closes_not_live`, not `duplicate`; a refusal either way |

Also, `MemoryLedgerStore` keeps the caller's `dependsOn` array by reference, so changing that array later changes its ledger.

**What a policy can't say.** All three judges agree on these. Any kind can close any kind, and a policy can't require a dependency or a closure; a host that needs that adds an extension guard, which exists only on D1. A requirement with no bound is always true, so it admits with no such evidence. An empty `refId` counts as evidence.

Known limit of the boundary test: it finds only the words on its list. A hard-coded host word outside the list, such as `"confirmation"`, is not detected. It also misses compounds such as `unitprice`, and an import hidden after a regex with an escaped slash. None of these is in the code today, by reading the files.

An honest note: the core was extracted from the store, so it was born with the store in mind. The stronger proof is the industries written by someone who did not build it, and those are policies in tests, not running businesses.

C7, from the status table: showing "en duda" (in doubt) on a screen is not the same as modelling it in the engine.

**C11, built:** `facts.agent_id` is 8 hex characters of SHA-256 over the model, the prompt versions and the schema
names. The runtime stamps it, and the model never supplies it. Customer facts carry it, staff and owner facts are
NULL, and the order trail shows the agent beside each customer fact. Planner calls are not in the hash yet.

**C11's honest limit:** an identity the agent writes about itself is self-declared. What makes it trustworthy is that
it sits in the same batch as a fact an independent witness corroborated. The identity is worth exactly as much as its
entry, no more.

### Next for Deed

The store's append-only triggers (C5), signatures, watermarks, C2PA, hash chain.

## Deed: what was measured

| Number | Value | Measured |
|---|---|---|
| Tests | 1801 passed in 109 files, plus 9 under `node:test`; typecheck exit 0 | `npm test` and `npm run typecheck` on this branch, November 4, 2026 |
| Attacks | 9 attacks that reach the engine: 0 false facts admitted. One more attack is intake only and is not counted | `node scripts/adversary.mjs`, exit 0. Removing a defence on purpose turns its row red, except one K12 case noted in the script's review |
| Harness runs | 125 run names, last attempt of each (at least 61 earlier attempts were overwritten with no verdict): 63 confirmed, 0 contradictions, 62 with no claim | `deed_check_harness.py` on 2026-11-04, Honduras time, rows in `docs/deed-verdicts.csv`, page in `docs/deed-scale.html`. Confirmed only means the commit exists and the runner recorded it for that run; tests are not re-run. Only the first sha on the `RESULT: COMMITTED` line is read, so any other false statement, with a sha or without one, is not detected. A reader re-runs them from the published evidence, and about a quarter of those shas exist only in local copies |

`./demo.sh` runs six synthetic customers (A to F) through the real engine, ledger and console on a local Worker, on recorded perception. Answers to customer messages are demo templates; notices after a staff tap are the product's. It ends by re-checking three exported entries over HTTP. Its `0 differ` holds for the demo's entries only. The export and the check run the same judge in the same tree, so the demo pins its tally of verdicts per order but cannot see every broken path; `npm test` covers those.

Screens: `/console/deed/en-vivo` (the newest order's graph and the store's checks, refreshing), `/console/deed/<order>` (the order's facts as a graph), `/console/deed/<order>/libro` (AGENTE, LIBRO and MUNDO paired), `/console/deed/verificaciones` (every refusal and claim check), `docs/deed-scale.html` (harness runs, static).

**`DEED_ENGINE`:** `wrangler.jsonc` sets it to `"1"`, so a deployed Worker runs on this engine. It wins over `PRETEND_ENGINE`. With `CONVERSATION=planner`, as deployed, the planner's conversation runs on this engine (`PlannedDeedEngine`, D-59).
