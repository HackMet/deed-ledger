'use strict';
// E3 runner + scorer. Convention keys: verdict, total_minor, count,
// record_ids, must_mention, must_not_contain, must_caveat_baseline.

const fs = require('fs');
const path = require('path');
const { costUsd } = require('./lib');
const { PROMPT_VERSION_E3 } = require('./prompts');
const { createReadTools } = require('./tools');

// Markers that count as the no-baseline caveat (recorded, not complete).
const BASELINE_CAVEAT_MARKERS = ['conteo', 'inicial', 'verific', 'complet', 'registr', 'censo', 'asegurar'];

function fold(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Scoring convention (documented): matching is case- AND accent-insensitive.
function ciContains(haystack, needle) {
  return fold(haystack).includes(fold(needle));
}

function sameSet(a, b) {
  const x = [...a].sort().join('|');
  const y = [...b].sort().join('|');
  return x === y;
}

function toolTotals(toolCalls) {
  // Collect app-computed totals/ids actually returned to the model.
  const out = { totals: [], counts: [], ids: [] };
  for (const tc of toolCalls) {
    const r = tc.result || {};
    if (typeof r.total_minor === 'number') { out.totals.push(r.total_minor); out.counts.push(r.record_count); }
    if (typeof r.sales_minor === 'number') { out.totals.push(r.sales_minor, r.expenses_minor); }
    if (typeof r.count === 'number' && Array.isArray(r.entries)) out.counts.push(r.count);
    if (Array.isArray(r.record_ids)) out.ids.push(...r.record_ids);
    if (Array.isArray(r.entries)) out.ids.push(...r.entries.map((e) => e.id));
  }
  return out;
}

function scoreE3(c, output, toolCalls, truncated) {
  const fails = [];
  const exp = c.expected || {};
  if (truncated || !output) {
    fails.push('tool loop truncated (over 4 calls) or no final answer');
    return fails;
  }
  const text = output.answer_text || '';

  if (exp.verdict !== undefined && output.verdict !== exp.verdict) {
    fails.push(`verdict: expected ${exp.verdict}, got ${output.verdict}`);
  }
  const tt = toolTotals(toolCalls);
  if (exp.total_minor !== undefined) {
    // The APP must have produced the expected total from its tools.
    if (!tt.totals.includes(exp.total_minor)) {
      fails.push(`total_minor: app tools returned [${tt.totals.join(',')}], expected ${exp.total_minor}`);
    }
  }
  if (exp.count !== undefined && !tt.counts.includes(exp.count)) {
    fails.push(`count: app tools returned [${tt.counts.join(',')}], expected ${exp.count}`);
  }
  if (exp.record_ids !== undefined) {
    for (const id of exp.record_ids) {
      if (!tt.ids.includes(id)) fails.push(`record_ids: tool results missing ${id} (got [${tt.ids.join(',')}])`);
    }
    if (exp.verdict === 'answer' && !sameSet(output.cited_record_ids || [], exp.record_ids)) {
      fails.push(`cited_record_ids: model cited [${(output.cited_record_ids || []).join(',')}], expected [${exp.record_ids.join(',')}]`);
    }
  }
  for (const s of exp.must_mention || []) {
    if (!ciContains(text, s)) fails.push(`must_mention: ${JSON.stringify(s)} not in answer_text`);
  }
  for (const s of exp.must_not_contain || []) {
    if (ciContains(text, s)) fails.push(`must_not_contain: answer contains ${JSON.stringify(s)}`);
  }
  if (exp.must_caveat_baseline === true) {
    const ok = BASELINE_CAVEAT_MARKERS.some((m) => ciContains(text, m));
    if (!ok) fails.push(`must_caveat_baseline: no caveat marker (${BASELINE_CAVEAT_MARKERS.join('/')}) in answer`);
  }
  return fails;
}

async function runE3(provider, casesDir) {
  const records = JSON.parse(fs.readFileSync(path.join(casesDir, 'records.json'), 'utf8'));
  const files = fs.readdirSync(casesDir).filter((f) => f.endsWith('.json') && f !== 'records.json').sort();
  const results = [];
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf8'));
    const store = (c.context && c.context.store) || 'A';
    const today = (c.context && c.context.today) || records.today_default;
    const tools = createReadTools(records, store);
    try {
      const r = await provider.answerWithTools(c.input.body, tools, { today, store });
      const fails = scoreE3(c, r.output, r.toolCalls, r.truncated);
      results.push({ id: c.id, pass: fails.length === 0, failures: fails,
        output: r.output,
        tool_calls: r.toolCalls.map((tc) => ({ name: tc.name, args: tc.args, result: tc.result })),
        truncated: r.truncated, latency_ms: r.latencyMs, retried: r.retried,
        api_calls: r.apiCalls, usage: r.usage, cost_usd: costUsd(r.usage) });
      console.log(`${c.id}: ${fails.length === 0 ? 'PASS' : 'FAIL'}${fails.length ? ' — ' + fails[0] : ''} (${r.latencyMs}ms, ${r.toolCalls.length} tools)`);
    } catch (e) {
      results.push({ id: c.id, pass: false, failures: [`ERROR: ${e.message}`],
        output: null, tool_calls: [], truncated: false, latency_ms: 0, retried: 0,
        api_calls: 0, usage: null, cost_usd: 0 });
      console.log(`${c.id}: ERROR — ${e.message}`);
    }
  }
  return { prompt_version: PROMPT_VERSION_E3, cases: results };
}

module.exports = { runE3, scoreE3 };
