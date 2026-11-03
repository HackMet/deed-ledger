## Handoff: store setup screens (#40)

- Agent and branch: Claude Code, `claude/store-setup` (worktree `../hackathon-claude-setup`, based on 859146b, PR #63's head). Not committed.
- Objective: the pilot store (starting Monday) keeps its own products, prices, "No hay" marks, hours and delivery
  fee on our side, per store, in D1. The D1 pretend engine (`PRETEND_ENGINE=1`) reads them instead of the fake
  `DEMO_CATALOG`.
- References: #40 store settings; PRD FR-12 (configured, not coded); AGENTS non-negotiables 2 (absent is unknown),
  3 (store scope), 4 (integer centavos); contract.md "Fee" (#29) and store hours (#47).

### Temporary stand-in

These tables are a **temporary stand-in for the Monday pilot**. The tech spec's catalog (`products`,
`product_names`, `prices`, `availability_evidence`), its `store_settings` and the spoken setup session live in the
teammate's engine and replace this once they're ready. Our tables are named `store_products` and
`store_setup_settings` so they don't take a name the engine uses.

### Files changed

New:
- `migrations/0019_store_setup.sql`: `store_products` (name, folded `name_key` UNIQUE per store, other names as a
  JSON array, `price_centavos` NULL or > 0, `no_hay` 0/1) and `store_setup_settings` (hours JSON, delivery fee
  NULL or >= 0).
- `src/domain/store-setup.ts`: exact price parsing (`parseLempiras`, `parseFee`), the paste box
  (`parsePasteBox`), other names, and hours form ⇄ `StoreHours` (`hoursFromDays`, `daysOf`).
- `src/infrastructure/d1/store-setup-repository.ts`: `D1StoreSetupRepository`, every query takes the tenant.
- `src/interfaces/http/console/tienda.ts`: the owner-only screens.
- `test/store-setup.test.ts`: 23 tests.

Existing files touched (for the merge with the menu branch):
- `src/interfaces/http/console/layout.ts`: **one line** added to `NAV`:
  `{ path: "/console/tienda", label: "Tienda", ownerOnly: true }`. Nothing else in the layout.
- `src/interfaces/http/console/index.ts`: two lines (import `tiendaScreen`; `tiendaScreen(app);` after
  `anotarScreen(app);`).
- `src/composition.ts`: `Runtime.storeSetup` added; `PRETEND_ENGINE` builds `new D1PretendEngine(db, { setup: storeSetup })`
  instead of `{ catalog: DEMO_CATALOG }`. Dev console unchanged (still `DEMO_CATALOG`).
- `src/infrastructure/memory/d1-pretend-engine.ts`: new `setup` option (per-store read on every call, including
  `catalog(tenant)` and `verifyClaims`); `deliveryFee` option; `catalog()` now uses its tenant argument.
- `src/infrastructure/memory/memory-engine.ts`: `deliveryFee` option put on every delivery fulfillment (one place,
  `setFulfillment`); an ordered product marked `se_acabo` keeps `se_acabo` on its line (`lineView`,
  `settleQuestion`).
- `test/secrets.test.ts`: `0019_store_setup.sql` added to the migration list (every migration branch conflicts here).
- `test/pretend-online.test.ts`: `engine.catalog()` → `engine.catalog(store)`.
- `docs/architecture.md`: the Fee line, the PRETEND_ENGINE paragraph, and a new "Store setup (#40)" bullet before
  "Screens". `docs/contract.md`: the Fee rule's "until #40" sentence.

### What was done

- **Tienda tab** (owner only; staff see no tab and get 403 on every route). Two sub-tabs: Productos, Horario y envío.
- **Productos:** add (name, optional price, optional other names), Editar, one-tap "No hay" / "Sí hay", Quitar
  with a confirm page. Blank price is "Sin precio" (NULL), never 0.
- **Pegar una lista:** "Revisar" shows what will be saved (new / already there with the same price / price change
  from L X) and each line it couldn't read with the reason; "Guardar" re-reads the same text and saves only the
  readable lines in one batch. A name the store already has gets the new price and keeps its other names and mark.
  Accepted: `Arroz 1 lb - 18`, `Aceite 1 L, 58`, `- L 16.50`, `: L.45`, `= 25 lempiras`, `Pan de molde L 40`.
  Refused, never guessed: no separator and no L (`Huevos 30`), `Aceite 1 L 58` (litre or lempiras?), commas
  (`18,50`, `1,200`), zero, no price, repeats. Up to 300 lines.
- **Horario:** a box and open/close times per day; days with the same hours are grouped into `StoreHours`. A bad day
  is shown back and nothing is saved. All days closed saves "no hours" (bot says "te confirmo").
- **Envío:** blank = not set (NULL), 0 = free, otherwise centavos.
- **Engine:** "No hay" → `availability: "se_acabo"` ("se nos acabó" to ¿hay?; "no nos queda" in the readback, out of
  the total). Unmarked → unknown ("te lo anoto y te confirmo"), never "hay". Other names → aliases. The fee shows as
  "Envío: L 25, aparte del total." and "Total: L 36, más el envío" (copy that already existed).

### Tests run

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p test/tsconfig.json
(no errors)

$ npm test
 Test Files  38 passed (38)
      Tests  525 passed (525)
```
Baseline before changes: 37 files, 502 tests passed; typecheck clean.

New tests cover: price parsing (decimals, L markers, commas, zero, too big; fee 0 vs blank), paste box good and bad
lines, the 300-line cap, hours grouping and bad days, store isolation in the repository (B can't read, edit, mark or
remove A's product; same name allowed in two stores), DB CHECKs (zero price, negative fee), every screen action,
refusals (bad price, taken name), paste preview saves nothing until Guardar, staff 403 on every GET and POST, another
store's owner can't touch a product by ID, the engine reading products/hours/claims per store and seeing changes on
the next call, and through the Worker with `PRETEND_ENGINE=1`: "¿Hay leche?" → "Leche: se nos acabó." and an order
with a "No hay" product plus the fee.

### Not done, risks, open questions

- **"Sí hay" means "not marked out", not "we have it".** Clearing the mark returns the product to unknown, so the bot
  still says "te lo anoto y te confirmo" to "¿hay arroz?". Conservative (absent is unknown); Angel may want a
  third state ("Hay") the owner sets on purpose. Small change if wanted.
- **Behavior change in the dev console:** `DEMO_CATALOG`'s Leche is `se_acabo`, so ordering it now reads back
  "no nos queda" instead of being priced. No existing test depended on it.
- The readback's "no nos queda" line carries no availability claim (a staff "No hay" tap also sets `se_acabo` on a
  line while the catalog may still say unknown, so such a claim would fail). The order total claim still covers it.
- The fee line ("Envío: L X") is not a checked claim; the fee is copied onto the order when delivery is chosen, so a
  later fee change doesn't touch open orders.
- Anotar's reader (`console-reader.ts`) still gets no catalog; it could read `storeSetup` too. Follow-up.
- Model picks only see the first 200 products (`MAX_CATALOG_LABELS`); code matching uses all of them.
- Pasted text is capped at 15,000 characters by the console's 16 KiB form limit (roughly 400 short lines).
- Not viewed in a browser at 360 px; only the rendered HTML was checked by tests.
- Migration 0019 conflicts in `test/secrets.test.ts` with any other branch that adds a migration.
- No pilot data seeded. Johan's products go in through the paste box after the deploy.

### Next steps

1. Review and commit; merge after the menu branch (conflicts expected only in `layout.ts` NAV and `index.ts`).
2. Apply migration 0019 remotely with the deploy, then load Johan's price list through Tienda → Pegar una lista.
3. Decide the "Sí hay" question above.
