/**
 * The staff console: server-rendered pages for a 360 px Android screen, behind the login in
 * `console/auth.ts`. The list refreshes itself every few seconds; every button posts one action with
 * its own operation key and the session's CSRF value, so a double tap saves once.
 */
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import type { MemberContext } from "../../application/engine";
import type { ActionEnvelope, ConsoleAction, LineMark } from "../../domain/contract/actions";
import { formatLempiras } from "../../domain/contract/numbers";
import type { EngineOutcome, OrderLineView, OrderView, PreparationCard } from "../../domain/contract/outcomes";
import {
  type ConsoleEnv,
  memberContext,
  registerEntryRoutes,
  requireCsrf,
  requireMember,
  requireOwner,
  sameSiteForms,
  simplePage,
} from "./console/auth";
import { negocioScreen } from "./console/negocio";
import { pedidosScreen } from "./console/pedidos";
import { productosScreen } from "./console/productos";

const REFRESH_SECONDS = 15;

/** What a tap's result tells the person who tapped, by key in the redirect. */
const NOTICES = {
  cambio: "Este pedido cambió. Revisá la versión nueva.",
  estado: "Ese botón ya no aplica. La lista ya está al día.",
  permiso: "Eso lo confirma el dueño.",
  falta: "Ese pedido ya no está en la lista.",
} as const;
type NoticeKey = keyof typeof NOTICES;

const STATE_LABELS: Partial<Record<OrderView["state"], string>> = {
  confirmado: "Nuevo",
  preparando: "Preparando",
  listo: "Listo para entregar",
};

const MARK_LABELS: Record<LineMark, string> = { listo: "Listo", no_hay: "No hay", ofrecer_otro: "Otro ofrecido" };

export function consoleRoutes() {
  const app = new Hono<ConsoleEnv>();

  app.use("*", sameSiteForms);
  registerEntryRoutes(app);
  app.use("*", requireMember);
  app.use("*", requireCsrf);

  app.get("/", (c) => c.redirect("/console/preparacion", 302));

  app.get("/preparacion", async (c) => {
    const engine = c.get("runtime").engine;
    if (engine === null) return engineNotReady(c);
    const cards = await engine.preparationList(memberContext(c));
    const notice = c.req.query("aviso");
    return c.html(page(cards, notice !== undefined && notice in NOTICES ? NOTICES[notice as NoticeKey] : null, c.get("csrf")));
  });

  pedidosScreen(app);
  productosScreen(app);
  negocioScreen(app);

  app.post("/acciones", async (c) => {
    const { engine, deps } = c.get("runtime");
    if (engine === null) return engineNotReady(c);
    const member = memberContext(c);
    const envelope = parseAction(await c.req.parseBody(), member);
    if (envelope === null) return c.text("Bad request", 400);
    const { outcome } = await engine.onConsoleAction(member, envelope);
    deps.log.info("console_action", { businessId: member.businessId, outcome: outcome.type });
    const notice = noticeFor(outcome);
    const anchor = "orderId" in envelope.action ? `#${envelope.action.orderId}` : "";
    return c.redirect(`/console/preparacion${notice === null ? "" : `?aviso=${notice}`}${anchor}`, 303);
  });

  app.get("/empleados", requireOwner, async (c) => {
    const { deps } = c.get("runtime");
    const members = await deps.consoleAuth.listMembers(c.get("member"));
    return c.html(
      simplePage(
        "Empleados",
        html`<ul>${members.map(
          (m) => html`<li>${m.displayName ?? "Sin nombre"} · ${m.role === "owner" ? "Dueño" : "Empleado"}${m.active ? "" : " · quitado"}</li>`,
        )}</ul>`,
      ),
    );
  });

  return app;
}

function engineNotReady(c: Context<ConsoleEnv>) {
  return c.html(simplePage("Consola", html`<p>La lista de pedidos no está lista todavía.</p>`), 503);
}

function noticeFor(outcome: EngineOutcome): NoticeKey | null {
  if (outcome.type !== "rejected") return null;
  switch (outcome.reason) {
    case "stale_version":
      return "cambio";
    case "invalid_state":
      return "estado";
    case "not_allowed":
      return "permiso";
    case "not_found":
      return "falta";
  }
}

const ORDER_ACTIONS = new Set(["start_preparing", "mark_ready", "mark_delivered"]);
const MARKS = new Set<string>(["listo", "no_hay"]);

/** Builds the action from the form, field by field. Anything unexpected is a 400. */
function parseAction(form: Record<string, unknown>, member: MemberContext): ActionEnvelope<ConsoleAction> | null {
  const field = (name: string) => (typeof form[name] === "string" ? (form[name] as string) : null);
  const type = field("type");
  const orderId = field("orderId");
  const operationKey = field("operationKey");
  const version = Number(field("version"));
  if (type === null || orderId === null || operationKey === null || !Number.isSafeInteger(version) || version < 1) return null;
  if (orderId.length > 64 || operationKey.length > 64) return null;

  let action: ConsoleAction;
  if (ORDER_ACTIONS.has(type)) {
    action = { type: type as "start_preparing" | "mark_ready" | "mark_delivered", orderId, version };
  } else if (type === "mark_line") {
    const lineId = field("lineId");
    const mark = field("mark");
    if (lineId === null || lineId.length > 64 || mark === null || !MARKS.has(mark)) return null;
    action = { type, orderId, version, lineId, mark: mark as LineMark, substituteProductId: null };
  } else {
    return null;
  }
  return { operationKey, actor: { type: "member", memberId: member.memberId, role: member.role }, action };
}

// ---------------------------------------------------------------------------------------------
// Rendering. `html` escapes every interpolated string.

function page(cards: readonly PreparationCard[], notice: string | null, csrf: string) {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SECONDS};url=/console/preparacion">
<title>Pedidos por preparar</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>Pedidos por preparar</h1><a class="refresh" href="/console/preparacion">Actualizar</a></header>
${notice === null ? "" : html`<p class="notice" role="status">${notice}</p>`}
${cards.length === 0 ? html`<p class="empty">No hay pedidos por preparar.</p>` : cards.map((card, n) => orderCard(card, n + 1, csrf))}
</body>
</html>`;
}

function orderCard(card: PreparationCard, position: number, csrf: string) {
  const { order } = card;
  const packing = order.state === "confirmado" || order.state === "preparando";
  const changed = new Set(card.changedLineIds);
  return html`<section class="order ${order.state}" id="${order.orderId}">
<div class="head"><strong>${position}. ${card.customerName ?? "Cliente sin nombre"}</strong><span class="state">${STATE_LABELS[order.state] ?? ""}</span></div>
<p class="meta">${fulfillmentText(order)} · Versión ${order.version}</p>
<ul>${order.lines.map((line) => lineItem(order, line, packing, changed.has(line.lineId), csrf))}</ul>
<p class="total">${order.total === null ? "Total: falta precio" : `Total ${formatLempiras(order.total)}`}</p>
${orderButton(order, csrf)}
</section>`;
}

function lineItem(order: OrderView, line: OrderLineView, packing: boolean, changed: boolean, csrf: string) {
  const name = line.productName ?? `"${line.text}"`;
  return html`<li class="${changed ? "changed" : ""}">
<div class="line"><span>${name} × ${line.quantity ?? "?"}</span>${changed ? html`<em>Cambió</em>` : ""}${line.mark === null ? "" : html`<b class="mark ${line.mark}">${MARK_LABELS[line.mark]}</b>`}</div>
${packing && line.mark === null ? html`<div class="buttons">${markButton(order, line, "listo", "Listo", csrf)}${markButton(order, line, "no_hay", "No hay", csrf)}</div>` : ""}
</li>`;
}

function markButton(order: OrderView, line: OrderLineView, mark: LineMark, label: string, csrf: string) {
  return html`<form method="post" action="/console/acciones">
${hidden(order, "mark_line", csrf)}<input type="hidden" name="lineId" value="${line.lineId}"><input type="hidden" name="mark" value="${mark}">
<button class="${mark}">${label}</button></form>`;
}

function orderButton(order: OrderView, csrf: string) {
  const next =
    order.state === "confirmado"
      ? (["start_preparing", "Empezar"] as const)
      : order.state === "preparando"
        ? (["mark_ready", "Pedido listo"] as const)
        : order.state === "listo"
          ? (["mark_delivered", "Entregado"] as const)
          : null;
  if (next === null) return "";
  return html`<form method="post" action="/console/acciones">${hidden(order, next[0], csrf)}<button class="primary">${next[1]}</button></form>`;
}

/** Every form carries the version on screen and a fresh operation key: a double tap sends the same key. */
function hidden(order: OrderView, type: string, csrf: string) {
  return html`<input type="hidden" name="type" value="${type}"><input type="hidden" name="orderId" value="${order.orderId}"><input type="hidden" name="version" value="${order.version}"><input type="hidden" name="operationKey" value="${crypto.randomUUID()}"><input type="hidden" name="csrf" value="${csrf}">`;
}

function fulfillmentText(order: OrderView): string {
  if (order.fulfillment === null) return "Sin definir";
  if (order.fulfillment.mode === "pickup") return "Para recoger";
  return `Para llevar: ${order.fulfillment.placeText ?? "lugar guardado"}`;
}

const STYLE = `
*{box-sizing:border-box}body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#f4f4f2;color:#1b1b1b}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#1f3d2b;color:#fff}
h1{font-size:18px;margin:0}.refresh{color:#fff}
.notice{margin:10px;padding:10px;border-radius:8px;background:#fff3cd;border:1px solid #e0c060}
.empty{padding:20px;text-align:center;color:#666}
.order{margin:10px;padding:12px;border-radius:10px;background:#fff;border-left:6px solid #2f6f45}
.order.listo{border-left-color:#999;opacity:.85}
.head{display:flex;justify-content:space-between;gap:8px}.state{font-size:14px;color:#2f6f45}
.meta{margin:4px 0 8px;font-size:14px;color:#555}
ul{list-style:none;margin:0;padding:0}li{padding:8px 0;border-top:1px solid #eee}
li.changed{background:#fff8e1}.line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
em{font-style:normal;font-size:12px;background:#f0b400;color:#000;padding:1px 6px;border-radius:4px}
.mark{font-size:13px;padding:1px 6px;border-radius:4px;background:#e3efe6}.mark.no_hay{background:#f8d7da}
.buttons{display:flex;gap:8px;margin-top:6px}form{margin:0}
button{min-height:44px;min-width:88px;font-size:16px;border-radius:8px;border:1px solid #888;background:#fff}
button.listo{border-color:#2f6f45}button.no_hay{border-color:#b33}
button.primary{width:100%;margin-top:10px;background:#2f6f45;color:#fff;border:0}
.total{font-weight:600;margin:8px 0 0}
`;
