/**
 * The console's shared layout for a 360 px phone screen (wireframes C1–C7): a dark green bar with
 * the screen's title, a short subtitle and who is logged in; an optional notice; the screen's own
 * content; and the tab bar at the bottom (Pedidos, Anotar, Pendientes with the owner's open count,
 * Más). Every screen renders through `shell`; login pages, which have no session, use
 * `simplePage`. The shared look (cards, chips, rows, buttons) lives in `BASE_STYLE`; a screen adds
 * only what is its own.
 *
 * To add a screen: write `<name>.ts` next to this file exporting a function that registers its
 * routes, call it in `index.ts`, and add its tab to `NAV` below if it belongs in the navigation.
 */
import type { Context } from "hono";
import { html } from "hono/html";
import { describeError } from "../../../application/errors";
import type { ConsoleMember } from "../../../application/ports";
import type { ConsoleEnv } from "./auth";

const PENDIENTES_PATH = "/console/pendientes";

interface NavEntry {
  readonly path: string;
  readonly label: string;
  readonly ownerOnly: boolean;
}

/**
 * The tab bar, in order. Owner-only tabs are hidden from staff (the routes refuse them too). Screens
 * that aren't tabs (Empleados, the first-login notice) light the tab they're reached from.
 */
export const NAV: readonly NavEntry[] = [
  { path: "/console/preparacion", label: "Pedidos", ownerOnly: false },
  // "Micrófono" in the wireframes; named for what it does until the screen records voice.
  { path: "/console/anotar", label: "Anotar", ownerOnly: false },
  { path: PENDIENTES_PATH, label: "Pendientes", ownerOnly: true },
  { path: "/console/mas", label: "Más", ownerOnly: false },
];

export interface ScreenPage {
  readonly title: string;
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

/** Renders a screen inside the shared layout, with the tabs this member may open. */
export async function shell(c: Context<ConsoleEnv>, screen: ScreenPage) {
  const member = c.get("member");
  const isOwner = member.role === "owner";
  const tabs = NAV.filter((tab) => isOwner || !tab.ownerOnly);
  const current = screen.tab ?? screen.path;
  // Only the owner has the Pendientes tab, so only the owner's pages read the count.
  const open = isOwner ? await openPendientes(c) : 0;
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${screen.refreshSeconds === undefined ? "" : html`<meta http-equiv="refresh" content="${screen.refreshSeconds};url=${screen.path}">`}
<title>${screen.title}</title>
<style>${BASE_STYLE}${screen.style ?? ""}</style>
</head>
<body data-layout="console">
<header class="bar">${screen.back === undefined ? "" : html`<a class="back" href="${screen.back}" aria-label="Volver">←</a>`}
<div class="titles"><h1>${screen.title}</h1>${screen.subtitle === undefined ? "" : html`<p class="sub">${screen.subtitle}</p>`}</div>
${whoChip(member)}</header>
<main>
${screen.notice === undefined || screen.notice === null ? "" : html`<p class="notice" role="status">${screen.notice}</p>`}
${screen.body}
</main>
<nav class="tabs">${tabs.map(
    (tab) =>
      html`<a href="${tab.path}"${tab.path === current ? html` aria-current="page"` : ""}>${tab.label}${
        tab.path === PENDIENTES_PATH && open > 0 ? html`<span class="badge">${open > 99 ? "99+" : String(open)}</span>` : ""
      }</a>`,
  )}</nav>
</body>
</html>`;
}

/**
 * The owner's open Pendientes, names to approve included. A hint on the tab: when it can't be read,
 * the page shows without it.
 */
async function openPendientes(c: Context<ConsoleEnv>): Promise<number> {
  const { deps, retrieval } = c.get("runtime");
  const member = c.get("member");
  try {
    const [open, names] = await Promise.all([deps.pendientesBoard.countOpen(member), retrieval.countProposed(member)]);
    return open + names;
  } catch (error) {
    deps.log.warn("pendientes_count_failed", { businessId: member.businessId, reason: describeError(error) });
    return 0;
  }
}

/** The hidden CSRF field every console form carries. */
export function csrfField(csrf: string) {
  return html`<input type="hidden" name="csrf" value="${csrf}">`;
}

/** A plain page outside the layout: login, refusals, and anything shown without a session. */
export function simplePage(title: string, body: unknown) {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{margin:0;padding:24px 18px;font:17px/1.5 system-ui,sans-serif;background:#f4f4f2;color:#1b1b1b}
h1{font-size:20px}button{min-height:48px;width:100%;font-size:17px;border:0;border-radius:8px;background:#2f6f45;color:#fff}
li{padding:6px 0}</style>
</head>
<body><h1>${title}</h1>${body}</body>
</html>`;
}

/** The console's one look. Colors are tokens so every screen draws from the same few. */
const BASE_STYLE = `
:root{--bar:#1f3d2b;--accent:#2f6f45;--ink:#1b1b1b;--mute:#5c5c5c;--line:#dcd9d0;--bg:#f4f4f2;--card:#fff;
--hi:#fff4cc;--hi-line:#e0c060;--warn:#b3261e;--new:#2f5fb3}
*{box-sizing:border-box}body{margin:0;font:16px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--accent)}
header.bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;min-height:60px;padding:8px 12px;background:var(--bar);color:#fff}
.titles{flex:1;min-width:0}
h1{margin:0;font-size:18px;line-height:1.25;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.sub{margin:2px 0 0;font-size:13px;color:#d4e4d9}
.who{flex:none;display:flex;gap:.3em;max-width:36%;padding:3px 10px;border:1px solid #ffffff80;border-radius:12px;font-size:13px;white-space:nowrap}
.who-name{min-width:0;overflow:hidden;text-overflow:ellipsis}.who-role{flex:none}
.back{flex:none;display:flex;align-items:center;justify-content:center;width:48px;height:48px;margin-left:-10px;color:#fff;font-size:24px;text-decoration:none}
main{padding:2px 0 84px}
nav.tabs{position:fixed;left:0;right:0;bottom:0;z-index:2;display:flex;background:#fff;border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
nav.tabs a{position:relative;flex:1;display:flex;align-items:center;justify-content:center;min-height:56px;padding:12px 2px 0;color:var(--mute);text-decoration:none;font-weight:600;font-size:14px}
nav.tabs a[aria-current=page]{color:var(--bar);box-shadow:inset 0 3px 0 var(--accent)}
.badge{position:absolute;top:5px;left:calc(50% + 20px);min-width:20px;padding:0 5px;border-radius:10px;background:var(--warn);color:#fff;font-size:12px;line-height:20px;text-align:center}
.notice{margin:10px;padding:10px 12px;border-radius:10px;background:var(--hi);border:1px solid var(--hi-line)}
.empty{padding:20px;text-align:center;color:var(--mute)}
.card{display:block;margin:8px 10px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:inherit;text-decoration:none}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.muted{color:var(--mute);font-size:14px}
.chip{flex:none;display:inline-block;padding:1px 9px;border:1px solid var(--line);border-radius:10px;font-size:13px;font-weight:400;color:var(--mute);white-space:nowrap}
.chip.new{border-color:var(--new);color:var(--new)}
.chip.chg{border-color:#b8860b;color:#6e5000;background:var(--hi)}
.chip.late{border-color:var(--warn);color:var(--warn)}
.chip.ok{border-color:var(--accent);color:var(--accent)}
h2.section{margin:18px 14px 6px;font-size:13px;color:var(--mute);text-transform:uppercase;letter-spacing:.04em}
ul{list-style:none;margin:0;padding:0}form{margin:0}
button,a.button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;min-width:88px;padding:0 14px;
font:inherit;font-weight:600;border:1.5px solid var(--ink);border-radius:10px;background:#fff;color:var(--ink);text-decoration:none}
button.primary,a.button.primary{width:100%;margin-top:10px;min-height:52px;background:var(--accent);border-color:var(--accent);color:#fff;font-size:18px}
button.danger,a.button.danger{border-color:var(--warn);color:var(--warn)}
`;
