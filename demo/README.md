# Demo: the whole order flow on the real engine

`./demo.sh` says first and last: `PERCEPTION: RECORDED (<n> fixture, <m> muse) — fixtures until Angel records
real Muse outputs. The engine, ledger and console are live code.` Today: 6 fixture, 0 muse.

**Status on this branch: it exits 1.** Console taps don't save yet (they wait on PR #63's
`saveConsoleAction`), and customer notices ("listo", "en camino", the change answers) don't reach the
outbox yet. The script reports those steps as ✗. It never marks them passed.

## One command

```sh
./demo.sh                      # Node 20+; runs `npm ci` only if node_modules is missing
./demo.sh --json out/run.json  # also writes every step's result as JSON
./demo.sh --serve              # keeps the Worker up afterwards, prints a console login link and E's trail
DEMO_PORT=8791 ./demo.sh       # default port 8790 (never 8787 or 8799 on this host)
```

Every run wipes and rebuilds its own local state (`.wrangler/demo-state`), applies every migration, seeds a
synthetic store, starts the demo Worker (`demo/worker.ts`, `demo/wrangler.demo.jsonc`) with the simulator's
fake secrets (never `.dev.vars`), plays the scenario and stops the Worker. It exits 0 only if every
expectation held, 1 if any did not, 2 for a bad setting (`PERCEPTION=live`, a reserved port), and 3 if the
records show it is not the real engine (no order or no `order_confirm` fact after A confirms).

## What it proves

Six synthetic customers (`504000000xx`) write to the store through signed fake webhooks; the staff use
the console like a person (invite link, cookie, CSRF value, form posts). Each step prints the customer,
the message, the reply from the outbox, the fact counts that moved, and ✓/✗.

- **A** delivery order → readback → `confirmar` → Empezar → Pedido listo → dispatch to Mario → Entregado;
  A hears "listo" and "va en camino con Mario".
- **B** `confirmar` three times → exactly one `order_confirm` fact.
- **C** `confirmar` → `cancelar` → a staff tap to start it is refused; nothing written.
- **D** a change after confirming becomes a change request → owner Aprobar with a reason → version 2.
- **E** v1 → a change before confirming (v2) → `confirmar` → `cancelar` → a staff tap is refused. E's
  trail (`/console/pedidos/<id>`) shows v1 replaced and the confirm closed by the cancel.
- **F** a change request → owner Rechazar "ya no hay azúcar" → order unchanged.

## What is recorded and what is live

Live: the Worker, webhook intake, the queue, the order engine (`OrderEngine` on D1), the fact ledger,
the outbox and the console. Recorded: perception only. `demo/recorded-perception.ts` maps each scripted
message text to a `BurstReading` from `demo/recordings/*.json`; `confirmar`/`cancelar` use the fixture
handler's exact words; any other text gets the placeholder reply, never a guess. Nothing calls Muse and
nothing is sent to WhatsApp. `PERCEPTION=live ./demo.sh` exits 2: there is no live mode yet.

Every recording says where it came from. `"source": "fixture"` files are copied from
`test/fixtures/contract.ts`; `first-order-delivery.json` was built by hand to the type (no contract
fixture has a delivery reading) and says so in its `note`.

## Swapping in real Muse outputs (Angel)

Drop a JSON file into `demo/recordings/` with `"source": "muse"`, the message `text` the demo sends, the
Muse `reading` exactly as perception produced it (a `BurstReading`), and the code's catalog `matches`
(`[]` if none). A `muse` recording replaces the fixture for the same text; no code changes. The label's
counts (`n fixture, m muse`) follow the files.

## `--json`

Per step: customer, message, outbox reply, fact counts by kind before and after, the delta, the
expectation and pass/fail; plus E's orderId and trail path and the totals. K8 and K11 read it.
