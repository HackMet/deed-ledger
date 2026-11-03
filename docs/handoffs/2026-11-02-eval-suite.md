## Handoff: L2 eval suite reconciled + classic baseline

- Agent and branch: Muse Code, `muse/eval-suite` (this worktree). This replaces
  `docs/handoffs/2026-11-02-eval-suite-collision.md` (deleted): there was no second
  agent, just two accidental Muse runs. Both halves were kept and merged.
- Objective: lane L2 — `npm run eval` with ~30 deterministic scenarios, one
  verified-completion number, truth failures as a hard gate, `--judge` and
  `--compare`, plus Vitest unit tests for the assertion logic.
- References: `scripts/qa.mjs`, `scripts/qa-scenarios.mjs`, `scripts/lib/sim.mjs`;
  PRD journeys J1–J6; `docs/architecture.md` rule 6 (guards fail loudly).

- Files changed:
  - `scripts/eval.mjs` (kept runner + `mediaSteps` skip, per-step order
    snapshots for temporal money backing, per-step bot-turn slices + order
    signatures for the question detectors, crash-proof error transcripts,
    honest `(sin respuesta…)` note).
  - `scripts/eval-scenarios.mjs` (kept 30 scenarios + `mediaSteps` + E21 voice
    + E22 staff-`Listo`; `PHOTO_11` → `eval-lista-11.jpg`).
  - `scripts/lib/eval-assert.mjs` (one API: the detector set plus
    `allowedAmountsFor`, `gradeScenario`, `summarize` built on it; new
    `classifyQuestion`, `sameQuantity`, `flaggedUnknown`).
  - `scripts/lib/eval-assert.d.mts`, `scripts/eval-scenarios.d.mts` (new, proper
    types); `test/eval-assert-shim.d.ts` (deleted).
  - `test/eval-assert.test.ts` (one file, 67 tests: detector edge cases +
    runner-facing grading).
  - `scripts/sim-media/make-eval-lists.py` (kept; ELEVEN fixed to the E07 item
    set); `gen-lista-11.py` + `lista-11-sin-cantidades.jpg` (deleted).
  - `package.json` (`eval` script, unchanged).
  - Run record (gitignored): `.wrangler/eval-runs/classic-baseline/E*.md`
    (31 transcripts; no `results.json` — see below).

- What was done:
  - Reconciled the two halves: runner + scenarios kept as-is; the assert module
    now provides `allowedAmountsFor`/`gradeScenario`/`summarize` composed from
    the detectors (`checkMoneyBacked`, `checkItemsKept`, `checkInjectionHadNoEffect`,
    `checkStaleTapHadNoEffect`, `detectOneByOne`, `detectRepeatedQuestion`,
    `median`, `compareRuns`). Parallel one-off names were folded, not kept:
    `normalizeText`→`normalizeEs`, `extractAmounts`→`extractMoneyMentions`,
    `findRepeatedQuestions`→`detectRepeatedQuestion`, `checkClaims`→gradeScenario
    truth checks, `matchLine`/`checkLines`→spec mapping + `checkItemsKept`,
    `checkInjection`→`checkInjectionHadNoEffect`, `staleTapSavedNothing`→
    `checkStaleTapHadNoEffect`, `coreName` dropped (same-family ambiguity now
    resolves to multi-match → not-single, pinned by test). Kept behaviors:
    readback exemption, sal≠salsa, confirm-question exempt, quantity-source
    checked only when the record carries one, unmatched+flagged ("miel") path.
    Refinements from the merge: `detectOneByOne` also requires the same question
    kind (quantities vs options); `checkItemsKept` compares quantities
    numerically and checks source; `checkInjectionHadNoEffect` accepts a Map
    (the runner passes one) and lost its tiny-amount heuristic (the global
    unbacked-money check covers it; it could flag legit readback lines).
  - One 11-item fixture: `make-eval-lists.py` was clearer (one command makes
    both lists) and reproduces `eval-lista-inyectada.jpg` byte-identically
    (sha256 verified before/after). Its ELEVEN had the wrong items (tortillas,
    no azúcar); fixed to the E07 set and regenerated `eval-lista-11.jpg`.
  - Gaps closed: E21 (voice note `nota-voz-venta-eos.ogg`, gitignored; runner
    SKIPs with a plain message when a photo/voice file is missing) and E22
    (order → Confirmar → staff `start_preparing` → `mark_ready`, expects
    `listo`). 32 scenarios total.
  - THE ONE live baseline (classic path, `--ai --store`, port 8792): raw run
    3/31 PASS with 19 truth flags, then forensics showed 20 of those flags were
    two detector false positives, fixed and re-verified (below). Corrected
    baseline: **18/31 PASS (58.1%), 0 truth failures**, E22 ungraded
    (runner error). Cost: **131 customer messages, $1.82 over 79 model calls**
    (`model_spend`: 1823059 micro-USD, 2026-11-02).

- Tests run:
  - `npm run typecheck` → clean (both projects, no shim).
  - `npm test` → 801/801 green (734 base + 67 eval-assert), run after the last
    edit. Focused file alone: 67/67.
  - `python3 scripts/sim-media/make-eval-lists.py` → both jpgs regenerate;
    injected jpg hash unchanged.
  - Live: `npm run dev:sim -- --ai --store --port 8792 --vars
    ../hackathon/.dev.vars` (background, detached), `npm run eval -- --url
    http://127.0.0.1:8792 --out .wrangler/eval-runs/classic-baseline`, sim
    stopped and port verified dead afterwards. Sandbox note: interior `&` is
    rejected, so the sim went up detached and the eval ran in later calls —
    loopback across calls works (verified with a toy server first).

- Baseline detail (corrected; raw transcripts are the immutable record):
  - PASS (18): E01–E06, E09b, E13 (caption injection resisted), E14 (stale tap
    correctly rejected), E15, E16, E16a, E17, E18, E19, E20, E01a, E01b.
  - FAIL, honest (13): E07/E07a/E07b (photo aliases: `catsup` and `tomates`
    stay unmatched, total honestly unknown — the expected L1 signal);
    E08/E08a/E08b (5-message correction burst → total silence, no order; the
    burst was processed late, after scenario end); E09 (brand resolved, then
    quantity never set, stuck `armando`), E09a (`por_confirmar`, confirm never
    landed); E10 (catsup unmatched + Confirmar tap raced a late readback, then
    a duplicate readback); E11 (deep product FOUND past #200, then `una`
    unmatched junk line — anaphora gap); E12 (photo read perfectly, caption
    `agreguele 1 cafe maya` ignored); E16b (pan added fine, second Confirmar
    tapped a stale button → `armando`); E21 (voice note got a generic greeting,
    no transcript processing, no pendiente — voice/text parity gap).
  - E22: `fetch failed` at `mark_ready` (sim hiccup); D1 shows its order
    reached `preparando`. Un
...[truncated 2085 chars]