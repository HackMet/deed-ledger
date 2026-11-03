#!/usr/bin/env node
// Chat with the local Worker (`npm run dev:sim`) as a WhatsApp customer. Each line you type is sent
// as a signed webhook; the bot's replies are read back from the outbox and printed. When the last
// reply has buttons, typing 1, 2 or 3 taps that button. Synthetic data only; nothing reaches WhatsApp.
//
//   npm run chat                              a new customer each run
//   npm run chat -- --phone 50499990002       talk as that customer again
//
// Commands: /q quit · /new start over as a new customer · /sweep run the minute cron once · /help
//           /foto <file> [caption] send a photo · /audio <file.ogg> send a voice note (synthetic files
//           only; scripts/sim-media has some) · "a | b | c" sends three messages in a row
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { mediaMessage, parseArgs, postWebhook, queryLocal, SIM, simChildEnv, uploadSimMedia } from "./lib/sim.mjs";

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

/** The same read as `repliesSince`, in a child process that doesn't block typing. Null on a lost race. */
async function repliesSinceAsync(afterSeq) {
  const { execFile } = await import("node:child_process");
  const sql = repliesSql(afterSeq);
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", SIM.persistTo, "--json", "--command", sql],
      // A read stuck behind a lock is dropped after 10 s; the next poll tries again.
      { env: simChildEnv(), maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          resolve(JSON.parse(stdout)[0]?.results ?? []);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function repliesSql(afterSeq) {
  return `SELECT o.seq, o.body_text, o.buttons_json
     FROM outbound_messages o
     JOIN conversations c ON c.id = o.conversation_id AND c.business_id = o.business_id
     JOIN customers cu ON cu.id = c.customer_id AND cu.business_id = c.business_id
     WHERE cu.phone = '${phone}' AND o.seq > ${Number(afterSeq)}
     ORDER BY o.seq`;
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
    const rows = await repliesSinceAsync(lastSeq);
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
  console.log(`Escribí como en WhatsApp. 1, 2 o 3 tocan un botón. "a | b" manda varios seguidos. /foto, /audio, /new, /sweep, /q.${color.off}`);
  console.log();
}

lastSeq = (repliesSince(0) ?? []).reduce((max, row) => Math.max(max, row.seq), 0);
intro();
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[32mVos:\x1b[0m " });
rl.prompt();
// While you're idle, messages that arrive on their own (the store's answer, "ya está listo") still show.
// The read runs in a child process without blocking, so typing never freezes.
let busy = false;
let polling = false;
setInterval(async () => {
  if (busy || polling) return;
  polling = true;
  try {
    const rows = await repliesSinceAsync(lastSeq);
    if (busy || rows === null || rows.length === 0) return;
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
    rl.prompt(true);
  } catch {
    // A read that lost a race with the Worker: the next one tries again.
  } finally {
    polling = false;
  }
}, 1_500).unref();
// Line by line, each sent at once (several in a row arrive as one burst, as on a phone).
for await (const raw of rl) {
  const line = raw.trim();
  if (line === "/q") break;
  // Each line goes out at once, like on a phone; replies print whenever they arrive.
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
  const media = /^\/(foto|audio)\s+(\S+)(?:\s+(.+))?$/u.exec(line);
  if (media !== null) {
    try {
      const uploaded = await uploadSimMedia(url, media[2]);
      console.log(`${color.dim}  (mandaste ${media[1] === "foto" ? "una foto" : "una nota de voz"})${color.off}`);
      await send(mediaMessage(uploaded, media[3]));
    } catch (error) {
      console.log(`${color.warn}  (${error instanceof Error ? error.message : error})${color.off}`);
    }
    return;
  }
  if (line === "/sweep") {
    const sweep = await fetch(`${url}/cdn-cgi/local/scheduled?cron=*+*+*+*+*`).catch(() => null);
    console.log(`${color.dim}  cron → ${sweep?.status ?? "sin respuesta"}${color.off}`);
    await printReplies();
    return;
  }
  // "a | b | c": several messages sent a moment apart, as fast as a customer types them on a phone.
  if (line.includes(" | ")) {
    const parts = line.split(" | ").map((part) => part.trim()).filter((part) => part !== "");
    let sentAll = true;
    for (const [i, part] of parts.entries()) {
      sentAll = (await send({ type: "text", text: { body: part } })) && sentAll;
      if (i < parts.length - 1) await new Promise((resolve) => setTimeout(resolve, 700));
    }
    console.log(`${color.dim}  (mandaste ${parts.length} mensajes seguidos)${color.off}`);
    void sentAll;
    return;
  }
  const tap = /^[1-3]$/.test(line) ? buttons[Number(line) - 1] : undefined;
  const sent = tap === undefined
    ? await send({ type: "text", text: { body: line } })
    : await send({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: tap.id, title: tap.title } } });
  if (tap !== undefined) console.log(`${color.dim}  (tocaste ${tap.title})${color.off}`);
  void sent;
}
