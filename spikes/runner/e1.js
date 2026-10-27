'use strict';
// E1 runner + scorer. Convention keys: kind, must_equal, must_be_null,
// must_ask, must_not_contain, must_mention.

const fs = require('fs');
const path = require('path');
const { costUsd } = require('./lib');
const { PROMPT_VERSION_E1 } = require('./prompts');

function loadCases(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'records.json')
    .sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function fold(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Scoring convention (documented): matching is case- AND accent-insensitive,
// so a correct unaccented "que" satisfies must_mention "qué".
function ciContains(haystack, needle) {
  return fold(haystack).includes(fold(needle));
}

function scoreE1(c, output) {
  const fails = [];
  const exp = c.expected || {};
  const blob = JSON.stringify(output);

  if (exp.kind !== undefined && output.kind !== exp.kind) {
    fails.push(`kind: expected ${exp.kind}, got ${output.kind}`);
  }
  for (const [field, want] of Object.entries(exp.must_equal || {})) {
    if (JSON.stringify(output[field]) !== JSON.stringify(want)) {
      fails.push(`must_equal.${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(output[field])}`);
    }
  }
  for (const field of exp.must_be_null || []) {
    if (output[field] !== null) {
      fails.push(`must_be_null.${field}: got ${JSON.stringify(output[field])} (invented value)`);
    }
  }
  if (exp.must_ask === true) {
    const asked = (output.missing?.length > 0 || output.ambiguities?.length > 0) &&
      typeof output.owner_reply === 'string' && output.owner_reply.trim().endsWith('?');
    if (!asked) fails.push('must_ask:true but no question (need non-empty missing/ambiguities + owner_reply ending in "?")');
  } else if (exp.must_ask === false) {
    // Convention defines true; for false we require no question mark and empty missing.
    if (typeof output.owner_reply === 'string' && output.owner_reply.trim().endsWith('?')) {
      fails.push('must_ask:false but owner_reply ends with "?"');
    }
    if (output.missing?.length > 0) {
      fails.push(`must_ask:false but missing=[${output.missing.join('; ')}]`);
    }
  }
  for (const s of exp.must_not_contain || []) {
    if (ciContains(blob, s)) fails.push(`must_not_contain: output contains ${JSON.stringify(s)}`);
  }
  const mentionHay = `${output.owner_reply || ''}\n${(output.ambiguities || []).join('\n')}`;
  for (const s of exp.must_mention || []) {
    if (!ciContains(mentionHay, s)) fails.push(`must_mention: ${JSON.stringify(s)} not in owner_reply/ambiguities`);
  }
  return fails;
}

async function runE1(provider, casesDir) {
  const cases = loadCases(casesDir);
  const results = [];
  for (const c of cases) {
    const t0 = Date.now();
    try {
      const r = await provider.proposeOperation(c.input.body);
      const fails = scoreE1(c, r.output);
      results.push({ id: c.id, pass: fails.length === 0, failures: fails,
        output: r.output, latency_ms: r.latencyMs, retried: r.retried,
        api_calls: r.apiCalls, usage: r.usage, cost_usd: costUsd(r.usage) });
      console.log(`${c.id}: ${fails.length === 0 ? 'PASS' : 'FAIL'}${fails.length ? ' — ' + fails[0] : ''} (${r.latencyMs}ms)`);
    } catch (e) {
      results.push({ id: c.id, pass: false, failures: [`ERROR: ${e.message}`],
        output: null, latency_ms: Date.now() - t0, retried: 0, api_calls: 0, usage: null, cost_usd: 0 });
      console.log(`${c.id}: ERROR — ${e.message}`);
    }
  }
  return { prompt_version: PROMPT_VERSION_E1, cases: results };
}

module.exports = { runE1, scoreE1 };
