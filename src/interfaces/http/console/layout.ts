/**
 * The console's shared layout, phone first (wireframes C1–C7), in the look of the Nov 4 design
 * concept: a light top bar with the store's name, the owner's bell (Pendientes, with the open count)
 * and who is logged in; the screen's own title under a small kicker line; an optional notice; the
 * screen's content; and the tab bar (Inicio, Pedidos, Anotar raised in the center, Productos, Más),
 * which becomes a left sidebar on a wide screen. Every screen renders through `shell`; login pages,
 * which have no session, use `simplePage`. The shared look (cards, chips, rows, buttons) lives in
 * `BASE_STYLE`; a screen adds only what is its own.
 *
 * To add a screen: write `<name>.ts` next to this file exporting a function that registers its
 * routes, call it in `index.ts`, and add its tab to `NAV` below if it belongs in the navigation.
 */
import type { Context } from "hono";
import { html, raw } from "hono/html";
import { describeError } from "../../../application/errors";
import type { ConsoleMember } from "../../../application/ports";
import type { ConsoleEnv } from "./auth";
import { approvals } from "./inbox";

export const PENDIENTES_PATH = "/console/pendientes";
export const INICIO_PATH = "/console/inicio";

interface NavEntry {
  readonly path: string;
  readonly label: string;
  readonly ownerOnly: boolean;
}

/**
 * The tab bar, in order; Anotar sits in the middle. Owner-only tabs are hidden from staff (the
 * routes refuse them too). Screens that aren't tabs light the tab they're reached from: Empleados
 * lights Más, Pendientes (the bell) lights Inicio.
 */
export const NAV: readonly NavEntry[] = [
  { path: INICIO_PATH, label: "Inicio", ownerOnly: false },
  { path: "/console/preparacion", label: "Pedidos", ownerOnly: false },
  // "Micrófono" in the wireframes; named for what it does until the screen records voice.
  { path: "/console/anotar", label: "Anotar", ownerOnly: false },
  // The catalog the order engine reads; staff propose prices there and the owner confirms them.
  { path: "/console/productos", label: "Productos", ownerOnly: false },
  { path: "/console/mas", label: "Más", ownerOnly: false },
];

export interface ScreenPage {
  readonly title: string;
  /** The big heading when it isn't the title (Inicio greets by name). */
  readonly heading?: string;
  /** The small capitals line above the heading ("Miércoles, 4 de noviembre"). */
  readonly kicker?: string;
  /** One short line under the title ("Hoy · 5 por preparar"). */
  readonly subtitle?: string;
  /** Where the "←" before the title goes, on a screen opened from another (an order → the list). */
  readonly back?: string;
  /** This screen's own address: the auto-refresh goes here. */
  readonly path: string;
  /** The tab to light, a path from `NAV`, when this screen isn't a tab itself (Empleados → Más). */
  readonly tab?: string;
  readonly body: unknown;
  readonly notice?: string | null;
  /** Reloads the page every so many seconds (the preparation list). */
  readonly refreshSeconds?: number;
  /** Extra CSS for this screen only. */
  readonly style?: string;
}

const ROLE_LABELS: Record<ConsoleMember["role"], string> = { owner: "Dueño", staff: "Empleado" };

/** Who is logged in: "Rosa · Empleado", or the role alone. A long name is cut short; the role always shows. */
function whoChip(member: ConsoleMember) {
  const role = ROLE_LABELS[member.role];
  return member.displayName === null
    ? html`<span class="who">${role}</span>`
    : html`<span class="who"><span class="who-name">${member.displayName}</span> <span class="who-role">· ${role}</span></span>`;
}

/** "JR" for "Johan Rodas", "R" for "Rosa"; the role's first letter without a name. */
export function initialsOf(member: ConsoleMember): string {
  const words = (member.displayName ?? "").split(/\s+/u).filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return ROLE_LABELS[member.role].slice(0, 1);
  const first = (word: string) => [...word].find((ch) => /\p{L}/u.test(ch)) ?? "";
  return (first(words[0]!) + (words.length > 1 ? first(words[words.length - 1]!) : "")).toUpperCase();
}

const STORE_ICON = html`<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5 5.6 5h12.8L20 9.5"/><path d="M4 9.5h16v.8a2.7 2.7 0 0 1-5.3.4 2.7 2.7 0 0 1-5.4 0 2.7 2.7 0 0 1-5.3-.4z"/><path d="M5.5 12.5V20h13v-7.5M10 20v-4.5h4V20"/></svg>`;

/** Renders a screen inside the shared layout, with the tabs this member may open. */
export async function shell(c: Context<ConsoleEnv>, screen: ScreenPage) {
  const member = c.get("member");
  const isOwner = member.role === "owner";
  const tabs = NAV.filter((tab) => isOwner || !tab.ownerOnly);
  const current = screen.tab ?? screen.path;
  // Only the owner has the bell, so only the owner's pages read the count.
  const [open, storeName] = await Promise.all([isOwner ? readPendientes(c) : Promise.resolve(null), storeNameOf(c)]);
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${screen.refreshSeconds === undefined ? "" : html`<meta http-equiv="refresh" content="${screen.refreshSeconds};url=${screen.path}">`}
<title>${screen.title}</title>
${styleTag(BASE_STYLE + (screen.style ?? ""))}
</head>
<body data-layout="console">
<header class="bar"><span class="store">${STORE_ICON}<span class="store-name">${storeName ?? "Mi tienda"}</span></span>
${isOwner ? bell(open, screen.path === PENDIENTES_PATH) : ""}<span class="avatar" aria-hidden="true">${initialsOf(member)}</span>
${whoChip(member)}</header>
<main>
<div class="page-head">${screen.back === undefined ? "" : html`<a class="back" href="${screen.back}" aria-label="Volver">←</a>`}
<div class="titles">${screen.kicker === undefined ? "" : html`<p class="kicker">${screen.kicker}</p>`}<h1>${screen.heading ?? screen.title}</h1>${
    screen.subtitle === undefined ? "" : html`<p class="sub">${screen.subtitle}</p>`
  }</div></div>
${screen.notice === undefined || screen.notice === null ? "" : html`<p class="notice" role="status">${screen.notice}</p>`}
${screen.body}
</main>
<nav class="tabs">${tabs.map(
    (tab) => html`<a href="${tab.path}"${tab.path === current ? html` aria-current="page"` : ""}>${tab.label}</a>`,
  )}</nav>
</body>
</html>`;
}

/**
 * The owner's bell: Pendientes, with how many are open when that could be read. The word stays in
 * the link for screen readers; the bell is drawn by CSS.
 */
function bell(open: number | null, here: boolean) {
  const count = open === null || open === 0 ? "" : html`<span class="badge">${open > 99 ? "99+" : String(open)}</span>`;
  return html`<a class="bell" href="${PENDIENTES_PATH}"${here ? html` aria-current="page"` : ""}>Pendientes${count}</a>`;
}

/**
 * Everything waiting for the owner's yes: the open Pendientes, names to approve, customers' change
 * requests and invoices to review (`approvals`). Null when any of it can't be read: the bell then
 * shows no count, and Inicio leaves the card out rather than say a number it doesn't know.
 */
export async function readPendientes(c: Context<ConsoleEnv>): Promise<number | null> {
  const { deps, retrieval } = c.get("runtime");
  const member = c.get("member");
  try {
    const [open, names, waiting] = await Promise.all([deps.pendientesBoard.countOpen(member), retrieval.countProposed(member), approvals(c)]);
    return waiting === null ? null : open + names + waiting.length;
  } catch (error) {
    deps.log.warn("pendientes_count_failed", { businessId: member.businessId, reason: describeError(error) });
    return null;
  }
}

/** The name the owner gave the store in Mi tienda; null until then, or when it can't be read. */
async function storeNameOf(c: Context<ConsoleEnv>): Promise<string | null> {
  const member = c.get("member");
  try {
    const name = (await c.get("runtime").business.context.current(member))?.name.trim() ?? "";
    return name === "" ? null : name;
  } catch (error) {
    c.get("runtime").deps.log.warn("store_name_failed", { businessId: member.businessId, reason: describeError(error) });
    return null;
  }
}

/** The hidden CSRF field every console form carries. */
export function csrfField(csrf: string) {
  return html`<input type="hidden" name="csrf" value="${csrf}">`;
}

/**
 * A `<style>` element for the console's own stylesheet constants. `html` would escape quotes and
 * `>` inside it, which breaks CSS strings and child selectors, so the text goes in as it is. Only
 * constants written in this folder pass through here, never anything a person typed.
 */
export function styleTag(css: string) {
  return html`<style>${raw(css)}</style>`;
}

/** A plain page outside the layout: login, refusals, and anything shown without a session. */
export function simplePage(title: string, body: unknown) {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${styleTag(SIMPLE_STYLE)}
</head>
<body><h1>${title}</h1>${body}</body>
</html>`;
}

/** A tab icon drawn as a mask, so it takes the tab's own color. Our own simple line drawings. */
const icon = (paths: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>${paths}</svg>`,
  )}")`;
const ICONS = {
  inicio: icon("<path d='M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z'/>"),
  pedidos: icon("<rect x='5.5' y='4.5' width='13' height='16' rx='2'/><path d='M9.5 3.5h5v3h-5zM9 11h6M9 15h4'/>"),
  plus: icon("<path d='M12 5v14M5 12h14' stroke-width='2.2'/>"),
  productos: icon("<path d='M12 3 4 7.5v9L12 21l8-4.5v-9z'/><path d='M4 7.5 12 12l8-4.5M12 12v9'/>"),
  mas: icon("<circle cx='5.5' cy='12' r='1.4' fill='black'/><circle cx='12' cy='12' r='1.4' fill='black'/><circle cx='18.5' cy='12' r='1.4' fill='black'/>"),
  bell: icon("<path d='M6.5 16v-5a5.5 5.5 0 0 1 11 0v5l1.5 2h-14z'/><path d='M10 20.5a2 2 0 0 0 4 0'/>"),
};

/**
 * The console's one look, after the Nov 4 design concept: cream paper, deep green ink, a mustard
 * accent for the next step, serif headings over a plain sans body, and big money figures. Sizes stay
 * larger than the concept's for a phone in a bright store (body 17 px, tap targets 48 px or more).
 * Colors are tokens; the older names (--bar, --accent, --mute, --hi, --warn, --mango) stay because
 * the screens' own styles use them.
 */
const TOKENS = `
:root{--paper:#f5f3eb;--bg:#f5f3eb;--card:#fffefa;--ink:#213e35;--forest:#203f35;--bar:#203f35;--green:#2a6346;--accent:#2a6346;
--gold:#f1c45a;--mango:#f1c45a;--new:#f1c45a;--mute:#5c665d;--line:#dedfd3;--sage:#e8eddf;--soft:#e8eddf;--cream:#eeeee3;
--wash:#fbefda;--hi:#fbefda;--hi-line:#e1d0ac;--orange:#a64d2a;--warn:#9a4435;--redsoft:#f8e9e3;--page:#e9e8dc;
--btn-line:#7f877d;--field:#8a9188;--focus:#c97537;--col:720px;--shadow:0 12px 30px #263b2e0d;
--serif:Georgia,"Times New Roman",serif}`;

/** What every console page shares: type, links, focus, forms, buttons, cards, chips, notices. */
const ELEMENTS = `
*{box-sizing:border-box}
html{background:var(--page)}
body{margin:0 auto;max-width:var(--col);min-height:100vh;font:17px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);-webkit-text-size-adjust:100%}
@media (min-width:760px){body{box-shadow:0 0 0 1px var(--line)}}
a{color:var(--green);text-underline-offset:3px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
p{margin:8px 0}
h1{font-family:var(--serif);font-weight:400}
h2{font-size:19px;font-weight:700;line-height:1.25;letter-spacing:-.3px;margin:0 0 10px}
h3{font-size:17px;margin:4px 0}
ul{list-style:none;margin:0;padding:0}form{margin:0}
label{display:block;margin:14px 0 0;font-weight:700;font-size:15px}
input:not([type=checkbox]):not([type=radio]):not([type=file]),select,textarea{display:block;width:100%;min-height:52px;margin-top:6px;padding:12px 14px;
font:inherit;font-size:17px;font-weight:400;color:var(--ink);background:var(--card);border:1px solid var(--field);border-radius:10px}
textarea{min-height:96px;resize:vertical;line-height:1.4}
input:focus,select:focus,textarea:focus{border-color:var(--ink)}
input[type=checkbox],input[type=radio]{width:22px;height:22px;margin:0 10px 0 0;vertical-align:-5px;accent-color:var(--forest)}
input[type=file]{display:block;width:100%;margin-top:8px;padding:10px;border:1px dashed #b6c5ac;border-radius:10px;background:#f3f5eb;font:inherit;font-size:15px;font-weight:400;color:var(--ink)}
input[type=file]::file-selector-button{min-height:48px;margin-right:12px;padding:0 18px;border:0;border-radius:8px;background:var(--gold);color:var(--forest);font:inherit;font-weight:700}
fieldset{margin:14px 0;padding:10px 14px 14px;border:1px solid var(--line);border-radius:10px}
legend{padding:0 4px;font-weight:700}
button,a.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:52px;min-width:88px;padding:0 18px;
font:inherit;font-weight:700;line-height:1.2;text-align:center;border:1px solid var(--btn-line);border-radius:10px;background:var(--card);color:var(--ink);text-decoration:none;cursor:pointer}
button:hover,a.button:hover{border-color:var(--ink)}
button:active,a.button:active{transform:translateY(1px)}
button.primary,a.button.primary{width:100%;margin-top:12px;min-height:56px;background:var(--forest);border-color:var(--forest);color:#fff;font-size:18px}
button.gold,a.button.gold{background:var(--gold);border-color:var(--gold);color:var(--forest)}
button.danger,a.button.danger{border-color:#d9b2a6;background:var(--redsoft);color:var(--warn)}
button.danger-fill,a.button.danger-fill{background:var(--warn);border-color:var(--warn);color:#fff}
.notice{margin:12px 16px;padding:12px 16px;border-radius:10px;background:var(--wash);border:1px solid var(--hi-line);color:#5a4a2c;font-weight:600}
.empty{padding:36px 22px;text-align:center;color:var(--mute);font-size:17px}
.card{display:block;margin:12px 16px;padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:inherit;text-decoration:none;box-shadow:var(--shadow)}
a.card:hover{border-color:var(--btn-line)}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px}
.muted{color:var(--mute);font-size:15px}
.chip{flex:none;display:inline-flex;align-items:center;padding:5px 9px;border-radius:5px;font-size:13px;font-weight:700;line-height:1.1;background:var(--sage);color:#52673e;white-space:nowrap}
.chip.new{background:#f9e7b5;color:#72541d}
.chip.chg{background:#f3e6dd;color:#925936}
.chip.late{background:#f6dcd5;color:#8a3429}
.chip.ok{background:#deece4;color:var(--green)}
h2.section{margin:26px 20px 8px;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
.kicker{margin:0 0 6px;font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.total,.price,.number,.qty,.badge,.stat strong{font-variant-numeric:tabular-nums}`;

/** For a screen with its own plain header (`<header><h1>…</h1><a>…</a></header>`) and no tab bar. */
export const PAGE_STYLE = `${TOKENS}${ELEMENTS}
body{padding-bottom:32px}
body>header{position:sticky;top:0;z-index:3;display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:76px;padding:12px 18px;background:var(--paper);border-bottom:1px solid var(--line);color:var(--ink)}
body>header h1{margin:0;font-size:30px;line-height:1.15;letter-spacing:-1px;overflow-wrap:anywhere}
body>header a{flex:none;display:inline-flex;align-items:center;min-height:48px;padding:0 16px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font-weight:700;font-size:15px;text-decoration:none}
`;

const SIMPLE_STYLE = `${TOKENS}${ELEMENTS}
body{padding:44px 22px 32px}
body>h1{margin:0 0 14px;font-size:36px;line-height:1.15;letter-spacing:-1.2px}
button{width:100%;margin-top:12px;min-height:56px;background:var(--forest);border-color:var(--forest);color:#fff;font-size:18px}
li{padding:6px 0}
`;

/**
 * The shell: the light top bar, the page head, and the tab bar with Anotar raised in the middle; a
 * left sidebar from 1024 px. Tab icons are CSS masks, so the tabs' markup stays plain text.
 */
const BASE_STYLE = `${TOKENS}${ELEMENTS}
header.bar{position:sticky;top:0;z-index:4;display:flex;align-items:center;gap:12px;min-height:66px;padding:10px 16px 10px 20px;background:var(--paper);border-bottom:1px solid var(--line)}
svg.ico{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.store{flex:1;min-width:0;display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px}
.store-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bell{position:relative;flex:none;display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;font-size:0;color:var(--ink);text-decoration:none}
.bell::before{content:"";width:24px;height:24px;background:currentColor;-webkit-mask:${ICONS.bell} center/contain no-repeat;mask:${ICONS.bell} center/contain no-repeat}
.bell[aria-current=page]{background:var(--sage)}
.bell .badge{position:absolute;top:4px;right:2px;min-width:22px;padding:0 6px;border:2px solid var(--paper);border-radius:11px;background:var(--orange);color:#fff;font-size:12px;font-weight:800;line-height:18px;text-align:center}
.avatar{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:#ddd6bb;color:var(--forest);font-size:14px;font-weight:800}
.who{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.who-name{min-width:0;overflow:hidden;text-overflow:ellipsis}.who-role{flex:none;color:var(--mute)}
main{padding:0 0 128px}
.page-head{display:flex;align-items:flex-start;gap:12px;padding:26px 20px 10px}
.titles{flex:1;min-width:0}
.page-head h1{margin:0;font-size:34px;line-height:1.12;letter-spacing:-1.1px;overflow-wrap:anywhere}
.sub{margin:8px 0 0;font-size:16px;color:var(--mute)}
.back{flex:none;display:flex;align-items:center;justify-content:center;width:48px;height:48px;margin:-2px 0 0 -6px;border:1px solid var(--line);border-radius:50%;background:var(--card);color:var(--ink);font-size:22px;text-decoration:none}
nav.tabs{position:fixed;left:0;right:0;bottom:0;z-index:4;max-width:var(--col);margin:0 auto;display:flex;align-items:flex-end;padding:6px 4px calc(6px + env(safe-area-inset-bottom));
background:var(--card);border-top:1px solid var(--line);box-shadow:0 -4px 20px #213e350a}
nav.tabs a{position:relative;flex:1 1 0;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;min-height:60px;padding:6px 2px 4px;
color:var(--mute);text-decoration:none;font-weight:600;font-size:13px}
nav.tabs a::before{content:"";width:25px;height:25px;background:currentColor;-webkit-mask:var(--i) center/contain no-repeat;mask:var(--i) center/contain no-repeat}
nav.tabs a[aria-current=page]{color:var(--forest);font-weight:800}
nav.tabs a[aria-current=page]::after{content:"";position:absolute;top:-6px;left:28%;right:28%;height:3px;border-radius:0 0 3px 3px;background:var(--forest)}
nav.tabs a[href$="/inicio"]{--i:${ICONS.inicio}}
nav.tabs a[href$="/preparacion"]{--i:${ICONS.pedidos}}
nav.tabs a[href$="/productos"]{--i:${ICONS.productos}}
nav.tabs a[href$="/mas"]{--i:${ICONS.mas}}
nav.tabs a[href$="/anotar"]{--i:${ICONS.plus};color:var(--ink);font-weight:800}
nav.tabs a[href$="/anotar"]::before{width:64px;height:64px;margin-top:-34px;border:5px solid var(--card);border-radius:50%;background:var(--gold);-webkit-mask:none;mask:none;box-shadow:0 -2px 15px #203f3514}
nav.tabs a[href$="/anotar"]::after{content:"";position:absolute;top:-16px;left:50%;width:30px;height:30px;margin-left:-15px;background:var(--forest);-webkit-mask:var(--i) center/contain no-repeat;mask:var(--i) center/contain no-repeat}
nav.tabs a[href$="/anotar"][aria-current=page]::before{background:var(--forest)}
nav.tabs a[href$="/anotar"][aria-current=page]::after{top:-16px;left:50%;right:auto;height:30px;border-radius:0;background:var(--gold)}
@media (min-width:1024px){
body{max-width:none;margin:0;padding-left:248px;box-shadow:none}
header.bar{min-height:84px;padding:12px 44px}
.store{font-size:17px}
.who{position:static;width:auto;height:auto;overflow:visible;clip:auto;display:flex;flex-direction:column;font-size:14px;font-weight:700;line-height:1.25}
.who-role{font-weight:500}
main{padding:0 44px 60px;max-width:1180px}
.page-head{padding:38px 0 14px}
.page-head h1{font-size:44px;letter-spacing:-1.5px}
main>.card,main>.notice,main>.empty,main>section,main>ul,main>form,main>h2.section,main>p{margin-left:0;margin-right:0}
nav.tabs{top:0;right:auto;bottom:0;width:248px;max-width:none;margin:0;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:6px;
padding:30px 20px;border-top:0;border-right:1px solid var(--line);background:#eeeee4;box-shadow:none}
nav.tabs a{flex:none;flex-direction:row;justify-content:flex-start;gap:14px;min-height:50px;padding:10px 14px;border-radius:10px;color:#4f5d52;font-size:16px}
nav.tabs a::before{width:22px;height:22px}
nav.tabs a[aria-current=page]{background:#dde4d4}
nav.tabs a[aria-current=page]::after{display:none}
nav.tabs a[href$="/anotar"]{margin:4px 0;background:var(--forest);color:#fff}
nav.tabs a[href$="/anotar"]::before{width:22px;height:22px;margin:0;border:0;border-radius:0;background:currentColor;-webkit-mask:var(--i) center/contain no-repeat;mask:var(--i) center/contain no-repeat;box-shadow:none}
nav.tabs a[href$="/anotar"]::after{display:none}
nav.tabs a[href$="/anotar"][aria-current=page]{background:var(--gold);color:var(--forest)}
nav.tabs a[href$="/anotar"][aria-current=page]::before{background:currentColor}
}
`;
