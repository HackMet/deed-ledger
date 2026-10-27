'use strict';
// Shared helpers: arg parsing, Meta Model API client, pricing, stats.
// No dependencies; Node 22 global fetch.

const API_BASE = 'https://api.meta.ai/v1';
// Authoritative list prices, Spark 1.3 standard (checked 2026-10-27):
// https://dev.meta.ai/docs/pricing-rate-limits
const PRICE_SOURCE = 'https://dev.meta.ai/docs/pricing-rate-limits';
const PRICE_INPUT_PER_M = 1.25;
const PRICE_OUTPUT_PER_M = 4.25;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

function costUsd(usage) {
  if (!usage) return 0;
  const input = usage.prompt_tokens || 0;
  const output = usage.completion_tokens || 0;
  return (input * PRICE_INPUT_PER_M + output * PRICE_OUTPUT_PER_M) / 1e6;
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// POST /chat/completions with one retry on 429/5xx. Returns { json, latencyMs, retried }.
// Throws Error with `status` on persistent failure.
async function chatCompletions(apiKey, body, { timeoutMs = 90000, maxRetries = 1 } = {}) {
  let lastErr;
  let retried = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - t0;
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
      if (res.ok) return { json, latencyMs, retried };
      const err = new Error(`API ${res.status}: ${text.slice(0, 500)}`);
      err.status = res.status;
      err.body = text;
      lastErr = err;
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        retried++;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    } catch (e) {
      clearTimeout(timer);
      if (e.status) throw e; // already classified (rethrow, no double retry)
      lastErr = e;
      if (attempt < maxRetries) {
        retried++;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

module.exports = { parseArgs, costUsd, percentile, sleep, chatCompletions, API_BASE, PRICE_SOURCE };
