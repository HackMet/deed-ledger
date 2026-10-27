'use strict';
// CLI: node spikes/runner/run.js --exp E1|E3 --cases ./spikes/cases/eN --model muse-spark-1.3 --out ./spikes/results/eN.json
// Key from MODEL_API_KEY env (load via: set -a; source .dev.vars; set +a).

const fs = require('fs');
const path = require('path');
const { parseArgs, percentile, PRICE_SOURCE } = require('./lib');
const { SparkModelProvider } = require('./provider');
const { runE1 } = require('./e1');
const { runE3 } = require('./e3');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exp = (args.exp || '').toUpperCase();
  const casesDir = args.cases;
  const model = args.model || 'muse-spark-1.3';
  const out = args.out;
  if (!['E1', 'E3'].includes(exp) || !casesDir || !out) {
    console.error('Usage: node spikes/runner/run.js --exp E1|E3 --cases <dir> --model <id> --out <file>');
    process.exit(2);
  }
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) {
    console.error('MODEL_API_KEY is not set. Load it with: set -a; source .dev.vars; set +a');
    process.exit(2);
  }
  if (model.includes('contributor')) {
    console.error('Refusing *-contributor model ID.');
    process.exit(2);
  }

  const provider = new SparkModelProvider({ apiKey, model });
  const started = new Date().toISOString();
  const { prompt_version, cases } = exp === 'E1'
    ? await runE1(provider, casesDir)
    : await runE3(provider, casesDir);

  const lat = cases.map((c) => c.latency_ms).sort((a, b) => a - b);
  const totals = {
    cases: cases.length,
    passed: cases.filter((c) => c.pass).length,
    failed_ids: cases.filter((c) => !c.pass).map((c) => c.id),
    api_calls: cases.reduce((s, c) => s + (c.api_calls || 0), 0),
    retries: cases.reduce((s, c) => s + (c.retried || 0), 0),
    input_tokens: cases.reduce((s, c) => s + ((c.usage && c.usage.prompt_tokens) || 0), 0),
    output_tokens: cases.reduce((s, c) => s + ((c.usage && c.usage.completion_tokens) || 0), 0),
    latency_ms_p50: percentile(lat, 50),
    latency_ms_p95: percentile(lat, 95),
    cost_usd_list: cases.reduce((s, c) => s + (c.cost_usd || 0), 0),
  };

  const result = {
    exp, model, prompt_version, started_at: started,
    finished_at: new Date().toISOString(),
    strict_nullable_test: exp === 'E1' ? provider.strictNullable : undefined,
    price_source: PRICE_SOURCE,
    cost_basis: 'estimated list-price (input $1.25/M, output $4.25/M)',
    totals, cases,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(`---\n${exp}: passed ${totals.passed}/${totals.cases} | calls ${totals.api_calls} | tokens ${totals.input_tokens}in/${totals.output_tokens}out | list $${totals.cost_usd_list.toFixed(4)} | p50/p95 ${totals.latency_ms_p50}/${totals.latency_ms_p95}ms | wrote ${out}`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
