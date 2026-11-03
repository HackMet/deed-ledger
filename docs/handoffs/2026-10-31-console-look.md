## Handoff: console look (wireframes C1, C2, C5, C7)

- Agent and branch: Claude Code, `claude/console-menu` in the worktree `../hackathon-claude-menu`, on top of Angel's
  uncommitted menu work (tab bar, Más, Pendientes, migration 0018). Nothing is committed, pushed or deployed.
- Objective: make the console look and work like the wireframes: a top bar with who is logged in, Pedidos as a
  compact list plus a page per order, the owner's Pendientes count on its tab, one shared look.

### Files changed

- `src/application/ports.ts`: `ConsoleMember.displayName`; `PendientesBoard.countOpen`.
- `src/infrastructure/d1/console-auth-repository.ts`: `findSession` and `devOwner` read the name with the existing
  `MEMBER_NAME` rule.
- `src/infrastructure/d1/pendientes-repository.ts`: `countOpen` (one `COUNT(*)`).
- `src/composition.ts`, `test/helpers/harness.ts`: optional `pendientesBoard` override, so tests can count reads.
- `src/interfaces/http/console/auth.ts`: the dev fallback member is named "Rosa".
- `src/interfaces/http/console/layout.ts`: the top bar (optional "←", title, subtitle, "Nombre · Dueño/Empleado"),
  the badge on Pendientes, and one `BASE_STYLE` (color tokens, cards, chips, section titles, 48 px buttons).
- `src/interfaces/http/console/preparacion.ts`: the list (C1) and the new order page `/console/preparacion/:orderId`
  (C2). All the old actions and checks stay; only where a tap lands changed.
- `src/interfaces/http/console/pendientes.ts`, `mas.ts`, `anotar.ts`, `empleados.ts`: subtitles and the shared look
  (Empleados also gets "←" back to Más).
- Tests: `test/console-preparacion.test.ts` (list and order page rewritten, new tests), `test/console-menu.test.ts`
  (top bar, badge), `test/console-actions.test.ts`, `test/console-auth.test.ts`, `test/console-empleados.test.ts`
  (where markup or redirects moved).
- Docs: `docs/architecture.md` (console), `docs/status.md` (one bullet), this file.

### What was done

- **Top bar on every console screen:** title, a short subtitle, and on the right the logged-in person:
  "Johan · Dueño", "Rosa · Empleado", or only the role when there's no name. A long name is cut short and the
  role always shows. The "Actualizar" link is gone. The list and the order page refresh every 15 s, and other pages
  reload in the browser.
- **C1 list:** one card per order: the name, one chip, and a muted line like
  "4 productos · Recoge en tienda · confirmado 7:46 a. m." or "2 productos · Entrega: frente a la iglesia ·
  cambió 8:05 a. m.". Chips, first match wins: Listo, Cambió, minutes waited ("35 min", "1 h 35 min") once an
  order passes `LATE_AFTER_MINUTES`, then Nuevo or Preparando. Orders to pack come first and ready ones go last,
  oldest first in each group. Subtitle: "Hoy · N por preparar". The list has no buttons. Tapping a card opens the
  order.
- **C2 order page:** "←", the name, "Versión N · Recoge en tienda". When the customer changed it, a yellow note:
  "Marta Reyes cambió el pedido a las 8:05 a. m. Revisá la línea marcada.", and the changed line is highlighted with
  a "Cambió" chip. Each line: a check box for the packer (the existing `listo` line mark), the product, "× 3", and
  "No hay". The page then shows the total ("Total: falta precio" when a price is missing) and
  "Al marcar Listo se le avisa a Marta Reyes con el total." ("con el total" only when there is one). The big button
  is Listo, or Entregado once the order is ready. New orders also get "Empezar a preparar". A delivery shows the
  place, the map link and the fee.
- **Where a tap lands:** back on its order (a tick, Empezar, or any refusal with its notice); on the list after a
  saved Listo or Entregado; on the list with "Ese pedido ya no está en la lista." when the order is gone. Listo on
  an old version is still refused with "Este pedido cambió. Revisá la versión nueva." and the page shows the new
  version.
- **Store isolation:** the order page searches only the session store's own `preparationList`. The ID in the
  address is used for nothing else. Another store's ID, or an odd one, sends you to the list with "ya no está".
- **Pendientes badge:** owner pages read `countOpen` and show the count on the tab ("99+" past 99). Staff pages
  never call it. If the read fails, the page shows without the count and logs a warning with IDs only.
- **Shared look:** C5 Pendientes uses cards, an "urgente" chip, section titles with counts, and the time with the
  end of the number. C7 Más uses rows in one card with "›" and "Pronto" chips. Everything is inline CSS, with no
  external fonts, scripts or images.

### How it was verified

- At the start: `npm test` → `Test Files  39 passed (39)`, `Tests  517 passed (517)`.
- `npm run typecheck` → both `tsc` runs exit 0, no output.
- `npm test` → `Test Files  40 passed (40)`, `Tests  530 passed (530)`. The extra file is `test/first-turn.test.ts`,
  which someone else added during this run (see risks).
- `npx wrangler types --check` → `✨ Types at worker-configuration.d.ts are up to date.`
- Against the running simulator (`wrangler dev` on :8787):
  - `curl /console/preparacion` → 200, `<h1>Pedidos</h1>`, "Hoy · 3 por preparar".
  - `curl /console/preparacion/demo-order-1` → 200, `<h1>Carla</h1>`, "Versión 2 · Recoge en tienda".
  - `curl /console/preparacion/demo-order-2` → 200, "Versión 1 · Entrega a domicilio".
  - `curl /console/pendientes` → 200; `curl /console/mas` → 200.
  - `curl /console/preparacion/otra-tienda` → 302 to `/console/preparacion?aviso=falta`.
- Headless Chrome screenshots at 360 px of the list, two orders, Pendientes and Más, plus a mocked badge and a
  long-name header. They led to three fixes: the badge overlapped its label, the time and "× 1" wrapped mid-value,
  and a long name hid the role.
- New tests: the list cards and chips (incl. the 30-minute boundary, "1 h 35 min", ready orders last); list →
  order navigation and the page's contents; a new delivery order; escaping on both pages; tap landings and Listo
  on an old version; another store's order ID and odd IDs on the order page (only the session's store is read); the
  name and role on every screen and the naming rule; the badge for the owner, none and no read for staff,
  "99+", and a failed read.

### Choices Angel should know about

1. **Which name shows.** The request said `COALESCE(memberships.display_name, users.display_name)`.
   `docs/architecture.md` says the console never shows the shared `users.display_name` except an owner's own, and
   the repo already had `MEMBER_NAME` for exactly that. So I reused it. Owners get exactly the COALESCE. Staff
   get only the name their store gave them.
2. **"Empleado" for everyone.** We don't store gender, so "Rosa · Empleado", not "Empleada". The change note uses
   the customer's name ("Marta Reyes cambió…") instead of "La clienta"; with no name it says "El pedido cambió…".
3. **Late limit:** 30 minutes, a constant (`LATE_AFTER_MINUTES`), until there's a store setting for Johan's limit.
4. **"Empezar a preparar" kept** as a second button on new orders, since the wireframe leaves "tap or automatic"
   open. Opening an order never changes it. A tick also starts preparing (the engine does that).
5. **The order page refreshes every 15 s** like the list, so a customer's change shows without a tap.
6. **"antes 2" isn't shown.** `PreparationCard` doesn't carry the previous quantity. A changed line is
   highlighted with a "Cambió" chip instead. Showing "antes 2" needs a contract addition (the previous quantity per
   changed line).
7. **Ready cards show the confirm time**, not "avisado 7:40". The card has no ready time.
8. **The "estado" notice now says** "Ese botón ya no aplica. El pedido ya está al día." (was "La lista…"), since
   it shows on the order page.
9. "Hoy · N por preparar" counts orders still to pack. It says "Hoy" even when an older order is still on the list.

### Not done, risks, open questions

- **Someone else edited this worktree during my run.** `src/domain/contract/outcomes.ts`, `src/domain/replies.ts`,
  `src/infrastructure/memory/memory-engine.ts` and `test/order-flow.test.ts` changed, and `test/first-turn.test.ts`
  appeared. The changes add a `what_to_order` question and don't touch the console. I left them alone. The full
  test run above includes them.
- `docs/architecture.md` still says Pendientes from outside the engine "only logs". Migration 0018 made that stale.
  That's part of the menu work, not this change, so I left it.
- Not tried on a real phone. The layout was checked in headless Chrome at 360 px on the simulator's demo orders.
- Line checks are one-way: the engine has no way to undo a mark.

### Next steps

- Angel reviews the look in the simulator (`/console/preparacion`, then tap a card), decides on choices 1–5, and
  commits the menu work and this change together.
- If "antes 2" matters for the demo, propose the previous quantity on changed lines in `docs/contract.md`.
