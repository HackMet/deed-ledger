#!/usr/bin/env node
/**
 * Records docs/assets/deed-demo.gif: one visit to the public demo, as a visitor would make it. It opens a fresh
 * synthetic store, orders on the customer phone, works the order on the console and ends on Deed live. The models
 * and the engine are the real ones, so a run spends a few cents of the demo's daily pool. The GIF is a sequence of
 * real screenshots with captions; the waits are cut.
 *
 *   node scripts/record-demo-gif.mjs [--base https://store-assistant.atiendeme.workers.dev]    # needs google-chrome and ffmpeg
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));
const at = process.argv.indexOf("--base");
const BASE = at === -1 ? "https://store-assistant.atiendeme.workers.dev" : process.argv[at + 1];
const OUT = "docs/assets/deed-demo.gif";
const DEBUG_PORT = 9336;
// Not a seeded customer's name (DEMO_HISTORY), so the recording opens the order it just placed.
const CUSTOMER_NAME = "Sofia";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const work = mkdtempSync(join(tmpdir(), "deed-gif-"));
const chrome = spawn(
  "google-chrome",
  ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(work, "chrome")}`, "about:blank"],
  { stdio: "ignore" },
);

let tabs;
for (let attempt = 0; attempt < 60 && tabs === undefined; attempt++) {
  await sleep(1_000);
  try {
    tabs = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
  } catch {
    // Chrome is still starting.
  }
}
const socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
await new Promise((resolve) => (socket.onopen = resolve));
let lastId = 0;
const waiting = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && waiting.has(message.id)) {
    waiting.get(message.id)(message.result);
    waiting.delete(message.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++lastId;
    waiting.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 810, deviceScaleFactor: 1, mobile: false });

const stills = [];
/** One real screenshot of the page, or of `clip`, with what it shows. */
async function still(caption, seconds, clip) {
  const shot = await send("Page.captureScreenshot", { format: "png", ...(clip === undefined ? {} : { clip: { ...clip, scale: 1 } }) });
  const file = join(work, `still-${String(stills.length).padStart(2, "0")}.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  stills.push({ file, caption, seconds });
}
/** Where an element inside the console frame is on the page. */
const inConsole = (selector) =>
  evaluate(`(() => { const f = document.querySelector('iframe[name="consola"]').getBoundingClientRect(); const r = ${CONSOLE}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(f.x + r.x), y: Math.round(f.y + r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);

const PHONE = `document.querySelector('iframe[name="telefono"]').contentDocument`;
const CONSOLE = `document.querySelector('iframe[name="consola"]').contentDocument`;

/** The phone's chat, or "" for the moment its frame is reloading. */
const chatText = async () => (await evaluate(`${PHONE}?.getElementById("chat")?.innerText`)) ?? "";
/** Waits for the assistant to answer, then a little more in case it sends a second message. */
async function answerAfter(before) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const now = await chatText();
    if (now !== "" && now !== before && !/escribiendo|typing/i.test(now.slice(-40))) {
      await sleep(3_500);
      return chatText();
    }
  }
  throw new Error(`no answer. The chat ends: ${before.slice(-300)}`);
}
async function type(text) {
  const before = await chatText();
  await evaluate(`(() => { const i = ${PHONE}.getElementById("text"); i.value = ${JSON.stringify(text)}; })()`);
  await sleep(1_400);
  await evaluate(`${PHONE}.getElementById("send").requestSubmit()`);
  return answerAfter(before);
}
async function tapButton(word) {
  const before = await chatText();
  const tapped = await evaluate(`(() => { const b = [...${PHONE}.querySelectorAll("#chat button")].reverse().find((x) => ${JSON.stringify(word)} === x.textContent.trim().toLowerCase()); if (!b) return false; b.click(); return true; })()`);
  return tapped ? answerAfter(before) : null;
}
const consoleGo = async (path) => {
  await evaluate(`document.querySelector('iframe[name="consola"]').src = ${JSON.stringify(path)}`);
  await sleep(2_500);
};
/** Clicks what a person would click on the console, by its words. */
async function consoleClick(pattern) {
  const clicked = await evaluate(`(() => { const e = [...${CONSOLE}.querySelectorAll("button,a")].find((x) => ${pattern}.test(x.textContent.trim())); if (!e) return null; const t = e.textContent.trim(); e.click(); return t; })()`);
  await sleep(2_500);
  return clicked;
}

let failure = null;
try {
  await send("Page.navigate", { url: `${BASE}/demo` });
  await sleep(3_000);
  await still("Anyone can try it: one click opens a synthetic store", 2.5);
  await evaluate(`document.querySelector("button.btn").click()`);
  await sleep(4_000);
  await still("The customer's phone on the left, the store's console on the right", 2.5);

  const before = await chatText();
  await evaluate(`${PHONE}.querySelector('[data-preset="texto"]').click()`);
  await sleep(1_200);
  await still("A customer orders in a chat message", 2);
  let chat = await answerAfter(before);
  await evaluate(`(() => { const c = ${PHONE}.getElementById("chat"); c.scrollTop = c.scrollHeight; })()`);
  await sleep(300);
  await still("Muse Spark reads it; the agent reads back every line and the total", 4);
  for (let turn = 0; turn < 8; turn++) {
    const tail = chat.slice(-220);
    if (/your order is in|quedó confirmado|en la lista|on the list/i.test(tail)) break;
    if (/tu nombre|a nombre|cómo te llam|your name|what name|whose order/i.test(tail)) chat = await type(CUSTOMER_NAME);
    else if (/retir|entreg|pickup|deliver|recog|llev/i.test(tail) && !/confirmar|confirm/i.test(tail)) chat = await type("lo paso a traer");
    else chat = (await tapButton("confirmar")) ?? (await tapButton("confirm")) ?? (await type("confirmar"));
  }
  await sleep(6_000);
  await still("Confirmed: the order reaches the store's console", 3.5);

  await consoleClick(/^Orders$|^Pedidos$/);
  await consoleClick(new RegExp(CUSTOMER_NAME));
  await consoleClick(/^(Start preparing|Empezar a preparar)$/);
  await still("Staff prepare it on their phone", 2.5);
  await consoleClick(/^(Ready|Listo)$/);
  await sleep(9_000);
  await evaluate(`(() => { const c = ${PHONE}.getElementById("chat"); c.scrollTop = c.scrollHeight; })()`);
  await sleep(300);
  await still("The customer hears it's ready only after staff tap Ready", 4);

  await consoleClick(/^(Deed live|Deed en vivo)$/);
  await sleep(2_000);
  await evaluate(`${CONSOLE}.querySelector(".graph-box").scrollIntoView({ block: "center" })`);
  await sleep(500);
  await still("Deed live: each fact, who claimed it and who backs it", 3);
  await still("A fact counts only when a witness the agent doesn't control backs it", 6, await inConsole(".graph-box"));
} catch (error) {
  failure = error;
} finally {
  socket.close();
  chrome.kill();
}
if (failure !== null) {
  console.error(`Stopped: ${failure.message}\nStills in ${work}`);
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const WIDTH = 960;
const IMAGE_HEIGHT = 540;
const clips = stills.map((one, index) => {
  const captionFile = join(work, `caption-${index}.txt`);
  writeFileSync(captionFile, one.caption);
  const clip = join(work, `clip-${index}.png`);
  const style = `scale=${WIDTH}:${IMAGE_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${WIDTH}:${IMAGE_HEIGHT + 56}:(ow-iw)/2:(${IMAGE_HEIGHT}-ih)/2:color=0x0f231b,drawtext=fontfile=${FONT}:textfile=${captionFile}:fontsize=21:fontcolor=white:x=(w-tw)/2:y=${IMAGE_HEIGHT + 16}`;
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", one.file, "-vf", style, clip], { stdio: "inherit" });
  if (made.status !== 0) throw new Error("ffmpeg failed on a still");
  return { clip, seconds: one.seconds };
});
const listFile = join(work, "clips.txt");
writeFileSync(listFile, `${clips.map((c) => `file '${c.clip}'\nduration ${c.seconds}`).join("\n")}\nfile '${clips.at(-1).clip}'\n`);
const filter = "fps=4,split[a][b];[a]palettegen=max_colors=200:stats_mode=full[p];[b][p]paletteuse=dither=none";
const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-filter_complex", filter, "-loop", "0", OUT], { stdio: "inherit" });
if (made.status !== 0) {
  console.error("ffmpeg failed");
  process.exit(1);
}
console.log(`Wrote ${OUT} from ${stills.length} screenshots; stills in ${work}`);
process.exit(0);
