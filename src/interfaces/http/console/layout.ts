/**
 * The console's shared layout for a 360 px phone screen: a header with the screen's title, the
 * navigation, an optional notice, then the screen's own content. Every screen renders through
 * `shell`; login pages, which have no session, use `simplePage`.
 *
 * To add a screen: write `<name>.ts` next to this file exporting a function that registers its
 * routes, call it in `index.ts`, and add its tab to `NAV` below if it belongs in the navigation.
 */
import type { Context } from "hono";
import { html } from "hono/html";
import type { ConsoleEnv } from "./auth";

interface NavEntry {
  readonly path: string;
  readonly label: string;
  readonly ownerOnly: boolean;
}

/** The navigation tabs, in order. Owner-only tabs are hidden from staff (the routes refuse them too). */
export const NAV: readonly NavEntry[] = [
  { path: "/console/preparacion", label: "Pedidos", ownerOnly: false },
  { path: "/console/empleados", label: "Empleados", ownerOnly: true },
];

export interface ScreenPage {
  readonly title: string;
  /** The tab to highlight; a path from `NAV`. */
  readonly path: string;
  readonly body: unknown;
  readonly notice?: string | null;
  /** Reloads the page every so many seconds (the preparation list). */
  readonly refreshSeconds?: number;
  /** Extra CSS for this screen only. */
  readonly style?: string;
}

/** Renders a screen inside the shared layout, with the tabs this member may open. */
export function shell(c: Context<ConsoleEnv>, screen: ScreenPage) {
  const isOwner = c.get("member").role === "owner";
  const tabs = NAV.filter((tab) => isOwner || !tab.ownerOnly);
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
<header><h1>${screen.title}</h1><a class="refresh" href="${screen.path}">Actualizar</a></header>
<nav>${tabs.map((tab) => html`<a href="${tab.path}"${tab.path === screen.path ? html` aria-current="page"` : ""}>${tab.label}</a>`)}</nav>
<main>
${screen.notice === undefined || screen.notice === null ? "" : html`<p class="notice" role="status">${screen.notice}</p>`}
${screen.body}
</main>
</body>
</html>`;
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

const BASE_STYLE = `
*{box-sizing:border-box}body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#f4f4f2;color:#1b1b1b}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#1f3d2b;color:#fff}
h1{font-size:18px;margin:0}.refresh{color:#fff}
nav{display:flex;background:#fff;border-bottom:1px solid #ddd}
nav a{flex:1;text-align:center;padding:12px 4px;color:#1f3d2b;text-decoration:none;font-weight:600}
nav a[aria-current=page]{border-bottom:3px solid #2f6f45}
.notice{margin:10px;padding:10px;border-radius:8px;background:#fff3cd;border:1px solid #e0c060}
.empty{padding:20px;text-align:center;color:#666}
.card{margin:10px;padding:12px;border-radius:10px;background:#fff}
ul{list-style:none;margin:0;padding:0}form{margin:0}
button{min-height:44px;min-width:88px;font-size:16px;border-radius:8px;border:1px solid #888;background:#fff}
button.primary{width:100%;margin-top:10px;background:#2f6f45;color:#fff;border:0}
button.danger{border-color:#b33;color:#b33}
`;
