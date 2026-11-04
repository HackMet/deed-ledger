#!/usr/bin/env node
// The demo runner (K10), called by ./demo.sh. Starts the demo Worker (demo/worker.ts: the real order
// engine, recorded perception) on a fresh local D1, plays six synthetic customers A–F through signed
// fake webhooks and the staff console, checks every step against the records, and exits 0 only if
// every expectation held. Synthetic data and fake secrets only; nothing is sent to WhatsApp.
//
// At the end, the owner's session re-judges the entries of A, D and E (scripts/deed-recheck.mjs): one line,
// and a difference fails the demo.
//
//   ./demo.sh [--json <file>] [--serve]          DEMO_PORT=8790 by default; PERCEPTION=recorded
import { checkVerdicts } from "./verdicts.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, SIM, SIM_SECRETS, simChildEnv, wrangler } from "../scripts/lib/sim.mjs";
import { readbackQuantity, refusedForTheOrder } from "./checks.mjs";

const args = parseArgs(process.argv.slice(2));
const CONFIG = "demo/wrangler.demo.jsonc";
// DEMO_STATE lets the adversary run (scripts/adversary.mjs) keep its own D1; ./demo.sh never sets it.
const STATE = process.env.DEMO_STATE ?? ".wrangler/demo-state";
const ENV_FILE = ".wrangler/demo/demo.env";
const LOG_FILE = ".wrangler/demo/worker.log";
const PORT = Number(process.env.DEMO_PORT ?? 8790);
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = { phone: SIM.ownerPhone, name: "Dueña demo (sintética)" };
const COURIER = { phone: "50400000090", name: "Mario" };
const CUSTOMERS = { A: "50400000011", B: "50400000012", C: "50400000013", D: "50400000014", E: "50400000015", F: "50400000016" };
const REPLY_TIMEOUT_MS = 30_000;
const NOTICE_WAIT_MS = 8_000;
/** The product moreSugar changes: the first order's line L4 (2 of it, then 3). */
const SUGAR = "Azúcar 1 lb";

class NotRealEngine extends Error {}

function stop(code, message) {
  console.error(`demo: ${message}`);
  process.exit(code);
}

// --- Main ---------------------------------------------------------------------------------------

let worker = null;
let recordings = [];
let counts = { fixture: 0, muse: 0 };
let LABEL = "";

/** The scripted text a recording answers, by its name. */
function said(name) {
  const recording = recordings.find((r) => r.name === name);
  if (recording === undefined) stop(1, `no recording named ${name} in demo/recordings`);
  return recording.text;
}

async function main() {
  // --- Perception: recorded only ----------------------------------------------------------------

  if (args.json === true) stop(1, "--json needs a file name");

  const perception = process.env.PERCEPTION ?? "recorded";
  if (perception === "live") stop(2, "PERCEPTION=live is not available: this demo runs recorded perception only (no live Muse call).");
  if (perception !== "recorded") stop(2, `PERCEPTION=${perception} is unknown; use PERCEPTION=recorded or leave it unset.`);

  const recordingFiles = readdirSync("demo/recordings").filter((f) => f.endsWith(".json")).sort();
  recordings = recordingFiles.map((file) => {
    const parsed = JSON.parse(readFileSync(join("demo/recordings", file), "utf8"));
    if (parsed.source !== "fixture" && parsed.source !== "muse") stop(1, `demo/recordings/${file}: source must be "fixture" or "muse"`);
    if (typeof parsed.text !== "string") stop(1, `demo/recordings/${file}: text is required`);
    return parsed;
  });
  counts = { fixture: recordings.filter((r) => r.source === "fixture").length, muse: recordings.filter((r) => r.source === "muse").length };
  LABEL = `PERCEPTION: RECORDED (${counts.fixture} fixture, ${counts.muse} muse) — fixtures until Angel records real Muse outputs. The engine, ledger and console are live code; answers to customer messages are demo templates, notices after a staff tap are the product's.`;
  console.log(LABEL);
  console.log("");

  // --- Setup: fresh state, migrations, seed, Worker ---------------------------------------------

  if (PORT === 8787 || PORT === 8799) stop(2, `DEMO_PORT=${PORT} is taken on this host by something else; pick another (default 8790).`);
  if (!(await portFree(PORT))) stop(1, `port ${PORT} is busy; stop what holds it or set DEMO_PORT.`);

  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(dirname(ENV_FILE), { recursive: true });
  const encoded = Buffer.from(JSON.stringify(recordings), "utf8").toString("base64");
  // Fake simulator secrets only (scripts/lib/sim.mjs), never .dev.vars.
  writeFileSync(ENV_FILE, `${Object.entries({ ...SIM_SECRETS, DEV_CONSOLE: "", DEMO_RECORDINGS: encoded }).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);

  step0("Applying migrations to a fresh local D1", () => wrangler(["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", STATE]));
  step0("Seeding the synthetic store", () => {
    node("scripts/admin-create-store.mjs", ["--name", SIM.storeName, "--phone-number-id", SIM.phoneNumberId, "--owner-phone", OWNER.phone, "--owner-name", OWNER.name, "--persist-to", STATE]);
    seedPeople();
  });

  worker = startWorker();
  let exitCode = 1;
  try {
    await waitUntilUp();
    const cookie = await login();
    const results = await scenario(cookie);
    const differ = await recheckEntries(cookie, ["A", "D", "E"].map((who) => [who, orderOf(CUSTOMERS[who])?.id]));
    exitCode = results.failed === 0 && differ === 0 ? 0 : 1;
    if (args.serve === true) await serve();
  } catch (error) {
    if (error instanceof NotRealEngine) {
      exitCode = 3;
      console.error(`demo: not the real engine: ${error.message}`);
    } else {
      console.error(`demo: ${error.stack ?? error}`);
      console.error(`demo: the Worker's log is in ${LOG_FILE}`);
    }
  } finally {
    stopWorker();
  }
  process.exit(exitCode);
}

// --- The scenario -------------------------------------------------------------------------------

async function scenario(cookie) {
  const steps = [];
  const staff = staffConsole(cookie);
  let eOrderId = null;

  /** Runs one step: measures facts and replies around it and checks its expectation. */
  async function run(customer, message, action, expect) {
    const before = factCounts();
    const outcome = await action();
    const after = factCounts();
    const delta = diff(before, after);
    const verdict = await expect({ ...outcome, delta });
    const result = { customer, message, reply: outcome.reply ?? null, detail: outcome.detail ?? null, before, after, delta, expectation: verdict.expectation, pass: verdict.pass };
    steps.push(result);
    const deltas = Object.entries(delta).map(([k, n]) => `${k} ${n > 0 ? "+" : ""}${n}`).join(", ") || "no facts";
    const reply = result.reply === null ? (result.detail ?? "") : `“${oneLine(result.reply)}”`;
    console.log(`${result.pass ? "✓" : "✗"} ${customer} · ${message} → ${reply} · [${deltas}]${result.pass ? "" : `\n    expected: ${verdict.expectation}`}`);
    return result;
  }

  const customerSays = (who, text, check) => run(who, `says “${oneLine(text)}”`, () => say(CUSTOMERS[who], text), check);
  const expectReply = (pattern, deltas, expectation) => ({ reply, delta }) => ({
    expectation,
    pass: reply !== null && pattern.test(reply) && sameDelta(delta, deltas),
  });
  const placeOrder = (who, recording = "firstOrder") =>
    customerSays(who, said(recording), expectReply(/^Esto entendí de tu pedido:/, { order_version: 1 }, "a readback; one order_version fact"));
  const confirm = (who) =>
    customerSays(who, "confirmar", expectReply(/Quedó confirmado/, { order_confirm: 1 }, "“Quedó confirmado…”; one order_confirm fact"));
  const cancel = (who) => customerSays(who, "cancelar", expectReply(/^Cancelé tu pedido/, { order_cancel: 1 }, "“Cancelé tu pedido.”; one order_cancel fact"));
  const refusedTap = (who, type, version) =>
    run(who, `staff taps ${type} (Preparación)`, () => staff.tap(who, type, version), ({ redirect, delta }) => ({
      // Only a refusal for the order's state or version counts; `aviso=permiso` proves nothing about the order.
      expectation: `${type} refused for the order (aviso=estado or aviso=cambio, not permiso); no fact written`,
      pass: refusedForTheOrder(redirect) && sameDelta(delta, {}),
    }));
  const staffStep = (who, label, action, state, notice) =>
    run(who, `staff ${label}`, action, async (outcome) => {
      const order = orderOf(CUSTOMERS[who]);
      return {
        expectation: `one order_status fact; order ${state}${notice === undefined ? "" : `; ${who} hears ${notice}`}`,
        pass: sameDelta(outcome.delta, { order_status: 1 }) && order?.state === state && (notice === undefined || outcome.heard.some((m) => notice.test(m))),
      };
    });

  // A: a delivery order, prepared, dispatched with a courier and delivered.
  console.log("— A: delivery order, from WhatsApp to delivered");
  await placeOrder("A", "firstDeliveryOrder");
  await confirm("A");
  const proof = query(`SELECT (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM facts WHERE kind = 'order_confirm') AS confirms`)[0];
  if (!(proof?.orders >= 1 && proof?.confirms >= 1)) throw new NotRealEngine(`after A's confirm: ${JSON.stringify(proof)} (orders and order_confirm facts must be ≥ 1)`);
  console.log(`  real engine: ${proof.orders} order(s), ${proof.confirms} order_confirm fact(s) in D1`);
  await staffStep("A", "taps Empezar (start_preparing)", () => staff.tap("A", "start_preparing"), "preparando");
  await staffStep("A", "taps Pedido listo (mark_ready)", () => staff.tap("A", "mark_ready"), "listo", /listo/i);
  await staffStep("A", `dispatches with ${COURIER.name}`, () => staff.step("A", "despachar"), "en_camino", new RegExp(`va en camino con ${COURIER.name}`, "i"));
  await staffStep("A", "taps Entregado (mark_delivered)", () => staff.step("A", "entregar"), "entregado");

  // B: three confirms, one fact.
  console.log("— B: confirms three times");
  await placeOrder("B");
  await confirm("B");
  for (let n = 2; n <= 3; n++) {
    await customerSays("B", "confirmar", expectReply(/ya estaba confirmado/, {}, "“Tu pedido ya estaba confirmado.”; no new fact"));
  }
  const bConfirms = steps.filter((s) => s.customer === "B" && s.message.includes("confirmar")).reduce((n, s) => n + (s.delta.order_confirm ?? 0), 0);
  await run("B", "check: order_confirm facts from B's three confirms", async () => ({ detail: `${bConfirms} order_confirm fact(s)` }), () => ({
    expectation: "exactly one order_confirm fact",
    pass: bConfirms === 1,
  }));

  // C: cancelled after confirming; a stale tap to start it is refused.
  console.log("— C: cancels; staff can't start it");
  await placeOrder("C");
  await confirm("C");
  const cVersion = await staff.version(orderOf(CUSTOMERS.C)?.id);
  await cancel("C");
  await refusedTap("C", "start_preparing", cVersion);

  // D: a change after confirming becomes a request; the owner approves it.
  console.log("— D: change request approved");
  await placeOrder("D");
  await confirm("D");
  await customerSays("D", said("moreSugar"), expectReply(/^Le pasé tu cambio a la tienda\. Queda así si lo aprueban:\n[^]*• 3 Azúcar/, { change_request: 1 }, "a change request (order unchanged); one change_request fact"));
  await run("D", "owner taps Aprobar (“Sí hay, va”)", () => staff.review("D", "approve", "Sí hay, va"), ({ delta, heard }) => ({
    expectation: "change_review +1, order_version +1, order_confirm +1; version 2; D hears “Tu cambio fue aprobado”",
    pass:
      sameDelta(delta, { change_review: 1, order_version: 1, order_confirm: 1 }) &&
      orderOf(CUSTOMERS.D)?.current_version === 2 &&
      heard.some((m) => /Tu cambio fue aprobado/.test(m)),
  }));

  // E: v1, changed before confirming (v2), confirmed, cancelled; a stale tap is refused.
  console.log("— E: v1 → v2 → confirmed → cancelled (the trail in the video)");
  await placeOrder("E");
  await run("E", `says “${said("moreSugar")}”`, () => say(CUSTOMERS.E, said("moreSugar")), ({ reply, delta }) => ({
    // Before confirming, the engine answers a change with a new readback of the new version.
    expectation: `a readback of version 2 with 3 ${SUGAR}; one order_version fact`,
    pass:
      reply !== null &&
      /^Esto entendí de tu pedido:/.test(reply) &&
      readbackQuantity(reply, SUGAR) === "3" &&
      sameDelta(delta, { order_version: 1 }) &&
      orderOf(CUSTOMERS.E)?.current_version === 2,
  }));
  await confirm("E");
  eOrderId = orderOf(CUSTOMERS.E)?.id ?? null;
  const eVersion = await staff.version(eOrderId);
  await cancel("E");
  await refusedTap("E", "mark_ready", eVersion);
  await run("E", "check: trail at /console/pedidos/<E>", async () => {
    const page = await staff.get(`/console/pedidos/${encodeURIComponent(eOrderId)}`);
    return { detail: `trail: ${["reemplazado", "cancelado"].filter((w) => page.includes(w)).join(", ") || "neither label"}`, page };
  }, ({ page }) => ({
    expectation: "the trail shows v1 reemplazado and the confirm cancelado",
    pass: page.includes("reemplazado") && page.includes("cancelado"),
  }));

  // F: a change request the owner declines with a reason.
  console.log("— F: change request declined");
  await placeOrder("F");
  await confirm("F");
  await customerSays("F", said("moreSugar"), expectReply(/^Le pasé tu cambio a la tienda\. Queda así si lo aprueban:\n[^]*• 3 Azúcar/, { change_request: 1 }, "a change request (order unchanged); one change_request fact"));
  await run("F", "owner taps Rechazar (“ya no hay azúcar”)", () => staff.review("F", "decline", "ya no hay azúcar"), ({ delta, heard }) => ({
    expectation: "change_review +1 only; version 1; F hears “No pudimos hacer el cambio: ya no hay azúcar”",
    pass: sameDelta(delta, { change_review: 1 }) && orderOf(CUSTOMERS.F)?.current_version === 1 && heard.some((m) => /No pudimos hacer el cambio: ya no hay azúcar/.test(m)),
  }));

  return summarize(steps, eOrderId);
}

function summarize(steps, eOrderId) {
  const facts = factCounts();
  const orders = query(`SELECT state, count(*) AS n FROM orders GROUP BY state ORDER BY state`);
  const passed = steps.filter((s) => s.pass).length;
  const failed = steps.length - passed;
  console.log("");
  console.log("Summary");
  const table = {};
  for (const s of steps) {
    const row = (table[s.customer] ??= { steps: 0, passed: 0, failed: 0 });
    row.steps++;
    row[s.pass ? "passed" : "failed"]++;
  }
  console.table(table);
  console.log(`Steps: ${steps.length} · passed ${passed} · failed ${failed}`);
  console.log(`Facts by kind: ${Object.entries(facts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`Orders by state: ${orders.map((o) => `${o.state} ${o.n}`).join(", ")}`);
  if (eOrderId !== null) console.log(`E's trail: ${BASE}/console/pedidos/${encodeURIComponent(eOrderId)}`);
  for (const s of steps.filter((x) => !x.pass)) console.log(`✗ ${s.customer} · ${s.message} — expected: ${s.expectation}`);
  console.log(LABEL);
  console.log(failed === 0 ? "RESULT: every expectation held." : `RESULT: ${failed} expectation(s) did not hold.`);
  const results = {
    perception: { mode: "recorded", fixture: counts.fixture, muse: counts.muse, label: LABEL },
    steps: steps.map(({ page: _page, ...s }) => s),
    eOrderId,
    eTrailPath: eOrderId === null ? null : `/console/pedidos/${encodeURIComponent(eOrderId)}`,
    totals: { steps: steps.length, passed, failed, facts, orders: Object.fromEntries(orders.map((o) => [o.state, o.n])) },
  };
  if (typeof args.json === "string") {
    mkdirSync(dirname(args.json), { recursive: true });
    writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`Results written to ${args.json}`);
  }
  return results.totals;
}

// --- Customers: signed fake webhooks and the outbox ---------------------------------------------

/** Sends one text as the customer and waits for the reply the Worker writes to the outbox. */
async function say(phone, text) {
  const seen = lastSeq(phone);
  await postWebhook(phone, text);
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const replies = outboxSince(phone, seen);
    if (replies.length > 0) return { reply: replies.map((r) => r.body_text).join("\n") };
  }
  return { reply: null, detail: `no reply within ${REPLY_TIMEOUT_MS / 1000}s` };
}

/** `content` is a text, or a message body such as `{ type: "interactive", ... }` (the adversary's button taps). */
export async function postWebhook(phone, content, phoneNumberId = SIM.phoneNumberId) {
  const typed = typeof content === "string" ? { type: "text", text: { body: content } } : content;
  const message = { from: phone, id: `wamid.DEMO-${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...typed };
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "900000000000001",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Cliente demo" }, wa_id: phone }],
              messages: [message],
            },
          },
        ],
      },
    ],
  });
  const signature = `sha256=${createHmac("sha256", SIM.appSecret).update(body).digest("hex")}`;
  const response = await fetch(`${BASE}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body });
  if (response.status !== 200) throw new Error(`webhook answered ${response.status}: ${await response.text()}`);
}

const byPhone = (phone) => `o.conversation_id IN (SELECT c.id FROM conversations c JOIN customers u ON u.id = c.customer_id WHERE u.phone = '${phone}')`;
export const lastSeq = (phone) => query(`SELECT coalesce(max(o.seq), 0) AS seq FROM outbound_messages o WHERE ${byPhone(phone)}`)[0]?.seq ?? 0;
export const outboxSince = (phone, seq) => query(`SELECT o.seq, o.body_text FROM outbound_messages o WHERE ${byPhone(phone)} AND o.seq > ${Number(seq)} ORDER BY o.seq`);

/** What the customer was sent after a staff tap: waits a little, since a notice may follow the tap. */
export async function heardSince(phone, seq) {
  await sleep(NOTICE_WAIT_MS);
  return outboxSince(phone, seq).map((r) => r.body_text);
}

export function orderOf(phone) {
  return query(`SELECT o.id, o.state, o.current_version FROM orders o WHERE o.customer_id IN
    (SELECT u.id FROM customers u WHERE u.phone = '${phone}') ORDER BY o.created_at_ms DESC LIMIT 1`)[0];
}

// --- Staff: the console, like a person with a phone ----------------------------------------------

/** Follows the owner's invite link with a cookie jar: GET shows the invite, POST uses it. */
export async function login() {
  const out = node("scripts/admin-invite.mjs", ["--phone-number-id", SIM.phoneNumberId, "--phone", OWNER.phone, "--role", "owner", "--base-url", BASE, "--persist-to", STATE]);
  const link = out.match(/https?:\/\/\S+\/console\/entrar\?codigo=\S+/)?.[0];
  if (link === undefined) throw new Error(`admin-invite printed no link:\n${out}`);
  const shown = await fetch(link, { redirect: "manual" });
  const code = (await shown.text()).match(/name="codigo" value="([^"]+)"/)?.[1];
  if (code === undefined) throw new Error(`the invite page has no form (${shown.status})`);
  const used = await fetch(`${BASE}/console/entrar`, { method: "POST", redirect: "manual", headers: form(), body: new URLSearchParams({ codigo: code }) });
  const cookie = used.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("consola="));
  if (cookie === undefined) throw new Error(`login refused (${used.status})`);
  return cookie;
}

/**
 * The owner's session downloads each order's entry from the running Worker and re-judges it with
 * scripts/deed-recheck.mjs, which needs nothing but the file. Each entry's verdicts must also be the literal ones
 * above, and the published example must recheck with exit 0. Returns how many verdicts differ.
 */
async function recheckEntries(cookie, orders) {
  const dir = join(dirname(ENV_FILE), "entries");
  mkdirSync(dir, { recursive: true });
  let pairs = 0;
  let differ = 0;
  for (const [who, orderId] of orders) {
    if (orderId === undefined || orderId === null) throw new Error(`no order of ${who} to recheck`);
    const response = await fetch(`${BASE}/console/deed/${encodeURIComponent(orderId)}/entrada.json`, { headers: { cookie }, redirect: "manual" });
    if (response.status !== 200) throw new Error(`entrada.json of ${who} answered ${response.status}`);
    const text = await response.text();
    const file = join(dir, `${who}.json`);
    writeFileSync(file, text);
    checkVerdicts(who, JSON.parse(text).verdicts.map((verdict) => verdict.state));
    const result = spawnSyncNode("scripts/deed-recheck.mjs", [file]);
    const counts = result.stdout.match(/^pairs: (\d+), same: \d+, differ: (\d+)/m);
    if (counts === null) throw new Error(`the recheck could not read ${who}'s entry:\n${result.stdout}${result.stderr}`);
    // The exit code is part of the answer too: 1 when a verdict differs, 0 when none does.
    const expected = Number(counts[2]) === 0 ? 0 : 1;
    if (result.status !== expected) throw new Error(`the recheck of ${who}'s entry exited ${result.status} with ${counts[2]} differ, expected ${expected}`);
    if (result.status !== 0) console.log(result.stdout.trimEnd());
    if (who === "A") checkExitCodes(dir, text);
    pairs += Number(counts[1]);
    differ += Number(counts[2]);
  }
  const example = spawnSyncNode("scripts/deed-recheck.mjs", ["docs/deed-entry-example.json"]);
  if (example.status !== 0) throw new Error(`the published example exited ${example.status}, expected 0:\n${example.stdout}${example.stderr}`);
  console.log(`Recheck: ${orders.length} entries, ${pairs} pairs, ${differ} differ`);
  return differ;
}

/** Two copies of A's entry the command must refuse by exit code: one verdict changed (exit 1), and schema 2 (exit 2). */
function checkExitCodes(dir, text) {
  const entry = JSON.parse(text);
  const changed = structuredClone(entry);
  const first = changed.verdicts[0];
  first.state = first.state === "emparejado" ? "sin_pareja" : "emparejado";
  for (const [name, copy, expected] of [
    ["changed", changed, 1],
    ["schema2", { ...entry, schema: 2 }, 2],
  ]) {
    const file = join(dir, `A-${name}.json`);
    writeFileSync(file, JSON.stringify(copy));
    const result = spawnSyncNode("scripts/deed-recheck.mjs", [file]);
    if (result.status !== expected) throw new Error(`the recheck of A's ${name} copy exited ${result.status}, expected ${expected}`);
  }
}

export function staffConsole(cookie) {
  const get = async (path) => {
    const response = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
    if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}`);
    return response.text();
  };
  const post = async (path, fields) => {
    const response = await fetch(`${BASE}${path}`, { method: "POST", redirect: "manual", headers: { ...form(), cookie }, body: new URLSearchParams(fields) });
    return response.status === 303 ? response.headers.get("location") : `${response.status}`;
  };
  const csrfOf = (page) => page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  // Preparación lists cards; each order's buttons are on its own page (#63). Null when the order
  // isn't on the list (its page answers 404).
  const orderPage = async (orderId) => {
    if (orderId === undefined || orderId === null) return null;
    const response = await fetch(`${BASE}/console/preparacion/${encodeURIComponent(orderId)}`, { headers: { cookie }, redirect: "manual" });
    return response.status === 200 ? response.text() : null;
  };
  return {
    get,
    /** A raw console post (the adversary's forged taps); returns the redirect location or the status. */
    post,
    /** The version the order's Preparación page showed, or null if it wasn't on the list. */
    async version(orderId) {
      const version = (await orderPage(orderId))?.match(/name="version" value="(\d+)"/)?.[1];
      return version === undefined ? null : Number(version);
    },
    /** A tap on Preparación: the card's own button if it is on screen, else the tap a stale screen would send. */
    async tap(who, type, staleVersion) {
      const phone = CUSTOMERS[who] ?? who;
      const order = orderOf(phone);
      const card = await orderPage(order?.id);
      const forms = card === null ? [] : [...card.matchAll(/<form[^>]*action="\/console\/acciones">([\s\S]*?)<\/form>/g)].map((m) => m[1]);
      const button = forms.find((f) => f.includes(`name="type" value="${type}"`));
      const field = (html, name) => html?.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1];
      const version = staleVersion ?? Number(field(card ?? "", "version") ?? order?.current_version ?? 1);
      const seq = lastSeq(phone);
      const redirect = await post("/console/acciones", {
        type,
        orderId: order?.id ?? "",
        version: String(version),
        // A stale screen carries the key the engine derived for the version it showed (D-44).
        operationKey: field(button, "operationKey") ?? `staff:${order?.id ?? ""}:${version}:${type}`,
        csrf: csrfOf(card ?? "") || csrfOf(await get("/console/anotar")),
      });
      const onScreen = button === undefined ? "button not on screen" : "button on screen";
      return { redirect, heard: await heardSince(phone, seq), detail: `${onScreen} → ${redirect}` };
    },
    /** A dispatch or delivered tap on the order's Pedidos page. */
    async step(who, paso, courierPhone = COURIER.phone) {
      const phone = CUSTOMERS[who] ?? who;
      const order = orderOf(phone);
      const page = await get(`/console/pedidos/${encodeURIComponent(order.id)}`);
      const formHtml = page.match(new RegExp(`<form[^>]*>(?:(?!</form>)[\\s\\S])*name="paso" value="${paso}"[\\s\\S]*?</form>`))?.[0];
      const version = formHtml?.match(/name="version" value="(\d+)"/)?.[1] ?? String(order.current_version);
      const courier = query(`SELECT u.id FROM users u WHERE u.phone = '${courierPhone}'`)[0]?.id;
      // The session's CSRF value is on every page with a form; a trail with no buttons has none.
      const csrf = csrfOf(page) || csrfOf(await get("/console/anotar"));
      const fields = { csrf, paso, version, ...(paso === "despachar" ? { repartidor: courier } : {}) };
      const seq = lastSeq(phone);
      const redirect = await post(`/console/pedidos/${encodeURIComponent(order.id)}/paso`, fields);
      return { redirect, heard: await heardSince(phone, seq), detail: `${formHtml === undefined ? "form not on screen" : "form on screen"} → ${redirect}` };
    },
    /** The owner answers the open change request on the order's Pedidos page, with a reason. */
    async review(who, decision, motivo) {
      const phone = CUSTOMERS[who] ?? who;
      const order = orderOf(phone);
      const page = await get(`/console/pedidos/${encodeURIComponent(order.id)}`);
      const cambio = page.match(/name="cambio" value="([^"]+)"/)?.[1];
      if (cambio === undefined) return { redirect: null, heard: [], detail: "no open change request on the page" };
      const seq = lastSeq(phone);
      const redirect = await post(`/console/pedidos/${encodeURIComponent(order.id)}/revision`, { csrf: csrfOf(page), cambio, decision, motivo });
      return { redirect, heard: await heardSince(phone, seq), detail: `→ ${redirect}` };
    },
  };
}

const form = () => ({ "content-type": "application/x-www-form-urlencoded", origin: BASE });

// --- Records ----------------------------------------------------------------------------------

export function factCounts() {
  return Object.fromEntries(query(`SELECT kind, count(*) AS n FROM facts GROUP BY kind ORDER BY kind`).map((r) => [r.kind, r.n]));
}

export function diff(before, after) {
  const out = {};
  for (const kind of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const n = (after[kind] ?? 0) - (before[kind] ?? 0);
    if (n !== 0) out[kind] = n;
  }
  return out;
}

/** The deltas are exactly these: no other kind moved. */
export function sameDelta(delta, expected) {
  const kinds = new Set([...Object.keys(delta), ...Object.keys(expected)]);
  return [...kinds].every((k) => (delta[k] ?? 0) === (expected[k] ?? 0));
}

export function query(sql) {
  // The Worker writes the same SQLite file: a busy read waits and tries again, a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      const out = wrangler(["d1", "execute", "DB", "--local", "--config", CONFIG, "--persist-to", STATE, "--json", "--command", sql]);
      return JSON.parse(out)[0]?.results ?? [];
    } catch (error) {
      if (attempt >= 5 || !/SQLITE_BUSY|database is locked/.test(String(error?.message ?? error))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300 * attempt);
    }
  }
}

/** The customers and the courier, as members of the synthetic store: intake processes members only. */
function seedPeople() {
  const now = Date.now();
  const store = `(SELECT business_id FROM channel_accounts WHERE phone_number_id = '${SIM.phoneNumberId}')`;
  const people = [...Object.entries(CUSTOMERS).map(([who, phone]) => ({ phone, name: `Cliente ${who} (sintético)` })), COURIER];
  const statements = people.flatMap(({ phone, name }) => [
    `INSERT INTO users (id, phone, display_name, created_at_ms) VALUES ('${randomUUID()}', '${phone}', '${name}', ${now});`,
    `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms) SELECT ${store}, id, NULL, 'staff', ${now} FROM users WHERE phone = '${phone}';`,
  ]);
  // The catalog products the recordings' matches name (synthetic).
  for (const [id, name] of [["product-arroz-1lb", "Arroz 1 lb"], ["product-jabon-xtra", "Jabón Xtra"], ["product-azucar-1lb", "Azúcar 1 lb"]]) {
    statements.push(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) SELECT '${id}', ${store}, '${name}', ${now};`);
  }
  mkdirSync(".wrangler/tmp", { recursive: true });
  const file = join(".wrangler/tmp", `demo-seed-${randomUUID()}.sql`);
  writeFileSync(file, `${statements.join("\n")}\n`);
  try {
    wrangler(["d1", "execute", "DB", "--local", "--config", CONFIG, "--persist-to", STATE, "--file", file]);
  } finally {
    rmSync(file, { force: true });
  }
}

// --- Processes ----------------------------------------------------------------------------------

function step0(label, fn) {
  process.stdout.write(`${label}… `);
  fn();
  console.log("done");
}

function node(script, scriptArgs) {
  const result = spawnSyncNode(script, scriptArgs);
  if (result.status !== 0) stop(1, `${script} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

function spawnSyncNode(script, scriptArgs) {
  return spawnSync(process.execPath, [script, ...scriptArgs], { env: simChildEnv(), encoding: "utf8" });
}

function startWorker() {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  writeFileSync(LOG_FILE, "");
  console.log(`Starting the demo Worker on ${BASE} (real engine, recorded perception, fake secrets)…`);
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--config", CONFIG, "--env-file", ENV_FILE, "--persist-to", STATE, "--port", String(PORT), "--ip", "127.0.0.1"],
    { env: simChildEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const append = (chunk) => writeFileSync(LOG_FILE, chunk, { flag: "a" });
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return child;
}

function stopWorker() {
  if (worker.exitCode !== null) return;
  try {
    process.kill(-worker.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

async function waitUntilUp() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`the Worker exited (${worker.exitCode}); see ${LOG_FILE}`);
    try {
      await fetch(`${BASE}/console/entrar`, { redirect: "manual" });
      console.log("");
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`the Worker did not answer on ${BASE} within 90s; see ${LOG_FILE}`);
}

async function serve() {
  const out = node("scripts/admin-invite.mjs", ["--phone-number-id", SIM.phoneNumberId, "--phone", OWNER.phone, "--base-url", BASE, "--persist-to", STATE]);
  console.log("");
  console.log("Serving. The owner's console login (one use, 15 minutes):");
  console.log(out.match(/https?:\/\/\S+/)?.[0] ?? out);
  console.log("Press Ctrl-C to stop the Worker.");
  await new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, resolve);
    worker.once("exit", resolve);
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (text) => text.replace(/\s*\n\s*/g, " / ");

// Imported by scripts/adversary.mjs, which uses the helpers above and never runs main().
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
