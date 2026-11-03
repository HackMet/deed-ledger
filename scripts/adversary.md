# Adversary run (K8)

`scripts/adversary.mjs` makes ten attacks on the demo Worker: a customer's messages, a forged button tap, and
staff console posts with a stale version, another store's id, or a replayed key. For each attack it counts
the `facts` rows before and after, and compares the change with what an honest engine writes. Any extra fact
is a **false fact**.

## Run it

```sh
node scripts/adversary.mjs --json <file>    # from the repo root; DEMO_PORT defaults to 8791
```

It starts its own Worker on `DEMO_PORT` (default 8791, so it never collides with `./demo.sh` on 8790), from a
fresh local D1 in `.wrangler/adversary-state`. It seeds two synthetic stores, drives the attacks, prints one
table row per attack, writes `--json` if asked, and stops the Worker. It takes about six minutes.

## Exit codes

- **0**: every attack ran, no false fact, and no expected fact is missing.
- **1**: a false fact (an extra fact an attack should not have written) or a missing expected fact.
- **3**: the Worker is not the real engine (no order or no `order_confirm` fact after the setup).

## What the table shows

Each row has the attack, the expected refusal, what the Worker answered (the customer's reply, or the console's
`aviso=` notice and the logged `console_action` outcome), the total facts before and after, the expected fact
change, the observed change, and the false and missing counts. Rejections are not stored, so the notice is the
record of the refusal; the reason name itself is not in the database.

## What it proves, and what it does not

- The engine and the ledger are live code. Perception is **recorded fixtures** (K10's label): the customer's
  texts map to `demo/recordings/*.json`, plus two readings the script adds: the fixture's `injectedInstructions`
  and a store 2 copy of `firstOrder`. Nothing calls Muse and nothing is sent to WhatsApp.
- Button taps reach the Worker's intake, but the recorded perception does not pass them to the engine. Attacks 2
  and 3 therefore show that the tap wrote nothing; the stale-version refusal is shown by the staff console (attack 3).
- Engine refusals are read from the console's notice and the Worker log, never hard-coded.

`demo/run.mjs` exports its helpers for this script. It only runs `main()` when it is the entry point, and
`DEMO_STATE` lets the script keep its own D1. `./demo.sh` does not set either, so its behaviour is unchanged.
