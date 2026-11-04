# Handoff: PR #71, the Deed engine

For Angel's agents. PR: https://github.com/HackMet/deed-ledger/pull/71, branch `claude/integration`. Everything goes through this one PR. It replaces #70; don't merge #70.

**Merging deploys.** `.github/workflows/deploy.yml` applies remote D1 migrations and deploys on every push to `main`.

## What changes when it is deployed

This engine has never run deployed. Everything in the README's "Tested from a phone" was on the previous engine.

- `DEED_ENGINE` is `"1"` in `wrangler.jsonc` and wins over `PRETEND_ENGINE`. The app moves from the pretend engine to the real `OrderEngine` on D1.
- Migrations `0023` to `0028` apply remotely. There is no `0029` (D-54).
- Orders in flight don't carry over: the pretend engine keeps its state in `pretend_engine_state`, and `OrderEngine` reads `products` and its own tables. Whether the demo store's catalog exists remotely is unchecked.
- New console screens: `/console/deed/<order>`, `/console/deed/<order>/libro`, `/console/deed/<order>/entrada.json`, `/console/deed/verificaciones`.

## What was built

- **Engine:** facts, evidence, dependencies and closures commit inside the batch. Change requests with approval (K12), dispatch (K13), prices and business info (K6, K15), invoices (K14).
- **Core:** `src/deed-core/` is an agnostic black box. The store is one host: `src/domain/store-policy.ts` and `src/infrastructure/d1/store-extension.ts`. Don't put business words in the core; a new flow is a new policy (D-53).
- **Agent identity:** `facts.agent_id` on customer facts (C11).
- **Evidence tools:** `node scripts/deed-recheck.mjs <entry.json>`, `node scripts/adversary.mjs`, `docs/deed-scale.html`.

## Files in Angel's area that changed

| File | Change | His call |
|---|---|---|
| `wrangler.jsonc`, `worker-configuration.d.ts` | `DEED_ENGINE: "1"` and regenerated types | Accept the switch |
| `src/infrastructure/config.ts` | `deedEngine` flag | Review |
| `src/composition.ts` | Wires `OrderEngine`, the Deed checks, catalog, business and receipts | Review. It imports `test/fixtures/receipts` from production code for `RecordedReceiptReader` |
| `src/application/perception/agent.ts` | Exposes `readerConfiguration` for the agent id | Review |
| `src/integrations/perception/recorded-receipt-reader.ts` | New: invoices are read from recordings, not by Muse | Review |
| `src/domain/replies.ts`, `src/domain/copy.ts` | Copy for K12 and K13, including `CHANGE_AFTER_READY` | Check the Spanish |
| `src/domain/contract/actions.ts`, `outcomes.ts` | `review_change`, `dispatch`, `change_approved`, `change_declined`, `order_dispatched`, `payment_rejected`, `en_camino`, `openChangeRequest`, `lastReview` | **Accept or replace** |
| `src/interfaces/http/console/*` | Deed, Libro, Pedidos, Facturas, Negocio and Productos screens | Which stays: Tienda or Precios |
| `package.json` | `npm test` also runs two `node:test` files | Note it |
| `scripts/lib/sim.mjs` | Sets `DEED_ENGINE` to `"0"` for the simulator | Review |

Also waiting on him: decisions D-41 to D-44 and the migration numbers.

## Changes to how you work

- **Local:** a `PRETEND_ENGINE=1` in `.dev.vars` no longer wins. Add `DEED_ENGINE=0` to keep the pretend engine. The simulator and vitest already set `"0"`.
- **`npm test`** is now `vitest run && node --test test/node/deed-recheck-command.test.mjs test/node/demo-verdicts.test.mjs`. The node tests start processes, which the Workers runtime can't do.
- **`./demo.sh`:** read the exit code. With a broken judge it prints `Steps: 29 · passed 29`, then fails on the verdict check and exits 1. `0 differ` holds for the demo's entries only.
- **Demo perception is recorded:** `6 fixture, 0 muse`. Only a real run proves the Meta models carry the flow.
- **Demo replies aren't the product's.** Answers to customer messages in `./demo.sh` are templates in `demo/recorded-perception.ts`, so their wording differs and they skip the claim checks. Notices after a staff tap are the product's. Say so when filming.

## Known gaps

1. **The planner doesn't run on this engine.** `OrderEngine` has no `plannerContext`, so `CONVERSATION=planner` falls back to the classic reader with no error, and alias proposals stop. On Nov 3, on the previous engine, the eval completed 27 to 28 of 32 conversations on the planner and 12 to 16 on classic. Kerly hasn't decided on this; don't build it without asking.
2. **Nothing has run deployed:** remote D1, Queues, R2, real WhatsApp and real Muse are all untested on this engine. `wrangler deploy --dry-run` wasn't run, so bundle size is unmeasured.
3. **Copy mismatch.** While a change waits for the store, the demo says "Le pasé tu cambio a la tienda. Queda así si lo aprueban: …". Real WhatsApp says "Tu pedido ya está en la fila. Te aviso apenas esté listo." or "Vas segundo en la fila. Te aviso apenas esté listo." The proposed `statusReply` change is in the PR body, uncommitted, and no test covers it. That demo message stays out of the video until they match.
4. **C5:** append-only is enforced with triggers in the core's schema, not in the store. Store triggers would go on a separate branch, if Angel accepts them.
5. **Codex review:** not done; codex isn't installed on Kerly's machine.
6. **An unmatched line shows one quantity only when its words start with that quantity in a form the rule reads.** A line's words are the customer's free text, so this is a stated limit, not a solved problem.
   - **Read:** digits, decimals, fractions, `2 1/2`, `x2`, `media`, `dos y medio`, and Spanish whole numbers up to cien.
   - **Stays beside the new quantity after a change:** a leading number that says another value (`1 lb azucar` × 2 → 3), a line whose old quantity was unknown, and a number elsewhere in the words or in another form, such as `azucar 2 lb` × 2 → 3, which reads `• 3 azucar 2 lb`, or `libra y media`, `2 y media libras`, `unas 2 libras`, `½ libra`, `un cuarto`, `una docena`. A trailing number isn't removed on purpose: `coca 2 litros` × 2 would lose its size.
   - **Read as the quantity when it agrees:** `Dos Pinos` × 2 reads `Pinos`, `2x4 tabla` × 2 reads `x4 tabla`, `1,000 gramos` × 1 reads `gramos`, and `2 litros de coca` × 3 → 2 shows as a remove plus an add. The number is then gone for later versions. The words can't tell a brand or a size from a quantity.
   - Catalog names are never touched. No wrong quantity reaches the ledger: the line's own `quantity` is always the record.
7. **`saidName` in `src/domain/replies.ts:1132`, Angel's, has its own shorter rule.** The real readback shows `• 12 Doce panes`, `• 2 2lb frijol` and `• 0.5 libras de 1/2 libra de ajo` on a line nobody changed, and `una docena de huevos` × 12 lists as `Docena de huevos`. It could call `wordsWithoutQuantity` first; he decides. `src/interfaces/http/console/preparacion.ts:264`, also his, prints the raw words.
8. **Local paths in branch history.** `docs/deed-run-evidence.jsonl` no longer holds any, but earlier commits on this branch do (`/home/kerly/...`). Don't squash on merge without checking: a squash removes `c15155b`, and two published `NO_CLAIM` rows then read as contradictions, so `--compare` reports 2 differ. Accept the paths, since the same username is in commit metadata, or re-run and republish the evidence after squashing.

9. **No total on this engine.** `order-engine.ts:352` sets every line's `unitPrice` to null, so every order's total is null and the real reply says "El total te lo confirmo". No wrong total is possible, and none is shown. Prices need a decision.

10. **C11 is still partial.** Staff can search an order's code or reference at `/console/deed/buscar`, but on this engine no customer message carries one. Local branch `claude/c11-ref` adds a last line `Ref. a1b2c3d4` to customer messages about an order, in `src/application/replies.ts`. It stays out of this PR until Angel accepts it.

## Conformance

- ✅ C1, C2, C3, C4, C6, C9, C10. The known limits of C3 and C10 are in the README.
- ⚠️ C5, C7, C8, C11, each stated in the README.

## Under review

**`claude/demo-fixes` and `7e8c379`:** one Opus review. Their code is already in this PR. Any fix lands here as a new commit, so re-read the PR before merging.

## Angel's steps, in order

1. Read the PR's "Before merging" section and accept or replace the contract additions.
2. Check the demo store's catalog on the remote database.
3. Run `npx wrangler deploy --dry-run` to measure the bundle.
4. Merge #71. That deploys.
5. **Run one real order end to end with Muse on the deployed Worker: order, readback, confirm, Listo, "listo". This is the hackathon's gate.**
6. Decide on the `statusReply` copy and the C5 triggers.

Code freeze for the video: 17:00 Guayaquil time, which is 16:00 Honduras time. Submission deadline: 8:00 PM Honduras time, November 4.

## Rules

Read `AGENTS.md`. Don't edit `src/deed-core/` for one industry. Don't force-push. Never read `.dev.vars`. The app's key is `MODEL_API_KEY`, never `META_API_KEY`.
