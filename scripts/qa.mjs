#!/usr/bin/env node
// Conversation QA: plays scripted customers (scripts/qa-scenarios.mjs) against the local Worker
// (`npm run dev:sim -- --ai --store`), including the store's taps in the console, and writes each
// conversation as it would look on the phone. Synthetic data only; nothing reaches WhatsApp.
//
//   npm run qa -- --seed                 load the QA store: products, hours, delivery fee
//   npm run qa                           run every scenario
//   npm run qa -- --only S03,S07         run some
//   npm run qa -- --out <dir>            where transcripts go (default .wrangler/qa-runs/<time>)
//
// With --ai each customer message costs about US$0.01 of Meta credits (inside the daily cap).
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mediaMessage, parseArgs, postWebhook, queryLocal, SIM, uploadSimMedia } from "./lib/sim.mjs";
import { QA_CATALOG, QA_FEE, QA_HOURS, QA_NO_HAY, QA_UNPRICED, SCENARIOS } from "./qa-scenarios.mjs";

const args = parseArgs(process.argv.slice(2));
const url = typeof args.url === "string" ? args.url : `http://127.0.0.1:${SIM.port}`;
const QUIET_MS = 5_000;
const MAX_WAIT_MS = 45_000;
const POLL_MS = 1_200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** Reads that lost a race with the Worker writing the same local database are retried. */
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

/** A console form post, as the dev console takes it (no login; the fixed dev CSRF value). */
async function consolePost(path, fields) {
  const body = new URLSearchParams({ csrf: "dev", ...fields });
  const response = await fetch(`${url}/console${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: url },
    body,
  });
  return { status: response.status, location: response.headers.get("location") ?? "" };
}

// --- Seeding the QA store through the console, the way the owner would.

async function seed() {
  const business = await storeId();
  if (!business) throw new Error("the simulator store isn't there: start `npm run dev:sim` first");
  for (const row of await query(`SELECT id FROM store_products WHERE business_id = ${sql(business)}`)) {
    await consolePost("/tienda/quitar", { producto: row.id });
  }
  const saved = await consolePost("/tienda/pegar/guardar", { lista: QA_CATALOG.join("\n") });
  console.log(`products → ${saved.status} ${saved.location}`);
  for (const name of QA_UNPRICED) {
    const added = await consolePost("/tienda/agregar", { nombre: name, precio: "", otros: "" });
    console.log(`${name} (no price) → ${added.status} ${added.location}`);
  }
  const products = await query(`SELECT id, name FROM store_products WHERE business_id = ${sql(business)}`);
  for (const name of QA_NO_HAY) {
    const product = products.find((p) => p.name === name);
    if (product) console.log(`No hay ${name} → ${(await consolePost("/tienda/hay", { producto: product.id, no_hay: "1" })).status}`);
  }
  const hours = {};
  for (const [day, opens, closes] of QA_HOURS) Object.assign(hours, { [`abierto_${day}`]: "1", [`abre_${day}`]: opens, [`cierra_${day}`]: closes });
  console.log(`hours → ${(await consolePost("/tienda/horario", hours)).location}`);
  console.log(`fee → ${(await consolePost("/tienda/envio", { envio: QA_FEE })).location}`);
  console.log(`${products.length} products in the QA store.`);
}

// --- One scripted customer.

class Customer {
  constructor(phone) {
    this.phone = phone;
    this.lastSeq = 0;
    this.buttons = [];
    this.log = [];
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
    const response = await postWebhook(url, { from: this.phone, id: `wamid.QA-${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }, { from: this.phone });
    if (!response.ok) throw new Error(`the Worker answered ${response.status}`);
  }

  /** Waits for the bot to finish answering; `expectReply` false waits only a short quiet time. */
  async collect(expectReply = true) {
    const started = Date.now();
    let lastNewAt = expectReply ? null : Date.now();
    const quiet = expectReply ? QUIET_MS : 3_500;
    while (Date.now() - started < MAX_WAIT_MS) {
      await sleep(POLL_MS);
      const rows = await this.replies(this.lastSeq);
      if (rows.length > 0) {
        for (const row of rows) {
          this.lastSeq = Math.max(this.lastSeq, row.seq);
          const buttons = row.buttons_json === null ? [] : JSON.parse(row.buttons_json);
          if (buttons.length > 0) this.buttons = buttons;
          this.log.push({ who: "bot", text: row.body_text, buttons: buttons.map((b) => b.title), afterMs: Date.now() - started, kind: row.kind });
        }
        lastNewAt = Date.now();
      } else if (lastNewAt !== null && Date.now() - lastNewAt >= quiet) {
        return;
      }
    }
    if (expectReply) this.log.push({ who: "note", text: `(sin respuesta en ${MAX_WAIT_MS / 1000} s)` });
  }

  async say(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    for (const [i, text] of list.entries()) {
      this.log.push({ who: "customer", text });
      await this.send({ type: "text", text: { body: text } });
      if (i < list.length - 1) await sleep(800);
    }
    await this.collect();
  }

  /** A photo or voice note from a synthetic file, as WhatsApp would deliver it. */
  async media(path, caption) {
    const uploaded = await uploadSimMedia(url, path);
    this.log.push({ who: "customer", text: `[${uploaded.type.startsWith("audio/") ? "nota de voz" : "foto"}: ${path.split("/").at(-1)}]${caption ? ` ${caption}` : ""}` });
    await this.send(mediaMessage(uploaded, caption));
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

  /** The store's tap on this customer's latest order, through the console. */
  async staff(step) {
    const order = await latestOrder(this.phone);
    if (order === null) {
      this.log.push({ who: "note", text: `(la tienda no encontró pedido para ${step.do})` });
      return;
    }
    const fields = { type: step.do === "no_hay" ? "mark_line" : step.do, orderId: order.orderId, version: String(order.version), operationKey: `qa-${randomUUID()}` };
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
    this.log.push({ who: "store", text: `[la tienda toca ${label}] → ${response.status} ${response.location.replace(/^.*aviso=/, "aviso=") }` });
    await this.collect(false);
  }

  /** The owner answers this customer from Pendientes (the oldest open item of theirs). */
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

async function run(scenario, phones) {
  const phone = scenario.sameCustomerAs ? phones.get(scenario.sameCustomerAs) ?? randomPhone() : randomPhone();
  phones.set(scenario.id, phone);
  const customer = new Customer(phone);
  await customer.start();
  for (const step of scenario.steps) {
    if (step.say !== undefined) await customer.say(step.say);
    else if (step.tap !== undefined) await customer.tap(step.tap);
    else if (step.photo !== undefined) await customer.media(step.photo, step.caption);
    else if (step.voice !== undefined) await customer.media(step.voice);
    else if (step.staff !== undefined) await customer.staff(step.staff);
    else if (step.ownerReply !== undefined) await customer.ownerReply(step.ownerReply);
    else if (step.wait !== undefined) await sleep(step.wait * 1000);
  }
  const order = await latestOrder(phone);
  const pendientes = await pendientesOf(phone);
  return { scenario, phone, log: customer.log, order, pendientes };
}

function transcript({ scenario, log, order, pendientes }) {
  const out = [`## ${scenario.id} · ${scenario.title}`, "", `_${scenario.persona}_`, "", "```"];
  for (const entry of log) {
    if (entry.who === "customer") out.push(`Cliente: ${entry.text}`);
    else if (entry.who === "store") out.push(`         ${entry.text}`);
    else if (entry.who === "note") out.push(`         ${entry.text}`);
    else {
      const [first, ...rest] = String(entry.text).split("\n");
      out.push(`Tienda:  ${first}${entry.afterMs !== undefined ? `   (${(entry.afterMs / 1000).toFixed(1)} s)` : ""}`);
      for (const line of rest) out.push(`         ${line}`);
      if (entry.buttons.length > 0) out.push(`         ${entry.buttons.map((t, i) => `[${i + 1}] ${t}`).join("   ")}`);
    }
  }
  out.push("```", "");
  out.push(`**Esperado:** ${scenario.expect.join(" · ")}`, "");
  if (order) {
    out.push(`**Estado final del pedido:** ${order.state}, versión ${order.version}, total ${order.total === null ? "sin total" : `L ${(order.total / 100).toFixed(2)}`}, ${order.lines.length} líneas` + (order.code ? `, código ${order.code}` : ""), "");
  }
  if (pendientes.length > 0) out.push(`**Pendientes:** ${pendientes.map((p) => `${p.kind}${p.done_at_ms ? " (hecho)" : ""}`).join(", ")}`, "");
  return out.join("\n");
}

if (args.seed === true) {
  await seed();
} else {
  const only = typeof args.only === "string" ? new Set(args.only.split(",")) : null;
  const chosen = SCENARIOS.filter((s) => only === null || only.has(s.id) || (s.sameCustomerAs && only.has(s.sameCustomerAs) && only.has(s.id)));
  const outDir = typeof args.out === "string" ? args.out : join(".wrangler", "qa-runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  const phones = new Map();
  const results = [];
  for (const scenario of chosen) {
    process.stdout.write(`${scenario.id} ${scenario.title}… `);
    const started = Date.now();
    try {
      const result = await run(scenario, phones);
      results.push(result);
      writeFileSync(join(outDir, `${scenario.id}.md`), transcript(result));
      console.log(`${((Date.now() - started) / 1000).toFixed(0)} s`);
    } catch (error) {
      console.log(`failed: ${error}`);
    }
  }
  writeFileSync(join(outDir, "all.md"), [`# Conversation QA run ${new Date().toISOString()}`, "", ...results.map(transcript)].join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results.map(({ scenario, phone, log, order, pendientes }) => ({ id: scenario.id, phone, log, order, pendientes })), null, 2));
  console.log(`\nTranscripts: ${outDir}/all.md`);
}
