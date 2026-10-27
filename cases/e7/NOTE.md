# E7 - Template vs model control (protocol, no new cases)

Question: does the model beat a fixed template for E3-style questions?

## Protocol

1. Seed the identical `cases/e3/records.json` fixture for both arms.
2. Run the same ten `cases/e3/E3-*.json` questions twice:
   - Arm T (template): fill the fixed template below from tool results only.
     No model call. The template refuses by construction when inputs are
     missing.
   - Arm M (model): Spark explains the same tool results, under the frozen E3
     refusal rule.
3. Score each arm against the E3 `expected` of every case.
4. Report per arm: correctness (x/10 with failed IDs), latency p50/p95, and
   list-price cost per correct answer. State list-price vs billed.

## Baseline template (review wording)

"Hoy vendiste L___ en ___ registros. Te falta costo en ___, asi que no puedo
decirte la ganancia."

Lane guidance: extend the skeleton to expenses, fiado, and stock answers in
the same flat style (fill numbers from tool outputs, name what is missing,
never compute profit). Keep the template deterministic and log its exact text
with the result card.

## Success

- Model wins: handles follow-ups and phrasing variety the template cannot,
  with zero unsupported numbers.
- Template wins: equal correctness and faster. Then ship the template for
  routine closes and reserve the model for interpretation.

Time box: 30 min. Cannot prove which style Johan prefers; that is a visit
question.
