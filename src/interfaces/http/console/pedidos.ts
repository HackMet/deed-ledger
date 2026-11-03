/**
 * The Orders screen: every order with the colour its facts give it, and, for one order, the trail of
 * facts that explain its state. Read-only. Both pages sit behind the console's session check and
 * look orders up by id within the member's store; the code is display only.
 */
import { type Context, type Hono } from "hono";
import { html } from "hono/html";
import { D1OrderTrail, type OrderColour, type OrderListRow, type OrderTrail, type TrailEntry } from "../../../infrastructure/d1/order-trail";
import type { OrderState } from "../../../domain/contract/outcomes";
import type { ConsoleEnv } from "./auth";

const STATE_LABELS: Record<OrderState, string> = {
  por_confirmar: "Por confirmar",
  confirmado: "Nuevo",
  preparando: "Preparando",
  armando: "Armando",
  listo: "Listo para entregar",
  entregado: "Entregado",
  cancelado: "Cancelado",
};

const KIND_LABELS: Record<TrailEntry["kind"], string> = {
  order_version: "Pedido recibido",
  order_confirm: "Pedido confirmado",
  order_cancel: "Pedido cancelado",
  order_status: "Cambio de estado",
  change_request: "Cambio pedido por el cliente",
  change_review: "Cambio revisado",
};

const COLOUR_MARKS: Record<OrderColour, string> = { yellow: "Cambió", red: "Cancelado", check: "✓ Entregado", none: "" };
const EVIDENCE_LABELS: Record<string, string> = { inbound_message: "mensaje", media_asset: "foto", member: "miembro" };
const CLOSURE_LABELS = { cancelled: "cancelado", superseded: "reemplazado" } as const;

export function pedidosScreen(app: Hono<ConsoleEnv>) {
  app.get("/pedidos", async (c) => {
    const rows = await new D1OrderTrail(c.env.DB).listOrders({ businessId: c.get("member").businessId });
    return c.html(
      page(
        "Pedidos",
        rows.length === 0 ? html`<p class="empty">Todavía no hay pedidos.</p>` : html`<ul class="orders">${rows.map(orderRow)}</ul>`,
      ),
    );
  });

  app.get("/pedidos/:orderId", async (c) => {
    const trail = await new D1OrderTrail(c.env.DB).trail({ businessId: c.get("member").businessId }, c.req.param("orderId"));
    if (trail === null) return notFound(c);
    return c.html(page(`Pedido ${trail.code ?? "—"}`, trailBody(trail), true));
  });
}

function notFound(c: Context<ConsoleEnv>) {
  return c.html(page("Pedidos", html`<p class="empty">Ese pedido no está en la lista.</p>`, true), 404);
}

function orderRow(row: OrderListRow) {
  return html`<li class="order ${row.colour}"><a href="/console/pedidos/${encodeURIComponent(row.orderId)}">
<div class="head"><strong>${row.code ?? "—"}</strong><span>${COLOUR_MARKS[row.colour]}</span></div>
<p class="meta">${row.customerLabel} · ${STATE_LABELS[row.state]}</p>
<p>${row.lines.map((line) => `${line.text} × ${line.quantity ?? "?"}`).join(", ")}</p>
</a></li>`;
}

function trailBody(trail: OrderTrail) {
  const marks = COLOUR_MARKS[trail.cancelled ? "red" : trail.delivered ? "check" : trail.changed ? "yellow" : "none"];
  const names = new Map(trail.facts.map((entry, n) => [entry.factId, `${KIND_LABELS[entry.kind]} (paso ${n + 1})`]));
  return html`<p class="meta">${STATE_LABELS[trail.state]} · Versión ${trail.version}${marks === "" ? "" : ` · ${marks}`}</p>
<ol class="trail">${trail.facts.map((entry) => trailEntry(entry, names))}</ol>`;
}

function trailEntry(entry: TrailEntry, names: ReadonlyMap<string, string>) {
  const chips = entry.evidence.filter((e) => e.kind in EVIDENCE_LABELS);
  const refs = (ids: readonly string[]) => ids.map((id) => names.get(id) ?? "otro paso").join(", ");
  return html`<li id="${entry.factId}">
<div class="head"><strong>${KIND_LABELS[entry.kind]}</strong><time>${formatTime(entry.recordedAtMs)}</time></div>
<p class="meta">${entry.actor}</p>
${chips.length === 0 ? "" : html`<p>${chips.map((e) => html`<span class="chip">${EVIDENCE_LABELS[e.kind]}</span>`)}</p>`}
${entry.closedBy === null ? "" : html`<p class="closed">cerrado por <a href="#${entry.closedBy.factId}">${refs([entry.closedBy.factId])}</a> (${CLOSURE_LABELS[entry.closedBy.reason]})</p>`}
${entry.dependsOn.length === 0 ? "" : html`<p class="meta">Depende de: ${refs(entry.dependsOn)}</p>`}
${entry.blocks.length === 0 ? "" : html`<p class="meta">Bloquea: ${refs(entry.blocks)}</p>`}
</li>`;
}

/** Honduras time (UTC−6, no daylight saving), day/month and 24-hour clock. */
function formatTime(ms: number): string {
  const d = new Date(ms - 6 * 3_600_000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

function page(title: string, body: unknown, back = false) {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>${title}</h1>${back ? html`<a href="/console/pedidos">Todos</a>` : html`<a href="/console/preparacion">Preparación</a>`}</header>
${body}
</body>
</html>`;
}

const STYLE = `
*{box-sizing:border-box}body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#f4f4f2;color:#1b1b1b}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#1f3d2b;color:#fff}
h1{font-size:18px;margin:0}header a{color:#fff}
ul,ol{list-style:none;margin:0;padding:0}p{margin:4px 0}.meta{font-size:14px;color:#555}.empty{padding:20px;text-align:center;color:#666}
.orders li{margin:10px;border-radius:10px;background:#fff;border-left:6px solid #bbb}
.orders li a{display:block;padding:12px;color:inherit;text-decoration:none}
.orders .yellow{border-left-color:#f0b400}.orders .red{border-left-color:#b33}.orders .check{border-left-color:#2f6f45}
.head{display:flex;justify-content:space-between;gap:8px}
.trail{margin:10px 14px;border-left:3px solid #2f6f45}.trail li{margin:0 0 12px 12px;padding:10px;border-radius:8px;background:#fff}
.chip{font-size:12px;background:#e3efe6;padding:1px 8px;border-radius:10px;margin-right:4px}
.closed{color:#b33;font-weight:600}.closed a{color:#b33}
`;
