/**
 * The public demo's pages: the landing page, the split view (customer phone beside the store's
 * console) and the phone itself. The landing page is in English for visitors; the store page and the
 * phone follow the console's ES | EN switch (D-63). What the customer types is always shown as typed.
 */
import { html, raw } from "hono/html";
import type { DemoLimit } from "../../domain/demo";
import { DEMO_MAX_TEXT, DEMO_PRESETS } from "../../domain/demo";

type Language = "es" | "en";

const STYLE = `
:root{--paper:#f5f3eb;--card:#fffefa;--ink:#213e35;--forest:#203f35;--green:#2a6346;--gold:#f1c45a;--mute:#5c665d;--line:#dedfd3;--page:#e9e8dc;--focus:#c97537;--serif:Georgia,"Times New Roman",serif}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--page);color:var(--ink)}
a{color:var(--green)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
h1{font-family:var(--serif);font-weight:400}
.btn{display:inline-block;min-height:52px;padding:13px 22px;border:0;border-radius:12px;background:var(--forest);color:#fff;font:inherit;font-weight:700;cursor:pointer;text-decoration:none}
`;

function page(title: string, body: unknown, extraStyle = "", language: Language = "en") {
  return html`<!doctype html>
<html lang="${language}">
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
.small{font-size:14px;color:var(--mute)}
.btn.quiet{background:transparent;border:1px solid var(--forest);color:var(--forest)}
`;

const SHOWCASE_STYLE = `
.hero{background:#12231c;color:#fff;padding:48px 20px 56px}
.hero .in,.steps,.fine{max-width:1040px;margin:0 auto}
.hero .in{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:40px;align-items:center}
.brand{font-family:var(--serif);font-size:56px;line-height:1;margin:0}
.hero h1{font-family:inherit;font-weight:800;font-size:30px;line-height:1.2;margin:18px 0 6px}
.hero .sub{color:#b9c8bd;margin:0 0 22px}
.hero .lede{color:#dfe7e1;margin:0 0 26px}
.hero .btn{background:var(--gold);color:#12231c;font-size:18px;padding:15px 30px}
.hero .btn.quiet{background:transparent;color:var(--gold);border:1px solid var(--gold);font-size:16px;padding:12px 22px}
.hero form{margin:0;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.hero .meta{color:#93a69a;font-size:14px;margin:14px 0 0}
.tour{width:100%;height:auto;display:block;border-radius:14px;border:1px solid #2e4a3d;box-shadow:0 18px 50px rgba(0,0,0,.45);background:#0c1813}
.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;padding:36px 20px 8px;list-style:none;counter-reset:step}
.steps li{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 22px;counter-increment:step}
.steps li::before{content:counter(step);display:inline-grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--forest);color:#fff;font-weight:700;margin-bottom:10px}
.steps h2{font-size:18px;margin:0 0 6px}
.steps p{margin:0;color:var(--mute);font-size:15px}
.fine{padding:20px 20px 48px;font-size:14px;color:var(--mute)}
@media (max-width:860px){.hero .in{grid-template-columns:1fr;gap:28px}.steps{grid-template-columns:1fr}.brand{font-size:46px}.hero h1{font-size:26px}}
`;

/** Where the landing page's recording is served (demo-tour.ts). */
export const DEMO_TOUR_PATH = "/demo/recorrido.gif";

/** `/demo`: what the demo shows, the recording of a visit, and one button that opens a store of the visitor's own. */
export function demoLandingPage(hasStore: boolean) {
  return page(
    "Deed — try the store assistant",
    html`<header class="hero"><div class="in">
<div>
<p class="brand">Deed</p>
<h1>AI that can't lie about what it did.</h1>
<p class="sub">No proof, no claim.</p>
<p class="lede">A store assistant for a small mercadito in Honduras. Customers order by text, a photo of a list or a voice note;
Meta's Muse models read it and the store confirms. Every step it claims is backed by a record you can see.</p>
<form method="post" action="/demo/empezar" onsubmit="this.querySelector('button').disabled = true">
${hasStore ? html`<a class="btn" href="/demo/tienda">Back to my demo store</a>` : ""}
<button class="${hasStore ? "btn quiet" : "btn"}">${hasStore ? "Start a fresh store" : "Try it"}</button>
</form>
<p class="meta">Your own made-up store, ready in seconds. No sign-up.</p>
</div>
<img class="tour" src="${DEMO_TOUR_PATH}" width="960" height="596" alt="A customer orders on a phone, the store prepares the order on its console, and a live graph shows what actually happened">
</div></header>
<ol class="steps">
<li><h2>Order as a customer</h2><p>On the phone, tap Text order, then Confirm. The assistant reads it back with prices first.</p></li>
<li><h2>Run the store</h2><p>In the console, open Orders, then Start preparing and Ready. The customer hears "ready" only after that tap.</p></li>
<li><h2>See the proof</h2><p>Open Deed live: every step as a chain, and the message or tap that backs each one.</p></li>
</ol>
<p class="fine">Nothing here is real: the store, products, prices and customer are made up, and no message goes to WhatsApp.
Your demo store lasts 24 hours. The assistant speaks Honduran Spanish; the ES | EN switch shows the whole demo in either
language. Staff of a real store: opening a demo signs this browser out of your console, so use a private window.</p>`,
    LANDING_STYLE + SHOWCASE_STYLE,
  );
}

/**
 * Why no new demo store opened, keyed by the limit's name. "full" (every demo store the site can hold
 * is in use) clears only as stores expire, so it never promises "a few minutes".
 */
const LIMITED: Readonly<Record<string, { readonly title: string; readonly heading: string; readonly why: string }>> = {
  visitor: {
    title: "Demo limit",
    heading: "One moment",
    why: "You've opened several demo stores in the last hour. Please use the one you have, or try again later.",
  },
  everyone: {
    title: "Demo busy",
    heading: "One moment",
    why: "A lot of people are trying the demo right now. Please try again in a few minutes.",
  },
  full: {
    title: "Demo full",
    heading: "The demo is full",
    why: "Every demo store is in use right now. Each one closes 24 hours after it opens, so please come back later today or tomorrow.",
  },
};

export function demoLimitedPage(limit: Exclude<DemoLimit, null>, hasStore: boolean) {
  const { title, heading, why } = LIMITED[limit] ?? LIMITED.everyone!;
  return page(title, html`<main><h1>${heading}</h1><p>${why}</p><p>${
      hasStore ? html`<a class="btn" href="/demo/tienda">Back to my demo store</a>` : html`<a href="/demo">Back</a>`
    }</p></main>`, LANDING_STYLE);
}

const SPLIT_STYLE = `
body{display:flex;flex-direction:column;height:100vh}
.top{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:10px 16px;background:var(--forest);color:#fff;font-size:14px}
.top strong{font-family:var(--serif);font-weight:400;font-size:18px}
.top a{color:var(--gold)}
.top form{display:inline;margin:0}
.top .reset{min-height:36px;padding:6px 14px;border:1px solid var(--gold);border-radius:18px;background:none;color:var(--gold);font:inherit;font-weight:700;cursor:pointer;white-space:nowrap}
.top .right{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.top .narrow{display:none}
.panes{flex:1;display:grid;grid-template-columns:400px 1fr;gap:0;min-height:0}
.pane{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line)}
.pane h2{margin:0;padding:8px 14px;font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:var(--mute);background:var(--paper);border-bottom:1px solid var(--line)}
iframe{flex:1;width:100%;border:0;background:var(--paper)}
.tabs{display:none}
@media (max-width:860px){
 .top{gap:6px 10px;padding:6px 12px;font-size:13px;line-height:1.3;flex-wrap:nowrap}
 .top strong{font-size:16px}
 .top .wide{display:none}
 .top .narrow{display:inline}
 .top .right{gap:8px;flex-wrap:nowrap}
 .top .reset{min-height:32px;padding:4px 10px}
 .panes{grid-template-columns:1fr}
 .pane h2{display:none}
 .tabs{display:grid;grid-template-columns:1fr 1fr;background:var(--paper);border-bottom:1px solid var(--line)}
 .tabs button{min-height:44px;border:0;background:none;font:inherit;font-weight:700;color:var(--mute);cursor:pointer}
 .tabs button[aria-selected=true]{color:var(--ink);box-shadow:inset 0 -3px 0 var(--forest)}
 .tabs button.news::after{content:" •";color:#c0392b}
 .pane[hidden]{display:none}
}
`;

/** `/demo/tienda`: the customer's phone on the left, the store's console on the right (tabs on a phone). */
export function demoSplitPage(language: Language) {
  const pick = (es: string, en: string) => (language === "en" ? en : es);
  const say = (es: string, en: string) => html`<span data-es="${es}" data-en="${en}">${pick(es, en)}</span>`;
  // An attribute in both languages; the script below swaps it with the text.
  const attr = (name: string, es: string, en: string) =>
    html`${raw(name)}="${pick(es, en)}" data-attr="${name}" data-attr-es="${es}" data-attr-en="${en}"`;
  return page(
    pick("Tu tienda de demostración", "Your demo store"),
    html`<div class="top"><span><strong>Mercadito Demo</strong><span class="wide"> · ${say("demostración en vivo, datos inventados", "live demo, made-up data")}</span></span>
<span class="right"><span><span class="wide">${say("Pedí como cliente a la izquierda, atendé la tienda a la derecha.", "Order as the customer on the left, run the store on the right.")}</span><span class="narrow">${say("Cambiá entre cliente y tienda con las pestañas.", "Switch between customer and store with the tabs.")}</span> <a href="/demo">${say("Acerca de", "About")}</a></span>
<form method="post" action="/demo/empezar" onsubmit="this.querySelector('button').disabled = true"><button class="reset" ${attr("title", "Abre una tienda de demostración nueva", "Opens a fresh demo store")}>${say("Empezar de nuevo", "Start over")}</button></form></span></div>
<div class="tabs" role="tablist">
<button role="tab" aria-selected="true" data-pane="phone">${say("Teléfono del cliente", "Customer phone")}</button>
<button role="tab" aria-selected="false" data-pane="console">${say("Consola de la tienda", "Store console")}</button>
</div>
<div class="panes">
<section class="pane" id="phone"><h2>${say("Teléfono del cliente", "Customer phone")}</h2><iframe src="/demo/telefono" ${attr("title", "Teléfono del cliente", "Customer phone")} name="telefono"></iframe></section>
<section class="pane" id="console"><h2>${say("Consola de la tienda (sos el dueño)", "Store console (you're the owner)")}</h2><iframe src="/console/inicio" ${attr("title", "Consola de la tienda", "Store console")} name="consola"></iframe></section>
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
  var TITLES = { es: "Tu tienda de demostración", en: "Your demo store" };
  // One language for the whole page (D-63): the console's ES | EN switch picks it, and the phone and
  // this page follow whenever the console loads a page.
  var lang = document.documentElement.lang === "en" ? "en" : "es";
  function follow() {
    try { lang = consola.contentDocument.documentElement.lang === "en" ? "en" : "es"; } catch (err) { /* not loaded yet */ }
    document.documentElement.lang = lang;
    document.title = TITLES[lang];
    document.querySelectorAll("[data-en]").forEach(function (e) { e.textContent = e.getAttribute("data-" + lang); });
    document.querySelectorAll("[data-attr]").forEach(function (e) { e.setAttribute(e.dataset.attr, e.getAttribute("data-attr-" + lang)); });
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
    language,
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
.opts.old button{opacity:.4;background:#f2f2ee;color:var(--mute)}
.typing{align-self:flex-start;color:var(--mute);font-size:13px;padding:4px 8px}
.hint{align-self:center;max-width:92%;text-align:center;font-size:13px;color:var(--mute);background:#fffefacc;border-radius:10px;padding:8px 12px}
.presets{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px 0;background:#f4efe6}
.presets button{flex:0 1 auto;min-height:40px;padding:6px 12px;border:1px solid var(--line);border-radius:20px;background:#fff;font:inherit;font-size:14px;cursor:pointer}
form{display:flex;gap:8px;padding:8px 10px 10px;background:#f4efe6}
form input{flex:1;min-height:46px;padding:10px 14px;border:1px solid var(--line);border-radius:23px;font:inherit}
form button{min-width:64px;min-height:46px;border:0;border-radius:23px;background:var(--green);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.err{color:#9a4435;font-size:13px;padding:0 12px 6px;background:#f4efe6;margin:0}
.count{font-size:12px;color:var(--mute);text-align:right;padding:0 16px 4px;background:#f4efe6;margin:0}
.count.over{color:#9a4435;font-weight:700}
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
  var MAX = Number(chat.dataset.max);
  // The preset order's own words: the only typed-looking message the visitor didn't type themselves.
  var PRESET_TEXTS = JSON.parse(document.getElementById("preset-texts").textContent);
  var UI = {
    es: { assistant: "Asistente de pedidos", typing: "escribiendo…", voice: "🎤 Nota de voz", photo: "Foto de una lista escrita a mano",
      hint: "Sos el cliente. Tocá un ejemplo abajo o escribí tu propio pedido, por ejemplo: «quiero 3 libras de arroz y un aceite».",
      texto: "💬 Pedido por texto", lista: "📷 Foto de una lista", voz: "🎤 Nota de voz", placeholder: "Escribí tu pedido…", send: "Enviar",
      limit: "Esta tienda de demostración ya usó sus mensajes. Tocá «Empezar de nuevo» arriba para abrir otra.",
      budget: "La demostración ya usó el presupuesto de IA de hoy. Volvé mañana.",
      expired: "Esta tienda de demostración terminó. Abrí una nueva desde la página de la demostración.",
      failed: "Ese mensaje no se envió. Probá otra vez.", offline: "No se puede llegar a la tienda ahorita. Reintentando…",
      message: "Mensaje", examples: "Ejemplos", title: "Teléfono del cliente",
      count: function (n) { return n + " / " + MAX + " caracteres"; },
      over: function (n) { return "Muy largo: " + n + " de " + MAX + " caracteres. Acortalo para enviarlo."; } },
    en: { assistant: "Ordering assistant", typing: "typing…", voice: "🎤 Voice note", photo: "Photo of a handwritten order list",
      hint: "You're the customer. Tap an example below. To type your own order, write it in Spanish (the store's product list is in Spanish), e.g. “quiero 3 libras de arroz y un aceite”.",
      texto: "💬 Text order", lista: "📷 Photo of a list", voz: "🎤 Voice note", placeholder: "Type your order (in Spanish)…", send: "Send",
      limit: "This demo store has used its messages. Tap “Start over” at the top for a fresh one.",
      budget: "The demo has used today's AI budget. Please come back tomorrow.",
      expired: "This demo store has ended. Open a new one from the demo page.",
      failed: "That message didn't go through. Try again.", offline: "Can't reach the store right now. Retrying…",
      message: "Message", examples: "Examples", title: "Customer phone",
      count: function (n) { return n + " / " + MAX + " characters"; },
      over: function (n) { return "Too long: " + n + " of " + MAX + " characters. Shorten it to send."; } }
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
  // The store's replies and the buttons' own titles follow the language; what the customer typed is
  // shown exactly as typed. A sentence with no English stays as sent.
  function shown(line) {
    if (lang !== "en" || !line.en) return line.body || "";
    if (line.side === "out" || line.kind === "interactive") return line.en;
    if (line.kind === "text" && PRESET_TEXTS.indexOf(line.body) >= 0) return line.en;
    return line.body || "";
  }
  // Only the newest buttons can be tapped: older readbacks are greyed out (the engine refuses them anyway).
  function retireOldButtons() {
    var all = chat.querySelectorAll(".opts");
    all.forEach(function (o, i) {
      var old = i < all.length - 1;
      o.classList.toggle("old", old);
      if (old) o.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    });
  }
  function render(line) {
    var m = el("div", "msg " + line.side);
    if (line.side === "in" && line.kind === "image") { var img = el("img"); img.src = "/demo/telefono/archivo/lista"; img.alt = t("photo"); m.appendChild(img); }
    else if (line.side === "in" && line.kind === "audio") { var a = el("audio"); a.controls = true; a.src = "/demo/telefono/archivo/voz"; m.appendChild(a); m.appendChild(el("small", null, t("voice"))); }
    else { format(m, shown(line)); }
    if (line.buttons && line.buttons.length) {
      var opts = el("div", "opts");
      line.buttons.forEach(function (b) {
        // The label follows the language; the tap still sends the store's own title.
        var btn = el("button", null, (lang === "en" && b.en) || b.title); btn.type = "button";
        btn.addEventListener("click", function () {
          var all = opts.querySelectorAll("button");
          all.forEach(function (x) { x.disabled = true; });
          send({ reply: b.id, title: b.title }).then(function (ok) { if (!ok && !opts.classList.contains("old")) all.forEach(function (x) { x.disabled = false; }); });
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
        if (lastSide) retireOldButtons();
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
  // Each send carries an ID made here; sending the same thing again after a failure reuses it, so the
  // store counts it once even when the first try did arrive.
  var pending = null;
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  // Resolves true when the store got the message; on a refusal the visitor keeps what they typed.
  function send(payload) {
    if (sending) return Promise.resolve(false);
    sending = true; showError("");
    waitingSince = Date.now(); setTyping(true);
    var key = JSON.stringify(payload);
    if (!pending || pending.key !== key) pending = { key: key, id: newId() };
    var body = Object.assign({ clientMessageId: pending.id }, payload);
    return fetch("/demo/telefono/enviar", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf": CSRF }, body: JSON.stringify(body) })
      .then(function (r) {
        if (r.ok) { pending = null; return true; }
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
  // Nothing typed is ever cut: near the limit a counter shows, and past it the send waits for a shorter text.
  var input = document.getElementById("text"), count = document.getElementById("count");
  function showCount() {
    var n = input.value.trim().length, over = n > MAX;
    count.hidden = n < MAX - 50;
    count.classList.toggle("over", over);
    count.textContent = over ? t("over")(n) : t("count")(n);
  }
  input.addEventListener("input", showCount);
  document.getElementById("send").addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    if (text.length > MAX) { showCount(); input.focus(); return; }
    send({ text: text }).then(function (ok) { if (ok) { input.value = ""; showCount(); } });
  });
  // Everything on the phone in the chosen language, the chat redrawn from what it already holds.
  function setLang(next) {
    lang = next === "en" ? "en" : "es";
    document.documentElement.lang = lang;
    document.getElementById("assistant").textContent = t("assistant");
    document.getElementById("hint").textContent = t("hint");
    document.querySelectorAll("[data-preset]").forEach(function (b) { b.textContent = t(b.dataset.preset); });
    document.title = t("title");
    input.placeholder = t("placeholder");
    input.setAttribute("aria-label", t("message"));
    document.getElementById("presets").setAttribute("aria-label", t("examples"));
    document.querySelector("#send button").textContent = t("send");
    showCount();
    chat.querySelectorAll(".msg").forEach(function (m) { m.remove(); });
    lines.forEach(render);
    retireOldButtons();
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

/** `/demo/telefono`: the customer's side. Polls the store's replies every second and a half. */
export function demoPhonePage(csrf: string, language: Language) {
  const presetTexts = Object.values(DEMO_PRESETS).flatMap((preset) => (preset.kind === "text" ? [preset.body] : []));
  return page(
    language === "en" ? "Customer phone" : "Teléfono del cliente",
    html`<div class="head"><span class="dot" aria-hidden="true">MD</span><span>Mercadito Demo<small id="assistant"></small></span></div>
<div id="chat" aria-live="polite" data-lang="${language}" data-max="${DEMO_MAX_TEXT}">
<p class="hint" id="hint"></p>
</div>
<div class="presets" id="presets" aria-label="Examples">
<button type="button" data-preset="texto">💬 Text order</button>
<button type="button" data-preset="lista">📷 Photo of a list</button>
<button type="button" data-preset="voz">🎤 Voice note</button>
</div>
<p class="err" id="err" role="alert" hidden></p>
<p class="count" id="count" aria-live="polite" hidden></p>
<form id="send"><input id="text" autocomplete="off" placeholder="Escribí tu pedido…" aria-label="Mensaje"><button>Enviar</button></form>
<script type="application/json" id="csrf">${raw(JSON.stringify(csrf))}</script>
<script type="application/json" id="preset-texts">${raw(jsonInScript(presetTexts))}</script>
<script>${raw(PHONE_SCRIPT)}</script>`,
    PHONE_STYLE,
    language,
  );
}

/** JSON safe inside a <script> element: no "</script>" or "<!--" can close it early. */
function jsonInScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
