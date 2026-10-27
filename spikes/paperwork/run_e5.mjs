// Lane B: E5 catalog-disambiguation runner + scorer. Usage:
//   bash -c 'set -a; source .dev.vars; set +a; node spikes/paperwork/run_e5.mjs'
// Writes spikes/paperwork/results/e5.json
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { chatJson, listCost, MODEL, PRICE_URL } from "./provider.mjs";
import { E5_SCHEMA, E5_PROMPT_V1, E5_PROMPT_V2 } from "./schemas.mjs";

const USE_V2 = process.env.PROMPT_V2 === "1";
const PROMPT_VERSION = USE_V2 ? "e5-prompt-v2" : "e5-prompt-v1";
const PROMPT = USE_V2 ? E5_PROMPT_V2 : E5_PROMPT_V1;
const ONLY = process.env.CASE_ONLY ? process.env.CASE_ONLY.split(",") : null;
const CASE_DIR = "spikes/cases/e5";
const OUT = "spikes/paperwork/results/e5.json";

const catalog = JSON.parse(readFileSync(`${CASE_DIR}/catalog.json`, "utf8"));
const caseFiles = readdirSync(CASE_DIR).filter((f) => /^E5-\d+\.json$/.test(f)).sort();
const allCases = caseFiles.map((f) => JSON.parse(readFileSync(`${CASE_DIR}/${f}`, "utf8")));
const cases = ONLY ? allCases.filter((c) => ONLY.includes(c.id)) : allCases;
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));

function partitionText(store) {
  return catalog.stores[store]
    .map((p) => `${p.product_id} "${p.name}" aliases [${p.aliases.join("; ")}]`)
    .join("\n");
}

function userText(c) {
  let t = `Store ${c.context.store} catalog (this store ONLY; no other IDs exist):\n${partitionText(c.context.store)}\nOwner message: "${c.input.body}"`;
  if (c.context.open_case) {
    const open = byId[c.context.open_case];
    t += `\nOpen context: the previous message "${open.input.body}" was ambiguous between ${open.expected.candidates.join(" and ")}; the owner was asked which one. This new message answers that question.`;
  }
  return t;
}

function idTokens(out) {
  const texts = [out.product_id, ...(out.candidates ?? []), out.owner_reply, ...(out.ambiguities ?? [])];
  const toks = new Set();
  for (const t of texts) {
    for (const m of String(t ?? "").matchAll(/\bP-[A-Z0-9-]+/g)) toks.add(m[0]);
  }
  return toks;
}

function score(c, out) {
  const fails = [];
  const exp = c.expected;
  if (out.verdict !== exp.verdict) fails.push(`verdict ${out.verdict} != expected ${exp.verdict}`);
  if (exp.verdict === "match" && out.product_id !== exp.product_id) {
    fails.push(`product_id ${out.product_id} != expected ${exp.product_id}`);
  }
  if ((exp.verdict === "ask" || exp.verdict === "ask_create")) {
    const got = [...(out.candidates ?? [])].sort();
    const want = [...(exp.candidates ?? [])].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fails.push(`candidates [${got}] != expected [${want}]`);
    }
    if (out.product_id !== null) fails.push(`product_id must be null on ${exp.verdict}, got ${out.product_id}`);
  }
  if (exp.must_ask) {
    if (!String(out.owner_reply).trim().endsWith("?")) fails.push("must_ask: owner_reply does not end with '?'");
    if (!(out.ambiguities ?? []).length) fails.push("must_ask: ambiguities is empty");
  } else {
    if (String(out.owner_reply).trim().endsWith("?")) fails.push("must_ask=false but owner_reply asks a question");
  }
  const toks = idTokens(out);
  for (const bad of exp.must_not_contain ?? []) {
    if (toks.has(bad)) fails.push(`must_not_contain: exact ID ${bad} present`);
  }
  return fails;
}

const results = [];
let totIn = 0, totOut = 0;
const lat = [];
for (const c of cases) {
  const r = await chatJson({
    system: PROMPT,
    userParts: [{ type: "text", text: userText(c) }],
    schema: E5_SCHEMA,
    schemaName: "e5_disambiguation",
  });
  const fails = score(c, r.data);
  totIn += r.usage.input_tokens;
  totOut += r.usage.output_tokens;
  lat.push(r.latencyMs);
  results.push({
    id: c.id, pass: fails.length === 0, fails,
    output: r.data,
    latency_ms: r.latencyMs,
    input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens,
    cost_usd_list: +listCost(r.usage.input_tokens, r.usage.output_tokens).toFixed(6),
    model: r.model, prompt_version: PROMPT_VERSION,
  });
  console.log(`${c.id}: ${fails.length === 0 ? "PASS" : "FAIL " + fails.join(" | ")} (${r.latencyMs}ms, ${r.usage.input_tokens}+${r.usage.output_tokens} tok)`);
}
let finalCases = results;
let promptNote = PROMPT_VERSION;
if (ONLY) {
  const prev = JSON.parse(readFileSync(OUT, "utf8"));
  const fresh = new Map(results.map((r) => [r.id, r]));
  finalCases = prev.cases.map((r) => fresh.get(r.id) ?? r);
  promptNote = `${prev.prompt_version}+${PROMPT_VERSION}(rerun ${results.map((r) => r.id).join(",")})`;
  totIn += prev.summary.input_tokens - prev.cases.filter((r) => fresh.has(r.id)).reduce((s, r) => s + r.input_tokens, 0);
  totOut += prev.summary.output_tokens - prev.cases.filter((r) => fresh.has(r.id)).reduce((s, r) => s + r.output_tokens, 0);
}
const allLat = finalCases.map((r) => r.latency_ms).sort((a, b) => a - b);
const p50 = allLat[Math.floor((allLat.length - 1) / 2)], p95 = allLat[Math.ceil(allLat.length * 0.95) - 1];
const totalCost = +listCost(totIn, totOut).toFixed(6);
mkdirSync("spikes/paperwork/results", { recursive: true });
writeFileSync(OUT, JSON.stringify({
  experiment: "E5", date: "2026-10-27", model: MODEL, prompt_version: promptNote,
  price_source: PRICE_URL, price_per_m: { input: 1.25, output: 4.25 },
  summary: {
    passed: finalCases.filter((r) => r.pass).length, total: finalCases.length,
    failed_ids: finalCases.filter((r) => !r.pass).map((r) => r.id),
    latency_p50_ms: p50, latency_p95_ms: p95,
    input_tokens: totIn, output_tokens: totOut, cost_usd_list: totalCost,
  },
  cases: finalCases,
}, null, 2));
console.log(`E5: ${finalCases.filter((r) => r.pass).length}/${finalCases.length} pass; cost $${totalCost} list`);
