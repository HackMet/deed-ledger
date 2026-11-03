# Demo video script (3:00)

Every line of output shown on screen below was measured, with its source. A scene marked **[TBD]** may be shot only
after `./demo.sh` shows its step green (✓) on the recording machine; until then the scene is not in the cut. Spanish
appears only where it quotes the product's own copy.

**Status when this was written (2026-11-03).** `./demo.sh` is on `claude/demo-env` (`cbce8de`), not on `main`. RK10's
two runs there: 29 steps, 21 passed, 8 failed, exit 1. The steps that passed include B, E's trail and the customer
side of A, D and F. The steps that failed are the staff-side ones: A's start, ready, dispatch and delivered; D's
Aprobar; F's Rechazar; and C's and E's refused taps. Scenes 5 and 6 depend on those, so they are [TBD].
`claude/adversary` (K8) has not run, so scene 7's numbers are [TBD].

**On screen for the whole video, bottom strip, never hidden:** `PERCEPTION: RECORDED (6 fixture, 0 muse) — fixtures
until Angel records real Muse outputs. The engine, ledger and console are live code.` (the exact first line
`./demo.sh` prints). If Angel records real Muse outputs before the cut, change the counts to what `demo.sh` prints
then.

| Time | Scene | On screen | Narration | Measured output shown |
|---|---|---|---|---|
| 0:00-0:15 | 1. The problem | The pilot store's paper notebook; a WhatsApp chat | "A mercadito in Tocoa keeps its orders in a notebook. The owner already lives on WhatsApp, so the assistant works there. Customers ask in their own words, and the assistant never says something the records can't back up." | none |
| 0:15-0:35 | 2. One command | Terminal: `./demo.sh`, first line (the PERCEPTION label) in a highlight box | "One command runs six synthetic customers through the real engine and ledger. Perception is recorded fixtures until Angel records real Muse outputs; everything after it is live code." | The label line, verbatim, as `demo.sh` prints it |
| 0:35-1:05 | 3. Exactly once (customer B) | Terminal lines for B; then the fact count | "Customer B says confirm three times. The engine derives the operation key itself, so the second and third answers are the first outcome. One confirm fact, not three." | `✓ B · says “confirmar” → “Quedó confirmado tu pedido. Te aviso cuando esté listo.” · [order_confirm +1]`, then twice `→ “Tu pedido ya estaba confirmado.” · [no facts]`, then `✓ B · check: order_confirm facts from B's three confirms → 1 order_confirm fact(s)` (K10 report, run 1, `3912a38`; RK10 reran at `cbce8de`) |
| 1:05-1:50 | 4. The trail (customer E) | Browser, `/console/pedidos/<E's order>`: version 1 in **yellow** (superseded, "reemplazado"), then the confirm in **red** (closed by cancellation, "cancelado") | "E ordered, changed it to three pounds of sugar, confirmed, then cancelled. Version 1 was superseded, not erased. The confirm is closed by the cancellation. Nothing was edited; each step is a fact that points at what it came from." | `✓ E · check: trail at /console/pedidos/<E> → trail: reemplazado, cancelado` (K10 report, runs 1 and 2). The yellow and red are what the Pedidos screen derives (`docs/engine/fact-memory.md`, "Console and screens"); [TBD: confirm the colours on the recording machine] |
| 1:50-2:15 | 5. Owner decides a change (D and F) **[TBD]** | D: owner taps "Aprobar" on the change request, the customer hears "Tu cambio fue aprobado". F: owner taps "Rechazar" with the reason "ya no hay azúcar", the customer hears "No pudimos hacer el cambio: ya no hay azúcar" | "A confirmed order can't be silently edited. The customer asks for a change; the owner approves it, or declines it with a reason the customer hears." | The expected lines from K10's `demo.sh`: D `change_review +1, order_version +1, order_confirm +1; version 2`; F `change_review +1 only; version 1`. Both steps are ✗ at `cbce8de` (console commits are not saved: PR #63 follow-up). [TBD: shoot only when both are ✓] |
| 2:15-2:30 | 6. Dispatch (customer A) **[TBD]** | A's order in **blue** "en camino" with the courier's name (Mario) | "Staff send the order out with a courier; the customer hears 'va en camino con Mario'. The dispatch fact rests on the confirm." | Expected: `order en_camino; A hears /va en camino con Mario/i` (K10's expectation). ✗ at `cbce8de`. [TBD: shoot only when ✓] |
| 2:30-2:48 | 7. We attacked it | The attack table from the K8 run, one row per attack with "refused" | "We wrote attacks: stale versions, replays, facts resting on cancelled ones, claims that outlive a cancel. Here is how many we ran and how many false facts got in." | [TBD: attacks N, false facts admitted M, from the K8 report] |
| 2:48-3:00 | 8. Built during the hackathon | `docs/built-during-hackathon.md` scrolling; the README top block | "Everything here was built after the kickoff on October 26; every commit and pull request is listed with its date. The live link and the repo are below." | `146 commits, 0 dated before kickoff, on origin/main 7bec048` (`node scripts/built-during.mjs`, 2026-11-03); [TBD: regenerate before recording and use that number]; [TBD: live link]; [TBD: video link] |

## Recording checklist

1. Run `./demo.sh` on the machine that records. Use only scenes whose steps are ✓. A run takes about 4.5 minutes
   (K10 report), so record the terminal once and cut it.
2. Keep the PERCEPTION strip on screen in every scene.
3. Never say "live Muse" or "reads photos" about the demo: perception is recorded fixtures.
4. Regenerate the numbers right before recording: `node scripts/built-during.mjs`, `npm test`.
5. If scenes 5 to 7 are not ready, the cut is scenes 1 to 4 and 8, stretched to 3:00, with the failing steps named
   in the narration as not done yet. A shorter honest video beats a long one that shows a step that fails.
