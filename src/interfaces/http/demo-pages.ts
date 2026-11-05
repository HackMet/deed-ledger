/**
 * The public demo's pages: the landing page, the split view (customer phone beside the store's
 * console) and the phone itself. The page frame is in English for visitors; everything the store
 * and its customer say stays in Spanish, as in the product.
 */
import { html, raw } from "hono/html";
import type { DemoLimit } from "../../domain/demo";
import { DEMO_MAX_TEXT } from "../../domain/demo";

const STYLE = `
:root{--paper:#f5f3eb;--card:#fffefa;--ink:#213e35;--forest:#203f35;--green:#2a6346;--gold:#f1c45a;--mute:#5c665d;--line:#dedfd3;--page:#e9e8dc;--focus:#c97537;--serif:Georgia,"Times New Roman",serif}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--page);color:var(--ink)}
a{color:var(--green)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
h1{font-family:var(--serif);font-weight:400}
.btn{display:inline-block;min-height:52px;padding:13px 22px;border:0;border-radius:12px;background:var(--forest);color:#fff;font:inherit;font-weight:700;cursor:pointer;text-decoration:none}
`;

function page(title: string, body: unknown, extraStyle = "") {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${raw(STYLE + extraStyle)}</style>
</head>
<body>${body}</body>
</html>`;
}

const LANDING_STYLE = `
main{max-width:640px;margin:0 auto;padding:32px 20px 48px}
h1{font-size:34px;line-height:1.15;margin:8px 0 12px}
.kicker{font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:0}
ol{padding-left:22px}li{margin:6px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 22px;margin:20px 0}
.small{font-size:14px;color:var(--mute)}
.btn.quiet{background:transparent;border:1px solid var(--forest);color:var(--forest)}
`;

/** `/demo`: what the demo is, and one button that opens a store of the visitor's own. */
export function demoLandingPage(hasStore: boolean) {
  return page(
    "Try the store assistant — live demo",
    html`<main>
<p class="kicker">Live demo</p>
<h1>Run a small store with an AI agent</h1>
<p>Customers order by text, a photo of a handwritten list, or a voice note. The agent reads the order with Meta's Muse models,
reads it back with prices, and the customer confirms with a tap. The store works the order from its console, and every step lands in an auditable ledger.</p>
<div class="card">
<p><strong>What you get</strong></p>
<ol>
<li>A made-up mercadito of your own, with products, prices and hours. You're its owner.</li>
<li>A customer's phone beside the store's console. Send an order, then confirm, prepare and deliver it.</li>
<li>Real models, real engine: the same pipeline as WhatsApp. Customer messages are in Honduran Spanish.</li>
</ol>
<form method="post" action="/demo/empezar" onsubmit="this.querySelector('button').disabled = true">
${hasStore ? html`<p><a class="btn" href="/demo/tienda">Back to my demo store</a></p><p class="small">Or start over with a fresh one:</p>` : ""}
<button class="${hasStore ? "btn quiet" : "btn"}">${hasStore ? "Open a fresh demo store" : "Open my demo store"}</button>
</form>
</div>
<p class="small">Nothing here is real: the store, products, prices and customer are made up, and no message goes to WhatsApp.
Your demo store lasts 24 hours. Staff sign in to a real store with a QR code instead; opening a demo store
signs this browser out of a real store's console, so staff should try it in a private window.</p>
</main>`,
    LANDING_STYLE,
  );
}

export function demoLimitedPage(limit: Exclude<DemoLimit, null>, hasStore: boolean) {
  const why =
    limit === "visitor"
      ? "You've opened several demo stores in the last hour. Please use the one you have, or try again later."
      : "A lot of people are trying the demo right now. Please try again in a few minutes.";
  return page("Demo busy", html`<main><h1>One moment</h1><p>${why}</p><p>${
      hasStore ? html`<a class="btn" href="/demo/tienda">Back to my demo store</a>` : html`<a href="/demo">Back</a>`
    }</p></main>`, LANDING_STYLE);
}

const SPLIT_STYLE = `
body{display:flex;flex-direction:column;height:100vh}
.top{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:10px 16px;background:var(--forest);color:#fff;font-size:14px}
.top strong{font-family:var(--serif);font-weight:400;font-size:18px}
.top a{color:var(--gold)}
.top form{display:inline;margin:0}
.top .reset{min-height:36px;padding:6px 14px;border:1px solid var(--gold);border-radius:18px;background:none;color:var(--gold);font:inherit;font-weight:700;cursor:pointer}
.top .right{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.panes{flex:1;display:grid;grid-template-columns:400px 1fr;gap:0;min-height:0}
.pane{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line)}
.pane h2{margin:0;padding:8px 14px;font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:var(--mute);background:var(--paper);border-bottom:1px solid var(--line)}
iframe{flex:1;width:100%;border:0;background:var(--paper)}
.tabs{display:none}
@media (max-width:860px){
 .panes{grid-template-columns:1fr}
 .pane h2{display:none}
 .tabs{display:grid;grid-template-columns:1fr 1fr;background:var(--paper);border-bottom:1px solid var(--line)}
 .tabs button{min-height:48px;border:0;background:none;font:inherit;font-weight:700;color:var(--mute);cursor:pointer}
 .tabs button[aria-selected=true]{color:var(--ink);box-shadow:inset 0 -3px 0 var(--forest)}
 .tabs button.news::after{content:" •";color:#c0392b}
 .pane[hidden]{display:none}
}
`;

/** `/demo/tienda`: the customer's phone on the left, the store's console on the right (tabs on a phone). */
export function demoSplitPage(language: "es" | "en") {
  const say = (es: string, en: string) => html`<span data-es="${es}" data-en="${en}">${language === "en" ? en : es}</span>`;
  return page(
    "Your demo store",
    html`<div class="top"><span><strong>Mercadito Demo</strong> · ${say("demostración en vivo, datos inventados", "live demo, made-up data")}</span>
<span class="right"><span>${say("Pedí como cliente a la izquierda, atendé la tienda a la derecha.", "Order as the customer on the left, run the store on the right.")} <a href="/demo">${say("Acerca de", "About")}</a></span>
<form method="post" action="/demo/empezar" onsubmit="this.querySelector('button').disabled = true"><button class="reset" title="Opens a fresh store with an empty chat and no orders">Empezar de nuevo</button></form></span></div>
<div class="tabs" role="tablist">
<button role="tab" aria-selected="true" data-pane="phone">${say("Teléfono del cliente", "Customer phone")}</button>
<button role="tab" aria-selected="false" data-pane="console">${say("Consola de la tienda", "Store console")}</button>
</div>
<div class="panes">
<section class="pane" id="phone"><h2>${say("Teléfono del cliente", "Customer phone")}</h2><iframe src="/demo/telefono" title="Customer phone" name="telefono"></iframe></section>
<section class="pane" id="console"><h2>${say("Consola de la tienda (sos el dueño)", "Store console (you're the owner)")}</h2><iframe src="/console/inicio" title="Store console" name="consola"></iframe></section>
</div>
<script>
(function () {
  var tabs = document.querySelectorAll(".tabs button");
  var narrow = window.matchMedia("(max-width:860px)");
  function show(name) {
    tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t.dataset.pane === name)); });
    document.querySelectorAll(".pane").forEach(function (p) { p.hidden = narrow.matches && p.id !== name; });
  }
  tabs.forEach(function (t) { t.addEventListener("click", function () { show(t.dataset.pane); }); });
  narrow.addEventListener("change", function () { show("phone"); });
  show("phone");
  // Screens that only show what's there: reloading them loses nothing. Forms (Add, Products) never reload.
  var SHOWS = new RegExp("^/console(/(inicio|pedidos(/[^/]+)?|preparacion(/[^/]+)?|pendientes|deed/[^/]+))?/?$");
  var consola = document.querySelector('iframe[name="consola"]');
  var telefono = document.querySelector('iframe[name="telefono"]');
  // One language for the whole page (D-63): the console's ES | EN switch picks it, and the phone and
  // this page follow whenever the console loads a page.
  var lang = document.documentElement.lang === "en" ? "en" : "es";
  function follow() {
    try { lang = consola.contentDocument.documentElement.lang === "en" ? "en" : "es"; } catch (err) { /* not loaded yet */ }
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-en]").forEach(function (e) { e.textContent = e.getAttribute("data-" + lang); });
    try { telefono.contentWindow.postMessage({ demo: "lang", lang: lang }, location.origin); } catch (err) { /* reloading */ }
  }
  consola.addEventListener("load", follow);
  telefono.addEventListener("load", follow);
  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin || !e.data || e.data.demo !== "answered") return;
    try {
      var w = consola.contentWindow, focused = w.document.activeElement;
      if (focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) return;
      if (SHOWS.test(w.location.pathname)) w.location.reload();
    } catch (err) { /* the console is mid-navigation; its next page is fresh anyway */ }
    var tab = document.querySelector('.tabs [data-pane="console"]');
    if (narrow.matches && tab.getAttribute("aria-selected") !== "true") tab.classList.add("news");
  });
  tabs.forEach(function (t) { t.addEventListener("click", function () { t.classList.remove("news"); }); });
})();
</script>`,
    SPLIT_STYLE,
  );
}

const PHONE_STYLE = `
body{display:flex;flex-direction:column;height:100vh;background:#ece5d8}
.head{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--forest);color:#fff}
.head .dot{width:34px;height:34px;border-radius:50%;background:var(--gold);color:var(--forest);display:grid;place-items:center;font-weight:700}
.head small{display:block;opacity:.8;font-size:12px}
#chat{flex:1;overflow-y:auto;padding:12px 10px;display:flex;flex-direction:column;gap:6px}
.msg{max-width:85%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word;font-size:15px;line-height:1.4;box-shadow:0 1px 1px #0000001a}
.in{align-self:flex-end;background:#d9f2cf}
.out{align-self:flex-start;background:#fff}
.msg img{display:block;max-width:220px;border-radius:8px}
.msg audio{display:block;width:230px}
.opts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.opts button{flex:1 1 auto;min-height:40px;padding:6px 12px;border:1px solid var(--line);border-radius:10px;background:#f7fbf6;color:var(--green);font:inherit;font-weight:700;cursor:pointer}
.opts button:disabled{opacity:.5;cursor:default}
.typing{align-self:flex-start;color:var(--mute);font-size:13px;padding:4px 8px}
.hint{align-self:center;max-width:92%;text-align:center;font-size:13px;color:var(--mute);background:#fffefacc;border-radius:10px;padding:8px 12px}
.presets{display:flex;gap:6px;overflow-x:auto;padding:8px 10px 0;background:#f4efe6}
.presets button{flex:0 0 auto;min-height:40px;padding:6px 12px;border:1px solid var(--line);border-radius:20px;background:#fff;font:inherit;font-size:14px;cursor:pointer}
form{display:flex;gap:8px;padding:8px 10px 10px;background:#f4efe6}
form input{flex:1;min-height:46px;padding:10px 14px;border:1px solid var(--line);border-radius:23px;font:inherit}
form button{min-width:64px;min-height:46px;border:0;border-radius:23px;background:var(--green);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.err{color:#9a4435;font-size:13px;padding:0 12px 6px;background:#f4efe6;margin:0}
`;

/** The phone's script, kept raw so its regular expressions keep their backslashes. */
const PHONE_SCRIPT = String.raw`
(function () {
  var CSRF = JSON.parse(document.getElementById("csrf").textContent);
  var chat = document.getElementById("chat"), err = document.getElementById("err");
  var seen = {}, last = 0, waitingSince = 0, typing = null, loaded = false, lines = [];
  // The chat in one language (D-63): Spanish as the assistant sent it, or all of it in English. The
  // console's ES | EN switch picks it; the store page passes the choice on.
  var lang = chat.dataset.lang === "en" ? "en" : "es";
  var UI = {
    es: { assistant: "Asistente de pedidos", typing: "escribiendo…", voice: "🎤 Nota de voz", photo: "Foto de una lista escrita a mano",
      hint: "Sos el cliente. Tocá un ejemplo abajo o escribí tu propio pedido, por ejemplo: «quiero 3 libras de arroz y un aceite».",
      texto: "💬 Pedido por texto", lista: "📷 Foto de una lista", voz: "🎤 Nota de voz", placeholder: "Escribí tu pedido…", send: "Enviar",
      limit: "Esta tienda de demostración ya usó sus mensajes. Tocá «Empezar de nuevo» arriba para abrir otra.",
      budget: "La demostración ya usó el presupuesto de IA de hoy. Volvé mañana.",
      expired: "Esta tienda de demostración terminó. Abrí una nueva desde la página de la demostración.",
      failed: "Ese mensaje no se envió. Probá otra vez.", offline: "No se puede llegar a la tienda ahorita. Reintentando…" },
    en: { assistant: "Ordering assistant", typing: "typing…", voice: "🎤 Voice note", photo: "Photo of a handwritten order list",
      hint: "You're the customer. Tap an example below. To type your own order, write it in Spanish (the store's product list is in Spanish), e.g. “quiero 3 libras de arroz y un aceite”.",
      texto: "💬 Text order", lista: "📷 Photo of a list", voz: "🎤 Voice note", placeholder: "Type your order (in Spanish)…", send: "Send",
      limit: "This demo store has used its messages. Tap “Empezar de nuevo” at the top for a fresh one.",
      budget: "The demo has used today's AI budget. Please come back tomorrow.",
      expired: "This demo store has ended. Open a new one from the demo page.",
      failed: "That message didn't go through. Try again.", offline: "Can't reach the store right now. Retrying…" }
  };
  function t(key) { return UI[lang][key]; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function scroll() { chat.scrollTop = chat.scrollHeight; }
  var errorFrom = null;
  function showError(text, from) { err.textContent = text; err.hidden = !text; errorFrom = text ? from || "send" : null; }
  function setTyping(on) {
    if (on && !typing) { typing = el("p", "typing", t("typing")); chat.appendChild(typing); scroll(); }
    if (!on && typing) { typing.remove(); typing = null; }
  }
  // WhatsApp's own marks: *bold* and _italic_. Built from text nodes, never HTML.
  function format(parent, text) {
    text.split(/(\*[^*\n]+\*|_[^_\n]+_)/).forEach(function (part) {
      if (/^\*[^*\n]+\*$/.test(part)) parent.appendChild(el("strong", null, part.slice(1, -1)));
      else if (/^_[^_\n]+_$/.test(part)) parent.appendChild(el("em", null, part.slice(1, -1)));
      else if (part) parent.appendChild(document.createTextNode(part));
    });
  }
  function render(line) {
    var m = el("div", "msg " + line.side);
    if (line.side === "in" && line.kind === "image") { var img = el("img"); img.src = "/demo/telefono/archivo/lista"; img.alt = t("photo"); m.appendChild(img); }
    else if (line.side === "in" && line.kind === "audio") { var a = el("audio"); a.controls = true; a.src = "/demo/telefono/archivo/voz"; m.appendChild(a); m.appendChild(el("small", null, t("voice"))); }
    // A sentence with no English stays as sent.
    else { format(m, (lang === "en" && line.en) || line.body || ""); }
    if (line.buttons && line.buttons.length) {
      var opts = el("div", "opts");
      line.buttons.forEach(function (b) {
        // The label follows the language; the tap still sends the store's own title.
        var btn = el("button", null, (lang === "en" && b.en) || b.title); btn.type = "button";
        btn.addEventListener("click", function () {
          var all = opts.querySelectorAll("button");
          all.forEach(function (x) { x.disabled = true; });
          send({ reply: b.id, title: b.title }).then(function (ok) { if (!ok) all.forEach(function (x) { x.disabled = false; }); });
        });
        opts.appendChild(btn);
      });
      m.appendChild(opts);
    }
    if (typing) chat.insertBefore(m, typing); else chat.appendChild(m);
  }
  // One poll at a time: every 1.5 s while the phone is on screen, every 10 s while its tab is hidden,
  // and never again once the store has ended.
  var timer = null, polling = false, ended = false;
  function schedule(ms) { clearTimeout(timer); if (!ended) timer = setTimeout(poll, ms); }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && !polling) schedule(0); });
  function poll() {
    if (polling || ended) return;
    polling = true;
    fetch("/demo/telefono/mensajes?despues=" + last, { credentials: "same-origin" })
      .then(function (r) { if (r.status === 401) throw new Error("expired"); return r.json(); })
      .then(function (data) {
        var lastSide = null, answered = false;
        data.lines.forEach(function (line) {
          if (seen[line.side + line.id]) return;
          seen[line.side + line.id] = true;
          lines.push(line); render(line); lastSide = line.side;
          if (line.side === "out") answered = true;
          if (line.atMs > last) last = line.atMs - 1;
        });
        if (answered) { waitingSince = 0; setTyping(false); }
        // The store answered: the console beside the phone shows what changed (an order, a pending item).
        if (answered && loaded && window.parent !== window) window.parent.postMessage({ demo: "answered" }, location.origin);
        loaded = true;
        if (lastSide) scroll();
        setTyping(waitingSince > 0 && Date.now() - waitingSince < 90000);
        if (errorFrom === "poll") showError("");
      })
      .catch(function (e) {
        if (e.message === "expired") ended = true;
        showError(ended ? t("expired") : t("offline"), "poll");
      })
      .finally(function () { polling = false; schedule(document.hidden ? 10000 : 1500); });
  }
  // Why a send was refused, in words a visitor can act on.
  var REFUSED = { limit: 1, budget: 1, expired: 1 };
  var sending = false;
  // Resolves true when the store got the message; on a refusal the visitor keeps what they typed.
  function send(payload) {
    if (sending) return Promise.resolve(false);
    sending = true; showError("");
    waitingSince = Date.now(); setTyping(true);
    return fetch("/demo/telefono/enviar", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf": CSRF }, body: JSON.stringify(payload) })
      .then(function (r) {
        if (r.ok) return true;
        return r.json().catch(function () { return {}; }).then(function (body) {
          // A tab left open on an older store: reload it to pick up the current one.
          if (body.error === "csrf") { location.reload(); return false; }
          throw new Error(REFUSED[body.error] ? t(body.error) : t("failed"));
        });
      })
      .catch(function (e) { waitingSince = 0; setTyping(false); showError(e && e.message && e.message.indexOf(" ") > 0 ? e.message : t("failed")); return false; })
      .finally(function () { sending = false; });
  }
  document.querySelectorAll("[data-preset]").forEach(function (b) { b.addEventListener("click", function () { send({ preset: b.dataset.preset }); }); });
  document.getElementById("send").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = document.getElementById("text"), text = input.value.trim();
    if (!text) return;
    send({ text: text }).then(function (ok) { if (ok) input.value = ""; });
  });
  // Everything on the phone in the chosen language, the chat redrawn from what it already holds.
  function setLang(next) {
    lang = next === "en" ? "en" : "es";
    document.documentElement.lang = lang;
    document.getElementById("assistant").textContent = t("assistant");
    document.getElementById("hint").textContent = t("hint");
    document.querySelectorAll("[data-preset]").forEach(function (b) { b.textContent = t(b.dataset.preset); });
    document.getElementById("text").placeholder = t("placeholder");
    document.querySelector("#send button").textContent = t("send");
    chat.querySelectorAll(".msg").forEach(function (m) { m.remove(); });
    lines.forEach(render);
    if (typing) { typing.textContent = t("typing"); chat.appendChild(typing); }
    if (errorFrom) showError("");
    scroll();
  }
  window.addEventListener("message", function (e) {
    if (e.origin === location.origin && e.data && e.data.demo === "lang") setLang(e.data.lang);
  });
  setLang(lang);
  poll();
})();
`;

/** `/demo/telefono`: the customer's side, in Spanish. Polls the store's replies every second and a half. */
export function demoPhonePage(csrf: string, language: "es" | "en") {
  return page(
    "Customer phone",
    html`<div class="head"><span class="dot" aria-hidden="true">MD</span><span>Mercadito Demo<small id="assistant"></small></span></div>
<div id="chat" aria-live="polite" data-lang="${language}">
<p class="hint" id="hint"></p>
</div>
<div class="presets" aria-label="Examples">
<button type="button" data-preset="texto">💬 Text order</button>
<button type="button" data-preset="lista">📷 Photo of a list</button>
<button type="button" data-preset="voz">🎤 Voice note</button>
</div>
<p class="err" id="err" role="alert" hidden></p>
<form id="send"><input id="text" maxlength="${DEMO_MAX_TEXT}" autocomplete="off" placeholder="Escribí tu pedido…" aria-label="Message"><button>Enviar</button></form>
<script type="application/json" id="csrf">${raw(JSON.stringify(csrf))}</script>
<script>${raw(PHONE_SCRIPT)}</script>`,
    PHONE_STYLE,
  );
}
