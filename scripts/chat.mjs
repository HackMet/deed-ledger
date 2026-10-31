#!/usr/bin/env node
// Chat with the local Worker (`npm run dev:sim`) as a WhatsApp customer. Each line you type is sent
// as a signed webhook; the bot's replies are read back from the outbox and printed. When the last
// reply has buttons, typing 1, 2 or 3 taps that button. Synthetic data only; nothing reaches WhatsApp.
//
//   npm run chat                              a new customer each run
//   npm run chat -- --phone 50499990002       talk as that customer again
//
// Commands: /q quit · /new start over as a new customer · /sweep run the minute cron once · /help
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs, postWebhook, queryLocal, SIM } from "./lib/sim.mjs";

const args = parseArgs(process.argv.slice(2));
const url = typeof args.url === "string" ? args.url : `http://127.0.0.1:${SIM.port}`;
// Replies land after the burst settles and the queue runs; stop waiting this long after the last one.
const QUIET_MS = 4_000;
const MAX_WAIT_MS = 30_000;
const POLL_MS = 1_000;

const color = { bot: "\x1b[36m", dim: "\x1b[2m", warn: "\x1b[33m", off: "\x1b[0m" };
const randomPhone = () => `5049999${String(Math.floor(Math.random() * 9000) + 1000)}`;

let phone = typeof args.phone === "string" ? args.phone.replace(/^\+/, "") : randomPhone();
let lastSeq = 0;
let buttons = [];

/**
 * This customer's replies after `afterSeq`, oldest first, or null when the read lost a race with
 * the Worker writing the same local database ("database is locked"): the next poll tries again.
 */
function repliesSince(afterSeq) {
  if (!/^\d{6,15}$/.test(phone)) throw new Error("the phone must be 6-15 digits");
  try {
    return readReplies(afterSeq);
  } catch (error) {
    if (/SQLITE_BUSY|database is locked|internal error/i.test(String(error))) return null;
    throw error;
  }
}

function readReplies(afterSeq) {
  return queryLocal(
    `SELECT o.seq, o.body_text, o.buttons_json
     FROM outbound_messages o
     JOIN conversations c ON c.id = o.conversation_id AND c.business_id = o.business_id
     JOIN customers cu ON cu.id = c.customer_id AND cu.business_id = c.business_id
     WHERE cu.phone = '${phone}' AND o.seq > ${Number(afterSeq)}
     ORDER BY o.seq`,
  );
}

async function send(message) {
  const response = await postWebhook(url, { from: phone, id: `wamid.SIM-${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }, { from: phone });
  if (!response.ok) console.log(`${color.warn}  (the Worker answered ${response.status}; is \`npm run dev:sim\` running?)${color.off}`);
  return response.ok;
}

/** Waits for the bot to answer, then prints every new reply as it would look on the phone. */
async function printReplies() {
  const started = Date.now();
  let lastNewAt = null;
  process.stdout.write(`${color.dim}  escribiendo…${color.off}`);
  while (Date.now() - started < MAX_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const rows = repliesSince(lastSeq);
    if (rows === null) continue;
    if (rows.length > 0) {
      process.stdout.write("\r\x1b[K");
      for (const row of rows) {
        lastSeq = Math.max(lastSeq, row.seq);
        console.log(`${color.bot}Tienda:${color.off} ${String(row.body_text).replaceAll("\n", "\n        ")}`);
        const parsed = row.buttons_json === null ? [] : JSON.parse(row.buttons_json);
        if (parsed.length > 0) {
          buttons = parsed;
          console.log(`        ${parsed.map((b, i) => `[${i + 1}] ${b.title}`).join("   ")}`);
        }
      }
      lastNewAt = Date.now();
      process.stdout.write(`${color.dim}  escribiendo…${color.off}`);
    } else if (lastNewAt !== null && Date.now() - lastNewAt >= QUIET_MS) {
      break;
    }
  }
  process.stdout.write("\r\x1b[K");
  if (lastNewAt === null) console.log(`${color.dim}  (sin respuesta todavía; probá /sweep o esperá)${color.off}`);
}

function intro() {
  console.log(`${color.dim}Chateás como el cliente ${phone} con ${SIM.storeName}.`);
  console.log(`Escribí como en WhatsApp. 1, 2 o 3 tocan un botón. /new, /sweep, /q.${color.off}`);
  console.log(`${color.dim}Para que la IA lea pedidos, arrancá el simulador con: npm run dev:sim -- --ai --vars ../hackathon/.dev.vars${color.off}\n`);
}

lastSeq = (repliesSince(0) ?? []).reduce((max, row) => Math.max(max, row.seq), 0);
intro();
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[32mVos:\x1b[0m " });
rl.prompt();
// Line by line, so a piped script (`printf 'Hola\n1\n' | npm run chat`) works like typing.
for await (const raw of rl) {
  const line = raw.trim();
  if (line === "/q") break;
  await handle(line);
  rl.prompt();
}
rl.close();

async function handle(line) {
  if (line === "") return;
  if (line === "/help") {
    intro();
    return;
  }
  if (line === "/new") {
    phone = randomPhone();
    lastSeq = 0;
    buttons = [];
    console.log();
    intro();
    return;
  }
  if (line === "/sweep") {
    const sweep = await fetch(`${url}/cdn-cgi/local/scheduled?cron=*+*+*+*+*`).catch(() => null);
    console.log(`${color.dim}  cron → ${sweep?.status ?? "sin respuesta"}${color.off}`);
    await printReplies();
    return;
  }
  const tap = /^[1-3]$/.test(line) ? buttons[Number(line) - 1] : undefined;
  const sent = tap === undefined
    ? await send({ type: "text", text: { body: line } })
    : await send({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: tap.id, title: tap.title } } });
  if (tap !== undefined) console.log(`${color.dim}  (tocaste ${tap.title})${color.off}`);
  if (sent) await printReplies();
}
