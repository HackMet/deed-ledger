'use strict';
// E4 voice runner: WAV -> Muse Voice Transcribe -> E1 pipeline -> two-part scores.
// Audio (OGG/WAV) and the intermediate transcripts file stay OUTSIDE git in the
// audio folder. The committed results file keeps transcript text + scores only.
//
// Step 1 (transcribe; key from MODEL_API_KEY env):
//   node spikes/voice/run_e4.js --step transcribe --cases ./spikes/cases/e4 \
//     --audio /home/angel-rodas/angel/hackathon-audio/wav --conversions <wav/e4-conversion.json> \
//     --out /home/angel-rodas/angel/hackathon-audio/wav/e4-transcripts.json
// Step 2 (interpret; REVIEW transcripts for filename mismatches first):
//   node spikes/voice/run_e4.js --step interpret --transcripts <above> \
//     --cases ./spikes/cases/e4 --e1cases ./spikes/cases/e1 \
//     --model muse-spark-1.3 --out ./spikes/results/e4.json

const fs = require('fs');
const path = require('path');
const { parseArgs, percentile, costUsd } = require('../runner/lib');
const { SparkModelProvider } = require('../runner/provider');
const { scoreE1 } = require('../runner/e1');
const { PROMPT_VERSION_E1 } = require('../runner/prompts');
const { VoiceTranscriber, ASR_MODEL, VOICE_PRICE_SOURCE } = require('./transcriber');

function fold(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function tokens(s) {
  return fold(s).split(/[^a-z0-9]+/).filter(Boolean);
}

// Fraction of reference tokens present in the transcript (mismatch signal).
function overlap(transcript, reference) {
  const T = new Set(tokens(transcript));
  const R = tokens(reference);
  if (!R.length) return 0;
  let n = 0;
  for (const w of R) if (T.has(w)) n++;
  return n / R.length;
}

const NUMBER_WORDS = ['cero', 'uno', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis',
  'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
  'dieciseis', 'veinte', 'treinta', 'cincuenta', 'cien', 'ciento', 'doscientos',
  'trescientos', 'quinientos', 'mil'];

function transcriptHasNumber(t) {
  const f = fold(t);
  if (/\d/.test(f)) return true;
  const set = new Set(tokens(t));
  return NUMBER_WORDS.some((w) => set.has(w));
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function stepTranscribe(args) {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) { console.error('MODEL_API_KEY is not set. Load it with: set -a; . ./.dev.vars; set +a'); process.exit(2); }
  const casesDir = args.cases;
  const audioDir = args.audio;
  const out = args.out;
  if (!casesDir || !audioDir || !out) { console.error('transcribe needs --cases --audio --out'); process.exit(2); }
  const conversions = args.conversions ? loadJson(args.conversions) : {};
  const transcriber = new VoiceTranscriber({ apiKey });
  const files = fs.readdirSync(casesDir).filter((f) => /^E4-\d+\.json$/.test(f)).sort();
  const cases = files.map((f) => loadJson(path.join(casesDir, f)));
  const refs = cases.map((c) => ({ id: c.id, e1: c.interpretation_case, text: c.reference_transcript }));
  const results = [];
  for (const c of cases) {
    const e1id = c.interpretation_case.toLowerCase();
    const wavPath = path.join(audioDir, `e4-${e1id}.wav`);
    const wavBytes = fs.readFileSync(wavPath);
    const sessionId = `e4-${c.id.toLowerCase()}`;
    const r = await transcriber.transcribe(wavBytes, { sessionId });
    const terms = c.expected.transcript_must_mention || [];
    const found = {};
    for (const t of terms) found[t] = fold(r.transcript).includes(fold(t));
    const scored = refs.map((ref) => ({ id: ref.id, e1: ref.e1, overlap: overlap(r.transcript, ref.text) }))
      .sort((a, b) => b.overlap - a.overlap);
    const mismatch = scored.length > 0 && scored[0].id !== c.id;
    results.push({
      id: c.id, e1: c.interpretation_case, wav: path.basename(wavPath),
      wav_bytes: wavBytes.length, conversion_ms: conversions[c.id] ?? null,
      reference: c.reference_transcript, transcript: r.transcript,
      audio_duration_ms: r.audioDurationMs, transcribe_latency_ms: r.latencyMs,
      transcribe_retried: r.retried, transcribe_cost_usd: r.costUsd,
      terms_found: found, transcription_pass: terms.every((t) => found[t]),
      best_match: scored[0] || null, mismatch,
    });
    console.log(`${c.id} (${c.interpretation_case}): "${r.transcript}" [${r.audioDurationMs}ms audio, ${r.latencyMs}ms] terms ${Object.values(found).filter(Boolean).length}/${terms.length}${mismatch ? ` MISMATCH? best=${scored[0].id}` : ''}`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    model: ASR_MODEL, mode: 'PUSH_TO_TALK', language_bias: ['Spanish'],
    price_source: VOICE_PRICE_SOURCE, cases: results,
  }, null, 2) + '\n');
  console.log(`wrote ${out}`);
}

async function stepInterpret(args) {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) { console.error('MODEL_API_KEY is not set. Load it with: set -a; . ./.dev.vars; set +a'); process.exit(2); }
  const model = args.model || 'muse-spark-1.3';
  if (model.includes('contributor')) { console.error('Refusing *-contributor model ID.'); process.exit(2); }
  const transcriptsPath = args.transcripts;
  const casesDir = args.cases;
  const e1Dir = args.e1cases;
  const out = args.out;
  if (!transcriptsPath || !casesDir || !e1Dir || !out) {
    console.error('interpret needs --transcripts --cases --e1cases [--model] --out'); process.exit(2);
  }
  const { cases: transcripts } = loadJson(transcriptsPath);
  const provider = new SparkModelProvider({ apiKey, model });
  const results = [];
  for (const t of transcripts) {
    if (t.mismatch && !args['score-mismatched']) {
      results.push({ ...t, scored: false, score_skip_reason: 'filename/reference mismatch -- held for Angel before scoring' });
      console.log(`${t.id}: NOT SCORED (mismatch held)`);
      continue;
    }
    const e1case = loadJson(path.join(e1Dir, `${t.e1}.json`));
    const t0 = Date.now();
    try {
      const r = await provider.proposeOperation(t.transcript);
      const fails = scoreE1(e1case, r.output);
      const invented = !transcriptHasNumber(t.transcript) &&
        (r.output.quantity_value !== null || r.output.amount_minor !== null);
      results.push({
        ...t, scored: true, interpret_latency_ms: Date.now() - t0,
        interpret_usage: r.usage, interpret_cost_usd: costUsd(r.usage),
        interpretation_pass: fails.length === 0, interpretation_failures: fails,
        e1_output: r.output, downstream_invention: invented,
      });
      console.log(`${t.id}: transcription ${t.transcription_pass ? 'PASS' : 'FAIL'} | interpretation ${fails.length === 0 ? 'PASS' : 'FAIL'}${fails.length ? ' -- ' + fails[0] : ''}${invented ? ' | INVENTED-FIGURE' : ''}`);
    } catch (e) {
      results.push({ ...t, scored: true, interpret_latency_ms: Date.now() - t0, interpretation_pass: false, interpretation_failures: [`ERROR: ${e.message}`] });
      console.log(`${t.id}: ERROR -- ${e.message}`);
    }
  }
  const scored = results.filter((r) => r.scored);
  const lat = (f) => scored.map((r) => r[f]).filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  const conv = lat('conversion_ms');
  const tr = lat('transcribe_latency_ms');
  const it = lat('interpret_latency_ms');
  const totals = {
    cases: results.length,
    transcription_passed: results.filter((r) => r.transcription_pass).length,
    interpretation_passed: scored.filter((r) => r.interpretation_pass).length,
    not_scored: results.filter((r) => !r.scored).map((r) => r.id),
    downstream_inventions: scored.filter((r) => r.downstream_invention).map((r) => r.id),
    conversion_ms_p50: percentile(conv, 50),
    transcribe_latency_ms_p50: percentile(tr, 50),
    transcribe_latency_ms_p95: percentile(tr, 95),
    interpret_latency_ms_p50: percentile(it, 50),
    interpret_latency_ms_p95: percentile(it, 95),
    transcribe_cost_usd: results.reduce((s, r) => s + (r.transcribe_cost_usd || 0), 0),
    interpret_cost_usd: scored.reduce((s, r) => s + (r.interpret_cost_usd || 0), 0),
  };
  totals.cost_usd_list = totals.transcribe_cost_usd + totals.interpret_cost_usd;
  const started = transcriptsPath;
  const result = {
    exp: 'E4', asr_model: ASR_MODEL, e1_model: model, e1_prompt_version: PROMPT_VERSION_E1,
    transcripts_from: started, price_source: VOICE_PRICE_SOURCE,
    cost_basis: 'estimated list-price (voice $0.18/audio-hour whole seconds; spark $1.25/M in, $4.25/M out)',
    totals, cases: results.map(({ wav_bytes, ...rest }) => rest),
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(`---\nE4: transcription ${totals.transcription_passed}/${totals.cases} | interpretation ${totals.interpretation_passed}/${scored.length} scored | list $${totals.cost_usd_list.toFixed(6)} | wrote ${out}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.step === 'transcribe') await stepTranscribe(args);
  else if (args.step === 'interpret') await stepInterpret(args);
  else { console.error('Usage: run_e4.js --step transcribe|interpret ...'); process.exit(2); }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
