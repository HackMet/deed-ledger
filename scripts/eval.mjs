#!/usr/bin/env node
// Eval suite: plays the scripted customers in scripts/eval-scenarios.mjs against the local
// simulator and grades each scenario with deterministic assertions
// (scripts/lib/eval-assert.mjs) read from the sim's records and outbox, never from prose.
//
//   npm run eval -- --only E01,E07          run some scenarios
//   npm run eval -- --out <dir>             where transcripts + results.json go
//   npm run eval -- --planner               label this run as the planner path
//   npm run eval -- --judge                 also score language with the Meta Model API
//   npm run eval -- --compare a.json,b.json compare two runs (classic vs planner)
//   npm run eval -- --no-seed               skip seeding the eval store
//
// Default runs never call paid APIs. --judge spends a little (one short call per scenario
// with bot texts only); the simulator itself spends only when started with --ai.
// Reuses scripts/lib/sim.mjs helpers; the customer driver below is eval's own.
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allReport, retriedOnce } from "./lib/eval-report.mjs";
import { mediaMessage, parseArgs, postWebhook, queryLocal, readButtonsJson, SIM, uploadSimMedia } from "./lib/sim.mjs";
import {
  allowedAmountsFor,
  gradeScenario,
  summarize,
} from "./lib/eval-assert.mjs";
import {
  EVAL_CATALOG,
  EVAL_FEE,
  EVAL_HOURS,
  EVAL_NO_HAY,
  EVAL_UNPRICED,
  SCENARIOS,
  evalFullCatalog,
  mediaSteps,
} from "./eval-scenarios.mjs";

const args = parseArgs(process.argv.slice(2));
const url = typeof args.url === "string" ? args.url : `http://127.0.0.1:${SIM.port}`;
const PATH_LABEL = args.planner === true ? "planner" : "classic";
const QUIET_MS = 5_000;
const MAX_WAIT_MS = 45_000;
const POLL_MS = 1_200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function query(statement) {
  for (let attempt = 0; ; attempt++) {
    try {
      return queryLocal(statement);
    } catch (error) {
      if (attempt < 5 && /SQLITE_BUSY|database is locked|internal error/i.test(String(error))) {
        await sleep(500);
        continue;
      }
      throw error;
    }
  }
}

let cachedStore = null;
async function storeId() {
  cachedStore ??= (await query(`SELECT business_id FROM channel_accounts WHERE phone_number_id = ${sql(SIM.phoneNumberId)}`))[0]?.business_id ?? null;
  return cachedStore;
}

async function consolePost(path, fields) {
  // Console actions carry their own operation key: a second try after a dropped socket can't count twice.
  const response = await retriedOnce(() =>
    fetch(`${url}/console${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: url },
      body: new URLSearchParams({ csrf: "dev", ...fields }),
    }),
  );
  // Read to the end, so the connection is free for the next request.
  await response.arrayBuffer();
  return { status: response.status, location: response.headers.get("location") ?? "" };
}

async function seed() {
  const business = await storeId();
  if (!business) throw new Error("the simulator store isn't there: start `npm run dev:sim` first");
  for (const row of await query(`SELECT id FROM store_products WHERE business_id = ${sql(business)}`)) {
    await consolePost("/tienda/quitar", { producto: row.id });
  }
  const lines = evalFullCatalog();
  console.log(`pasting ${lines.length} products…`);
  const saved = await consolePost("/tienda/pegar/guardar", { lista: lines.join("\n") });
  console.log(`products → ${saved.status} ${saved.location}`);
  for (const name of EVAL_UNPRICED) {
    const added = await consolePost("/tienda/agregar", { nombre: name, precio: "", otros: "" });
    console.log(`${name} (no price) → ${added.status}`);
  }
  const products = await query(`SELECT id, name FROM store_products WHERE business_id = ${sql(business)}`);
  for (const name of EVAL_NO_HAY) {
    const product = products.find((p) => p.name === name);
    if (product) console.log(`No hay ${name} → ${(await consolePost("/tienda/hay", { producto: product.id, no_hay: "1" })).status}`);
  }
  const hours = {};
  for (const [day, opens, closes] of EVAL_HOURS) Object.assign(hours, { [`abierto_${day}`]: "1", [`abre_${day}`]: opens, [`cierra_${day}`]: closes });
  console.log(`hours → ${(await consolePost("/tienda/horario", hours)).location}`);
  console.log(`fee → ${(await consolePost("/tienda/envio", { envio: EVAL_FEE })).location}`);
  const count = (await query(`SELECT COUNT(*) AS n FROM store_products WHERE business_id = ${sql(business)}`))[0]?.n;
  console.log(`${count} products in the eval store.`);
}

async function catalogFacts() {
  const business = await storeId();
  const rows = await query(`SELECT id, name, price_centavos, no_hay FROM store_products WHERE business_id = ${sql(business)}`);
  const names = rows.map((r) => r.name);
  const prices = new Map();
  const priceValues = [];
  for (const row of rows) {
    if (row.price_centavos !== null) {
      prices.set(row.id, row.price_centavos);
      priceValues.push(row.price_centavos);
    }
  }
  const settings = await query(`SELECT delivery_fee_centavos FROM store_setup_settings WHERE business_id = ${sql(business)}`);
  const fee = settings[0]?.delivery_fee_centavos ?? null;
  const noHay = new Set(rows.filter((r) => r.no_hay === 1).map((r) => r.name));
  return { names, prices, priceValues, fee, noHay };
}

class Customer {
  constructor(phone) {
    this.phone = phone;
    this.lastSeq = 0;
    this.buttons = [];
    this.seenButtons = [];
    this.log = [];
    this.botTexts = [];
    this.latencies = [];
    this.turns = 0;
    this.sentMessages = 0;
  }

  async start() {
    this.lastSeq = (await this.replies(0)).reduce((max, row) => Math.max(max, row.seq), 0);
  }

  async replies(afterSeq) {
    return query(
      `SELECT o.seq, o.body_text, o.buttons_json, o.kind
       FROM outbound_messages o
       JOIN conversations c ON c.id = o.conversation_id AND c.business_id = o.business_id
       JOIN customers cu ON cu.id = c.customer_id AND cu.business_id = c.business_id
       WHERE cu.phone = ${sql(this.phone)} AND o.seq > ${Number(afterSeq)}
       ORDER BY o.seq`,
    );
  }

  async send(message) {
    // One message ID for both tries: the Worker records a message once, so a retry can't double it.
    const payload = { from: this.phone, id: `wamid.EVAL-${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message };
    const response = await retriedOnce(() => postWebhook(url, payload, { from: this.phone }));
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`the Worker answered ${response.status}`);
  }

  async collect(expectReply = true) {
    const started = Date.now();
    const seen = this.botTexts.length;
    let lastNewAt = expectReply ? null : Date.now();
    const quiet = expectReply ? QUIET_MS : 3_500;
    while (Date.now() - started < MAX_WAIT_MS) {
      await sleep(POLL_MS);
      const rows = await this.replies(this.lastSeq);
      if (rows.length > 0) {
        for (const row of rows) {
          this.lastSeq = Math.max(this.lastSeq, row.seq);
          const { buttons } = readButtonsJson(row.buttons_json);
          if (buttons.length > 0) {
            this.buttons = buttons;
            this.seenButtons.push(...buttons);
          }
          const afterMs = Date.now() - started;
          this.botTexts.push(row.body_text);
          this.latencies.push(afterMs);
          this.log.push({ who: "bot", text: row.body_text, buttons: buttons.map((b) => b.title), afterMs, kind: row.kind });
        }
        lastNewAt = Date.now();
      } else if (lastNewAt !== null && Date.now() - lastNewAt >= quiet) {
        return;
      }
    }
    if (expectReply && this.botTexts.length === seen) this.log.push({ who: "note", text: `(sin respuesta en ${MAX_WAIT_MS / 1000} s)` });
  }

  async say(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    for (const [i, text] of list.entries()) {
      this.log.push({ who: "customer", text });
      await this.send({ type: "text", text: { body: text } });
      this.sentMessages += 1;
      if (i < list.length - 1) await sleep(800);
    }
    this.turns += 1;
    await this.collect();
  }

  async media(path, caption) {
    const uploaded = await uploadSimMedia(url, path);
    this.log.push({ who: "customer", text: `[${uploaded.type.startsWith("audio/") ? "nota de voz" : "foto"}: ${path.split("/").at(-1)}]${caption ? ` ${caption}` : ""}` });
    await this.send(mediaMessage(uploaded, caption));
    this.sentMessages += 1;
    this.turns += 1;
    await this.collect();
  }

  async tap(title) {
    const button = this.buttons.find((b) => b.title.toLowerCase().startsWith(String(title).toLowerCase()));
    if (!button) {
      this.log.push({ who: "note", text: `(no hay botón «${title}»; botones: ${this.buttons.map((b) => b.title).join(", ") || "ninguno"})` });
      return;
    }
    this.log.push({ who: "customer", text: `[toca ${button.title}]` });
    await this.send({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: button.id, title: button.title } } });
    await this.collect();
  }

  /** Re-sends the first button id seen with this title: a tap on an old readback. */
  async tapStale(title, snapshot) {
    const button = this.seenButtons.find((b) => b.title.toLowerCase().startsWith(String(title).toLowerCase()));
    if (!button) {
      this.log.push({ who: "note", text: `(no hay botón viejo «${title}» para retocar)` });
      return;
    }
    snapshot.before = await latestOrder(this.phone);
    this.log.push({ who: "customer", text: `[retoca ${button.title} viejo]` });
    await this.send({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: button.id, title: button.title } } });
    await this.collect();
    snapshot.after = await latestOrder(this.phone);
  }

  async staff(step) {
    const order = await latestOrder(this.phone);
    if (order === null) {
      this.log.push({ who: "note", text: `(la tienda no encontró pedido para ${step.do})` });
      return;
    }
    const fields = { type: step.do === "no_hay" ? "mark_line" : step.do, orderId: order.orderId, version: String(order.version), operationKey: `eval-${randomUUID()}` };
    let label = { start_preparing: "Preparando", mark_ready: "Listo", mark_delivered: "Entregado" }[step.do] ?? step.do;
    if (step.do === "no_hay") {
      const words = step.line.toLowerCase();
      const line = order.lines.find((l) => `${l.productName ?? ""} ${l.text}`.toLowerCase().includes(words));
      if (!line) {
        this.log.push({ who: "note", text: `(la tienda no encontró la línea «${step.line}»)` });
        return;
      }
      Object.assign(fields, { lineId: line.lineId, mark: "no_hay" });
      label = `No hay: ${line.productName ?? line.text}`;
    }
    const response = await consolePost("/acciones", fields);
    this.log.push({ who: "store", text: `[la tienda toca ${label}] → ${response.status}` });
    await this.collect(false);
  }

  async ownerReply(text) {
    const business = await storeId();
    const item = (await query(
      `SELECT p.id FROM conversation_pendientes p JOIN conversations c ON c.id = p.conversation_id AND c.business_id = p.business_id JOIN customers cu ON cu.id = c.customer_id AND cu.business_id = c.business_id
       WHERE p.business_id = ${sql(business)} AND cu.phone = ${sql(this.phone)} AND p.done_at_ms IS NULL ORDER BY p.raised_at_ms LIMIT 1`,
    ))[0];
    if (!item) {
      this.log.push({ who: "note", text: "(no había pendiente de este cliente para responder)" });
      return;
    }
    const response = await consolePost("/pendientes/responder", { pendiente: item.id, respuesta: text });
    this.log.push({ who: "store", text: `[Johan responde desde Pendientes: «${text}»] → ${response.status}` });
    await this.collect();
  }
}

/**
 * The order shape two bot turns are compared by: a repeated question only
 * fails when the shape is identical at both turns, and a new single-product
 * question is excused when the shape moved (the customer added something).
 */
function orderSignature(order) {
  if (order === null || order === undefined) return null;
  return JSON.stringify({
    version: order.version,
    state: order.state,
    total: order.total,
    lines: (order.lines ?? []).map((l) => [l.productId, l.productName, l.text, l.quantity, l.unitPrice]),
  });
}

async function latestOrder(phone) {
  const business = await storeId();
  const customer = (await query(`SELECT id FROM customers WHERE business_id = ${sql(business)} AND phone = ${sql(phone)}`))[0];
  const state = (await query(`SELECT state_json FROM pretend_engine_state WHERE business_id = ${sql(business)}`))[0];
  if (!customer || !state) return null;
  const orders = JSON.parse(state.state_json).orders.map(([, stored]) => stored).filter((stored) => stored.customerId === customer.id);
  return orders.at(-1)?.order ?? null;
}

async function pendientesOf(phone) {
  const business = await storeId();
  try {
    return await query(
      `SELECT p.kind, p.done_at_ms FROM conversation_pendientes p JOIN conversations c ON c.id = p.conversation_id AND c.business_id = p.business_id JOIN customers cu ON cu.id = c.customer_id AND cu.business_id = c.business_id
       WHERE p.business_id = ${sql(business)} AND cu.phone = ${sql(phone)}`,
    );
  } catch {
    return [];
  }
}

const randomPhone = () => `5049${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;

async function run(scenario, phones, facts) {
  const phone = scenario.sameCustomerAs ? phones.get(scenario.sameCustomerAs) ?? randomPhone() : randomPhone();
  phones.set(scenario.id, phone);
  const customer = new Customer(phone);
  await customer.start();
  const stale = {};
  let turnsToConfirm = null;
  const botTurns = [];
  const signatures = [];
  const orderSnapshots = [];
  let runnerError = null;
  for (const [stepIndex, step] of scenario.steps.entries()) {
    const seen = customer.botTexts.length;
    try {
      if (step.say !== undefined) await customer.say(step.say);
      else if (step.tap !== undefined) await customer.tap(step.tap);
      else if (step.tapStale !== undefined) await customer.tapStale(step.tapStale, stale);
      else if (step.photo !== undefined) await customer.media(step.photo, step.caption);
      else if (step.voice !== undefined) await customer.media(step.voice);
      else if (step.staff !== undefined) await customer.staff(step.staff);
      else if (step.ownerReply !== undefined) await customer.ownerReply(step.ownerReply);
      else if (step.wait !== undefined) await sleep(step.wait * 1000);
    } catch (error) {
      // The transcript so far is kept, with the step that failed and why.
      runnerError = `step ${stepIndex + 1} (${JSON.stringify(step)}): ${error}`;
      customer.log.push({ who: "note", text: `(runner error at ${runnerError})` });
      break;
    }
    const order = await latestOrder(phone);
    orderSnapshots.push(order);
    signatures.push(orderSignature(order));
    const fresh = customer.botTexts.slice(seen);
    if (fresh.length > 0) botTurns.push({ stepIndex, texts: fresh });
    if (turnsToConfirm === null && (step.say !== undefined || step.photo !== undefined || step.voice !== undefined || step.tap !== undefined)) {
      if (order?.state === "confirmado") turnsToConfirm = customer.turns;
    }
  }
  const order = await latestOrder(phone);
  const pendientes = await pendientesOf(phone);
  // Money is backed by the records as they were when the bot said it: an
  // amount the final order no longer shows (E16's L 195 before the unpriced
  // pan landed) was still honestly backed by its contemporary snapshot.
  const allowedAmounts = new Set();
  for (const snapshot of [...orderSnapshots, order]) {
    for (const amount of allowedAmountsFor({ order: snapshot, catalogPrices: facts.priceValues, feeCentavos: facts.fee })) {
      allowedAmounts.add(amount);
    }
  }
  const verdict = gradeScenario({
    expect: scenario.expect,
    order,
    pendientes,
    botTexts: customer.botTexts,
    catalogNames: facts.names,
    allowedAmounts,
    customerTurns: customer.turns,
    staleBefore: stale.before ?? null,
    staleAfter: stale.after ?? null,
    catalogPrices: facts.prices,
    botTurns: botTurns.flatMap((slice) => slice.texts.map((text) => ({ stepIndex: slice.stepIndex, text }))),
    signatureAt: (stepIndex) => signatures[stepIndex] ?? null,
  });
  return {
    id: scenario.id,
    title: scenario.title,
    phone,
    log: customer.log,
    botTexts: customer.botTexts,
    latencies: customer.latencies,
    order,
    pendientes,
    turns: customer.turns,
    turnsToConfirm,
    sentMessages: customer.sentMessages,
    ...verdict,
    ...(runnerError === null ? {} : { pass: false, problems: [`runner error at ${runnerError}`, ...verdict.problems] }),
  };
}

// --- Optional AI judge: language only. Never decides pass/fail. ---

function modelKey() {
  if ((process.env.MODEL_API_KEY ?? "") !== "") return process.env.MODEL_API_KEY;
  const path = typeof args.vars === "string" ? args.vars : ".dev.vars";
  if (!existsSync(path)) return null;
  const line = readFileSync(path, "utf8").split("\n").find((row) => row.startsWith("MODEL_API_KEY="));
  const value = line?.slice("MODEL_API_KEY=".length).trim().replace(/^["']|["']$/g, "") ?? "";
  return value === "" ? null : value;
}

async function judgeLanguage(botTexts) {
  const key = modelKey();
  if (key === null) throw new Error("--judge needs MODEL_API_KEY: set it or pass --vars <path to .dev.vars>");
  const response = await fetch("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "muse-spark-1.3",
      messages: [
        {
          role: "system",
          content:
            "You score WhatsApp replies from a small Honduran store assistant. Score LANGUAGE only: short messages, warm Honduran Spanish with vos (decime, queres, mandame), never blames the customer, never says it did not understand or tells the customer to use buttons. Ignore facts, prices and whether the order is right. Reply with JSON only: {\"score\": 0-10, \"issues\": [\"short quote or note\"]}.",
        },
        { role: "user", content: botTexts.map((t, i) => `[${i + 1}] ${t}`).join("\n") },
      ],
      max_tokens: 400,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`the judge call failed (${response.status})`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return { score: null, issues: ["judge answer was not JSON"], raw: text.slice(0, 200) };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return { score: typeof parsed.score === "number" ? parsed.score : null, issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 5) : [] };
  } catch {
    return { score: null, issues: ["judge answer was not JSON"], raw: text.slice(0, 200) };
  }
}

function transcript(result, scenario) {
  const out = [`## ${scenario.id} · ${scenario.title}`, "", `_${scenario.persona}_`, "", "```"];
  for (const entry of result.log) {
    if (entry.who === "customer") out.push(`Cliente: ${entry.text}`);
    else if (entry.who === "store") out.push(`         ${entry.text}`);
    else if (entry.who === "note") out.push(`         ${entry.text}`);
    else {
      const [first, ...rest] = String(entry.text).split("\n");
      out.push(`Tienda:  ${first}   (${(entry.afterMs / 1000).toFixed(1)} s)`);
      for (const line of rest) out.push(`         ${line}`);
      if (entry.buttons.length > 0) out.push(`         ${entry.buttons.map((t, i) => `[${i + 1}] ${t}`).join("   ")}`);
    }
  }
  out.push("```", "");
  out.push(`**Grade:** ${result.pass ? "PASS" : "FAIL"}${result.truthFail ? " · TRUTH FAILURE" : ""}`, "");
  for (const problem of [...result.truthProblems, ...result.problems]) out.push(`- ${problem}`);
  if (result.problems.length + result.truthProblems.length > 0) out.push("");
  if (result.order) {
    out.push(`**Final order:** ${result.order.state}, version ${result.order.version}, total ${result.order.total === null ? "none" : `L ${(result.order.total / 100).toFixed(2)}`}, ${result.order.lines.length} lines`, "");
  } else {
    out.push("**Final order:** none", "");
  }
  return out.join("\n");
}

function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function printReport(results, summary) {
  for (const result of results) {
    const mark = result.pass ? "PASS" : result.truthFail ? "FAIL (truth)" : "FAIL";
    console.log(`${mark} ${result.id} ${result.title} [${result.turns} turns]`);
    for (const problem of [...result.truthProblems, ...result.problems]) console.log(`      - ${problem}`);
  }
  console.log("");
  console.log(`Path: ${PATH_LABEL}`);
  console.log(`Verified completion rate: ${(summary.rate * 100).toFixed(1)}% (${summary.passed}/${summary.total})`);
  if (summary.truthFailIds.length > 0) {
    console.log(`TRUTH FAILURES in: ${summary.truthFailIds.join(", ")} → NOT SHIPPABLE`);
  } else {
    console.log("Truth failures: none");
  }
  console.log(`Median turns to confirm: ${summary.medianTurnsToConfirm ?? "n/a"}`);
  console.log(`Median reply latency: ${summary.medianLatencyMs === null ? "n/a" : `${Math.round(summary.medianLatencyMs)} ms`}`);
}

if (args.compare !== undefined && args.compare !== true) {
  const files = String(args.compare).split(",").filter((v) => v !== "");
  if (files.length < 2) {
    console.error("usage: npm run eval -- --compare <a.json>,<b.json>");
    process.exit(1);
  }
  const [aPath, bPath] = files;
  const [a, b] = files.map((path) => JSON.parse(readFileSync(path, "utf8")));
  const bById = new Map(b.scenarios.map((s) => [s.id, s]));
  console.log(`# Compare: ${a.meta?.path ?? "?"} (${a.meta?.at ?? "?"}) vs ${b.meta?.path ?? "?"} (${b.meta?.at ?? "?"})`);
  console.log("");
  console.log("id | A | B | turns A→B | notes");
  for (const sa of a.scenarios) {
    const sb = bById.get(sa.id);
    if (!sb) {
      console.log(`${sa.id} | ${sa.pass ? "PASS" : "FAIL"} | — | — | only in A`);
      continue;
    }
    const flag = sa.pass === sb.pass ? " " : " *";
    console.log(`${sa.id}${flag} | ${sa.pass ? "PASS" : "FAIL"} | ${sb.pass ? "PASS" : "FAIL"} | ${sa.turns}→${sb.turns} | ${sa.truthFail || sb.truthFail ? "truth! " : ""}${sb.problems.concat(sb.truthProblems).slice(0, 2).join("; ")}`);
  }
  for (const sb of b.scenarios) {
    if (!a.scenarios.some((s) => s.id === sb.id)) console.log(`${sb.id} | — | ${sb.pass ? "PASS" : "FAIL"} | — | only in B`);
  }
  const sum = (r) => `${((r.summary.passed / r.summary.total) * 100).toFixed(1)}% (${r.summary.passed}/${r.summary.total}), truth: ${r.summary.truthFailIds.length === 0 ? "none" : r.summary.truthFailIds.join(",")}, median turns ${r.summary.medianTurnsToConfirm ?? "n/a"}, median latency ${r.summary.medianLatencyMs ?? "n/a"} ms`;
  console.log("");
  console.log(`A: ${sum(a)}`);
  console.log(`B: ${sum(b)}`);
} else if (args.seed === true) {
  await seed();
} else {
  if (args["no-seed"] !== true) await seed();
  const facts = await catalogFacts();
  const only = typeof args.only === "string" ? new Set(args.only.split(",")) : null;
  const chosen = SCENARIOS.filter((s) => only === null || only.has(s.id));
  const outDir = typeof args.out === "string" ? args.out : join(".wrangler", "eval-runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  const phones = new Map();
  const results = [];
  let sentMessages = 0;
  for (const scenario of chosen) {
    const missing = mediaSteps(scenario).filter((media) => !existsSync(media.path));
    if (missing.length > 0) {
      console.log(`SKIP ${scenario.id} ${scenario.title} — file missing: ${missing.map((media) => media.path).join(", ")} (kept out of the numbers)`);
      continue;
    }
    process.stdout.write(`${scenario.id} ${scenario.title}… `);
    const started = Date.now();
    try {
      const result = await run(scenario, phones, facts);
      results.push(result);
      sentMessages += result.sentMessages;
      writeFileSync(join(outDir, `${scenario.id}.md`), transcript(result, scenario));
      if (args.judge === true) {
        try {
          result.language = await judgeLanguage(result.botTexts);
          writeFileSync(join(outDir, `${scenario.id}.md`), `${transcript(result, scenario)}\n**Language (judge, advisory):** ${result.language.score ?? "n/a"}/10 ${(result.language.issues ?? []).join("; ")}\n`);
        } catch (error) {
          result.language = { score: null, issues: [String(error).slice(0, 160)] };
        }
      }
      console.log(`${result.pass ? "PASS" : "FAIL"}${result.truthFail ? " (truth)" : ""} ${((Date.now() - started) / 1000).toFixed(0)} s`);
    } catch (error) {
      console.log(`failed: ${error}`);
      // A runner error still yields a transcribable result: the report writer
      // must never crash on it (E22's fetch failure took down all.md once).
      const failure = {
        id: scenario.id,
        title: scenario.title,
        phone: phones.get(scenario.id) ?? "(none)",
        log: [{ who: "note", text: `(runner error: ${error})` }],
        botTexts: [],
        latencies: [],
        order: null,
        pendientes: [],
        turns: 0,
        turnsToConfirm: null,
        sentMessages: 0,
        pass: false,
        truthFail: false,
        problems: [`runner error: ${error}`],
        truthProblems: [],
      };
      results.push(failure);
      writeFileSync(join(outDir, `${scenario.id}.md`), transcript(failure, scenario));
    }
  }
  const summary = summarize(results);
  const payload = {
    meta: { at: new Date().toISOString(), path: PATH_LABEL, gitSha: gitSha(), url, scenarios: results.length, customerMessages: sentMessages, judge: args.judge === true },
    scenarios: results.map(({ log, botTexts, order, pendientes, ...rest }) => ({ ...rest, state: order?.state ?? null, total: order?.total ?? null })),
    summary,
  };
  writeFileSync(join(outDir, "all.md"), allReport(payload.meta.at, PATH_LABEL, results.map((r) => transcript(r, chosen.find((s) => s.id === r.id)))));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  console.log("");
  printReport(results, summary);
  console.log(`\nTranscripts: ${outDir}/all.md · JSON: ${outDir}/results.json`);
  console.log(`Customer messages sent: ${sentMessages}`);
}
