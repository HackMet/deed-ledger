// Lane B: E2 paperwork-extraction runner + scorer. Usage:
//   bash -c 'set -a; source .dev.vars; set +a; node spikes/paperwork/run_e2.mjs'
// Writes spikes/paperwork/results/e2.json
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { chatJson, listCost, MODEL, PRICE_URL } from "./provider.mjs";
import { E2_SCHEMA, E2_PROMPT_V1, E2_PROMPT_V2 } from "./schemas.mjs";

const USE_V2 = process.env.PROMPT_V2 === "1";
const PROMPT_VERSION = USE_V2 ? "e2-prompt-v2" : "e2-prompt-v1";
const PROMPT = USE_V2 ? E2_PROMPT_V2 : E2_PROMPT_V1;
const ONLY = process.env.CASE_ONLY ? process.env.CASE_ONLY.split(",") : null;
const CASE_DIR = "spikes/cases/e2";
const IMG_DIR = `${CASE_DIR}/img`;
const OUT = "spikes/paperwork/results/e2.json";

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
const overlap = (a, b) => {
  const A = new Set(norm(a).split(" ")), B = new Set(norm(b).split(" "));
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size, 1);
};

const SCALARS = ["invoice_quantity", "invoice_unit", "units_per_pack", "unit_cost_minor", "currency"];

function scoreCase(c, lines) {
  const fails = [];
  const exp = c.expected;
  const missed = [], extra = [...lines.keys()];
  const aligned = [];
  for (const e of exp.lines) {
    let best = -1, bestScore = 0;
    for (const i of extra) {
      const s = overlap(e.description, lines[i].description);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best < 0 || bestScore < 0.25) { missed.push(e.description); continue; }
    extra.splice(extra.indexOf(best), 1);
    aligned.push([e, lines[best]]);
  }
  if (missed.length || extra.length || lines.length !== exp.line_count) {
    fails.push(`line_count got ${lines.length}, want ${exp.line_count}; missed [${missed}]; extra idx [${extra}]`);
  }
  const fieldFails = [];
  for (const [e, g] of aligned) {
    const ne = norm(e.description), ng = norm(g.description);
    if (!(ng.includes(ne) || ne.includes(ng))) fieldFails.push(`description "${g.description}" !~ "${e.description}"`);
    for (const f of SCALARS) {
      if (JSON.stringify(g[f]) !== JSON.stringify(e[f])) fieldFails.push(`${e.description}: ${f} got ${JSON.stringify(g[f])}, want ${JSON.stringify(e[f])}`);
    }
    const wantAmb = (e.ambiguities ?? []).length > 0, gotAmb = (g.ambiguities ?? []).length > 0;
    if (wantAmb !== gotAmb) fieldFails.push(`${e.description}: ambiguities presence got ${gotAmb}, want ${wantAmb}`);
  }
  fails.push(...fieldFails);
  if (exp.must_not_be_transaction) {
    const bad = lines.filter((l) => l.invoice_quantity !== null);
    if (bad.length) fails.push(`must_not_be_transaction: ${bad.length} line(s) carry invented quantities`);
  }
  const blob = JSON.stringify(lines);
  for (const s of exp.must_not_contain ?? []) {
    if (blob.includes(s)) fails.push(`must_not_contain: ${s} present`);
  }
  return fails;
}

const caseFiles = readdirSync(CASE_DIR).filter((f) => /^E2-\d+\.json$/.test(f)).sort()
  .filter((f) => !ONLY || ONLY.includes(f.replace(".json", "")));
const results = [];
let totIn = 0, totOut = 0;
const lat = [];
for (const f of caseFiles) {
  const c = JSON.parse(readFileSync(`${CASE_DIR}/${f}`, "utf8"));
  const b64 = readFileSync(`${IMG_DIR}/${c.input.file}`).toString("base64");
  const r = await chatJson({
    system: PROMPT,
    userParts: [
      { type: "text", text: "Transcribe the paperwork in this image into extraction lines." },
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
    ],
    schema: E2_SCHEMA,
    schemaName: "e2_extraction",
  });
  const lines = r.data.lines ?? [];
  const fails = scoreCase(c, lines);
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
  experiment: "E2", date: "2026-10-27", model: MODEL, prompt_version: promptNote,
  price_source: PRICE_URL, price_per_m: { input: 1.25, output: 4.25 },
  summary: {
    passed: finalCases.filter((r) => r.pass).length, total: finalCases.length,
    failed_ids: finalCases.filter((r) => !r.pass).map((r) => r.id),
    latency_p50_ms: p50, latency_p95_ms: p95,
    input_tokens: totIn, output_tokens: totOut, cost_usd_list: totalCost,
  },
  cases: finalCases,
}, null, 2));
console.log(`E2: ${finalCases.filter((r) => r.pass).length}/${finalCases.length} pass; cost $${totalCost} list`);
