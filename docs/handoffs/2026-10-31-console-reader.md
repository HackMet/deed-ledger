## Handoff: the reader for console screens (#26)

- Agent and branch: Claude Code, `claude/console-reader` in the worktree `../hackathon-claude-conreader`, built on
  the combined branch (login, shell, customers, replies, the Muse Spark reader). Nothing committed, pushed or deployed.
- Objective: one exported function that turns a console member's photo or text into a contract `BurstReading`
  (`sale_report`, `fiado_report`, `setup_card`, and an order reading for Pedido a mano), so kercmari's Sunday
  screens use Meta's models without building that part; an upload route in the console shell.
- References: #26, #5 gap (i) (open), #21 (reader), #23 (shell), `docs/contract.md`, `CONSOLE_KINDS`.

### Files changed

- New `src/application/console-reader.ts`: `readConsoleInput`, `consoleMediaPrefix`, limits, types.
- New `src/domain/image-type.ts`: photo type from the bytes (JPEG, PNG, GIF, WebP); audio detection.
- New `src/interfaces/http/console/anotar.ts`: the Anotar screen and its body limit.
- `src/interfaces/http/console/index.ts`: the import, the body limit before `requireCsrf`, `anotarScreen(app)`.
- `src/composition.ts` (add only): `Runtime.burstReader`, built with `buildBurstReader`; `burstReader` override.
- `test/helpers/harness.ts` (add only): `burstReader` option.
- New `test/console-reader.test.ts`, `test/console-anotar.test.ts`, `test/fixtures/model/console.ts`.
- `docs/architecture.md`: a "Console reader" entry under the console section.
- No migration. No change to contract files, `ports.ts` or `wrangler.jsonc`. `MediaStore` unchanged (write only).

### What was done

- **The function.** `readConsoleInput(deps, member, { purpose, inputs })`:
  - `member` is a `Tenant` (a `ConsoleMember` fits); only `businessId` is used, and nothing in `inputs` names a store.
  - `inputs`: up to 3 of `text`, `transcript`, `photo { bytes, contentType }`, `audio`. They are read as one burst,
    in order (a photo of a product plus a typed price, say).
  - `purpose: "report"` reads with the console prompt and schema. `purpose: "order"` (Pedido a mano) reads with the
    order prompt, no open order, no pending question, and keeps only `customer_order`, `fulfillment`,
    `customer_name` and `other`; anything else becomes `other` with only its `embedded_instructions` warnings
    kept, and its matches are dropped (positions stay, so the other matches' indexes hold).
  - Checks before anything is stored or spent: blank text is ignored, nothing left is `empty`; more than 3 is
    `too_many`; text over 2,000 characters or a photo over 5 MB is `too_large`; audio (declared or by its bytes:
    OGG, WebM, WAV, M4A) is `voice_not_ready`; anything else that isn't JPEG/PNG/GIF/WebP by its bytes is
    `unsupported_photo`. The client's content type is never trusted; the sniffed type is stored and sent.
  - Photos go to R2 through the existing `putImmutable` at `stores/<business>/console/<sha256>`, before the call.
  - Then the existing `BurstReader` (same validation, same per-store daily spend cap). Its refusals pass through
    (`spend_cap`, `rejected`, `unavailable`, `invalid_output`).
  - Returns `{ ok, purpose, reading, matches, labelMatches, media }`. Saves no observation.
  - `deps.catalog` is optional (none until a catalog repository exists); the route passes none.
  - Logs: `console_reader.read` / `console_reader.refused` / `console_reader.failed` with `businessId`, counts and
    reason codes only.
- **Anotar** (`GET/POST /console/anotar`), owner and staff (reading changes nothing; the engine's actions keep
  their role checks). One multipart form: "¿Qué es?" (Venta, fiado o producto nuevo / Pedido a mano), a text box,
  an optional photo (`capture="environment"`). The result shows what was read ("Esto entendí", "Todavía no se
  guarda nada.") with `Cache-Control: no-store`; refusals re-show the form with a short notice. Model text is
  escaped by Hono's `html`. A thrown storage or ledger error shows "No pude leerlo ahorita" (503), not a 500.
- **Body size.** `requireCsrf` reads the whole body, so a `bodyLimit` (5 MB + 64 KB) for `/anotar` is mounted after
  `requireMember` and before `requireCsrf`; unauthenticated posts never get their body read. The handler and the
  function then enforce exactly 5 MB per photo.
- **Voice:** not built. Audio answers "Las notas de voz aquí vienen pronto. Por ahora escribilo o tomale foto."
  The in-page recorder (PCM → 16 kHz WAV, ≤ 2 min, ≤ 5 MB) waits for #27.

### Tests run

- `npm run typecheck` → both `tsc` runs exit 0, no output.
- `npm test` → `Test Files  29 passed (29)`,
  `Tests  331 passed (331)`.
- `test/console-reader.test.ts` (17, exported function, no HTTP, the composition's `buildBurstReader` with a
  recorded fetch, real D1 and R2): a sale by text (console prompt and schema, evidence span, logs without text), a
  fiado by text (code match `exact_name`), a setup card from a photo (stored under the store's console prefix as
  `image/jpeg` even when the client said `application/octet-stream`), a console response with a customer kind
  refused, Pedido a mano (order prompt, no open order, code match plus label pick), Pedido a mano holding a cancel
  and a stop (both `other`, warning kept), 8 refusals that neither call the model nor write R2, the spend cap, and
  the store coming only from the member (spy on the media store and the reader; the R2 store refuses another
  store's prefix).
- `test/console-anotar.test.ts` (12): no session → 401; staff and owner read a sale; Pedido a mano; missing or
  wrong CSRF → 403; another site's origin → 403; a photo over 5 MB → 413 with nothing stored; an oversize body
  without CSRF → 413 (the limit answers before CSRF reads it); audio → "vienen pronto"; empty form; a post naming
  another store in four form fields and the filename stores only under the session's store; a failing reader →
  503 with the try-later notice. No test touches the network.

### Not done, risks, open questions

- **Gap (i) is open.** I picked the simplest shape that keeps the engine in charge: the function returns the
  reading for display and saves nothing. Contract questions:
  1. Where does a console reading live until it's confirmed? A screen posting it back would make it untrusted
     input. Proposal: the engine stores the reading (observations, matches, media keys, member, a reading ID) when
     it's shown, and `confirm_observation` takes that ID.
  2. One tap for all observations of one note: `confirm_observation` per observation, or a `confirm_reading` with
     the reading ID?
  3. Pedido a mano has no conversation or customer. Does the engine take a `customer_order` reading with a
     typed customer name, or a separate console action? The order reading here keeps `customer_name` for that.
  4. `customer_order` isn't in `CONSOLE_KINDS`. This code reads Pedido a mano with the customer audience instead
     of changing the contract; the contract may prefer a console kind for it.
  5. Kinds kept for Pedido a mano (`customer_order`, `fulfillment`, `customer_name`, `other`): right list?
  6. Can staff read every console kind, or is `setup_card` owner-only? I let both read; saving is the engine's.
  7. `setup_card.barcode` stays null: the scanner isn't wired in. Should `inputs` carry a scanned barcode?
  8. Where console media lives: `stores/<business>/console/<sha256>` is my choice.
- **Not wired:** no catalog repository, so the screen passes no catalog (no matches on screen). No `NAV` tab for
  Anotar (reach it at `/console/anotar`); kercmari's screens may call the function instead.
- **Dev console:** `DEV_CONSOLE`'s `dev-store` isn't a seeded business, so the spend ledger's foreign key fails and
  Anotar shows the try-later notice there.
- **Fixtures are authored**, not live: they pin our mapping and checks, not the model's accuracy on console notes
  or photos (#28).
- **A photo is stored even when the read then fails** (spend cap, provider down). Immutable keys make a retry
  rewrite the same object.
- Not tried on a phone or in `wrangler dev`; the page was checked only through rendered HTML in tests.

### Next steps

1. Angel: review and commit.
2. Decide the gap (i) questions with kercmari; then the engine stores and confirms console readings.
3. #27: transcripts flow in as `{ type: "transcript" }`; build the in-page WAV recorder then.
4. Wire a catalog repository into `deps.catalog` when one exists.
