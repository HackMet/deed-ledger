## Handoff: console shell and Empleados (#23)

- Agent and branch: Claude Code, `claude/console-shell` in the worktree `../hackathon-claude-console`, on top of the
  login commit (dfce488). Nothing is committed, pushed or deployed. Angel commits.
- Objective: one shell that every console screen renders into, so kercmari adds screens as files; Empleados for the
  owner; the first-login notice about voice notes.
- References: issue #23 (plan 15b), #22 (login), Tech Spec "Console", PRD story "Staff and roles", `AGENTS.md`
  owner-facing copy rules.
- Files changed:
  - `src/interfaces/http/console.ts` moved to `src/interfaces/http/console/preparacion.ts` (the preparation list,
    unchanged behavior, now inside the layout).
  - New in `src/interfaces/http/console/`: `index.ts` (routing: auth, middleware, one line per screen), `layout.ts`
    (`shell`, `NAV`, `csrfField`, `simplePage` moved here from `auth.ts`), `empleados.ts`, `bienvenida.ts`.
  - `src/interfaces/http/console/auth.ts`: imports `simplePage` from the layout; after login, redirects to
    `/console/bienvenida` until the notice was acknowledged.
  - `src/application/ports.ts` (added only): six methods on `ConsoleAuthRepository` (`addStaff`,
    `createStaffInvite`, `removeStaff`, `setFiadoPermission`, `voiceNoticeSeen`, `markVoiceNoticeSeen`).
  - `src/infrastructure/d1/console-auth-repository.ts`: their D1 implementations.
  - New `migrations/0008_console_staff.sql`: `memberships.voice_notice_seen_at_ms`.
  - Tests: `test/console.test.ts` moved to `test/console-preparacion.test.ts`; the login helpers moved from
    `test/console-auth.test.ts` to new `test/helpers/console.ts`; new `test/console-empleados.test.ts`;
    `test/console-auth.test.ts` expects the first login to land on `/console/bienvenida`;
    `test/secrets.test.ts` lists migration 0008.
  - `docs/architecture.md`: screens, Empleados and the voice-note notice.
- What was done:
  - Layout for a 360 px screen: header with title and "Actualizar", tabs (Pedidos; Empleados for the owner only),
    notice, then the screen. Adding a screen: a file exporting `xScreen(app)`, one line in `index.ts`, a `NAV` entry.
  - Empleados (every route behind `requireOwner`, CSRF and the cross-site check like every console POST):
    - "Invitar a alguien" (name, phone): eight digits get 504 in front; a new person becomes staff; an existing
      person keeps their name and role; an owner's number is refused. Shows the link as text (not a tappable link,
      so the owner doesn't log themselves out by tapping it), a "Mandarlo por WhatsApp" wa.me button, and
      `Cache-Control: no-store`.
    - "Código nuevo" for active staff, "Volver a invitar" for removed staff (reactivates, fiado off).
    - "Quitar" asks first, then deactivates the membership, expires unused invites, and calls `revokeSessions`.
    - Fiado permission on/off per staff member.
    - A person ID from a form or URL is used only together with the session's store, and only staff rows match,
      so another store's member and any owner (including the owner themselves) get "Esa persona ya no está en la
      lista de empleados." and nothing changes.
  - First login: "Antes de empezar" page about voice notes kept as records, "Entendido" stores the time on the
    membership; later logins go straight to the list. `DEV_CONSOLE` is unchanged (simulator only; dev member is
    staff, so Empleados is refused there).
- Tests run:
  - `env -C /home/angel-rodas/angel/hackathon-claude-console npm run typecheck` → both `tsc` runs exit 0, no output.
  - `env -C /home/angel-rodas/angel/hackathon-claude-console npm test` → `Test Files  20 passed (20)`,
    `Tests  169 passed (169)` (was 158 before; 11 new in `console-empleados.test.ts`).
- Not done, risks, open questions:
  - No QR on the invite page (no dependency added); the owner sends the link by WhatsApp or reads it out.
  - Owners can't be added, removed or re-coded from the console; `npm run admin:invite` covers that.
  - Notice copy ("Usalas solo para cosas de la tienda.") is mine; Angel or Johan may want different wording.
  - `test/secrets.test.ts` lists every migration by name, so each lane adding one will conflict on that line.
  - Not tried on a real phone or in `wrangler dev`; layout checked only through rendered HTML in tests.
- Next steps: kercmari adds her screens as files in `src/interfaces/http/console/`; try the Empleados flow on a
  phone in the simulator after the deploy.
