/**
 * The staff console: server-rendered pages for a 360 px Android screen. For now only the
 * preparation list, and only in dev mode (no login yet: a fixed demo store and staff member). The
 * list refreshes itself every few seconds; every button posts one action with its own operation key,
 * so a double tap saves once.
 */
import { Hono } from "hono";
import { html } from "hono/html";
import type { MemberContext } from "../../application/engine";
import type { ActionEnvelope, ConsoleAction, LineMark } from "../../domain/contract/actions";
import { formatLempiras } from "../../domain/contract/numbers";
import type { EngineOutcome, OrderLineView, OrderView, PreparationCard } from "../../domain/contract/outcomes";
import type { HttpEnv } from "./env";

const REFRESH_SECONDS = 15;
const DEV_STORE = "dev-store";
const DEV_MEMBER = "dev-staff";

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
  const app = new Hono<HttpEnv>();

  app.use("*", async (c, next) => {
    const { config, engine } = c.get("runtime");
    if (!config.devConsole || engine === null) return c.text("Not found", 404);
    await next();
  });

  app.get("/", (c) => c.redirect("/console/preparacion", 302));

  app.get("/preparacion", async (c) => {
    const { engine, deps } = c.get("runtime");
    const cards = await engine!.preparationList(devMember(deps.clock.now()));
    const notice = c.req.query("aviso");
    return c.html(page(cards, notice !== undefined && notice in NOTICES ? NOTICES[notice as NoticeKey] : null));
  });

  app.post("/acciones", async (c) => {
    const { engine, deps } = c.get("runtime");
    const member = devMember(deps.clock.now());
    const envelope = parseAction(await c.req.parseBody(), member);
    if (envelope === null) return c.text("Bad request", 400);
    const { outcome } = await engine!.onConsoleAction(member, envelope);
    deps.log.info("console_action", { businessId: member.businessId, outcome: outcome.type });
    const notice = noticeFor(outcome);
    const anchor = "orderId" in envelope.action ? `#${envelope.action.orderId}` : "";
    return c.redirect(`/console/preparacion${notice === null ? "" : `?aviso=${notice}`}${anchor}`, 303);
  });

  return app;
}

function devMember(nowMs: number): MemberContext {
  return { businessId: DEV_STORE, memberId: DEV_MEMBER, role: "staff", canApproveFiado: false, nowMs };
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

function page(cards: readonly PreparationCard[], notice: string | null) {
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
${cards.length === 0 ? html`<p class="empty">No hay pedidos por preparar.</p>` : cards.map((card, n) => orderCard(card, n + 1))}
</body>
</html>`;
}

function orderCard(card: PreparationCard, position: number) {
  const { order } = card;
  const packing = order.state === "confirmado" || order.state === "preparando";
  const changed = new Set(card.changedLineIds);
  return html`<section class="order ${order.state}" id="${order.orderId}">
<div class="head"><strong>${position}. ${card.customerName ?? "Cliente sin nombre"}</strong><span class="state">${STATE_LABELS[order.state] ?? ""}</span></div>
<p class="meta">${fulfillmentText(order)} · Versión ${order.version}</p>
<ul>${order.lines.map((line) => lineItem(order, line, packing, changed.has(line.lineId)))}</ul>
<p class="total">${order.total === null ? "Total: falta precio" : `Total ${formatLempiras(order.total)}`}</p>
${orderButton(order)}
</section>`;
}

function lineItem(order: OrderView, line: OrderLineView, packing: boolean, changed: boolean) {
  const name = line.productName ?? `"${line.text}"`;
  return html`<li class="${changed ? "changed" : ""}">
<div class="line"><span>${name} × ${line.quantity ?? "?"}</span>${changed ? html`<em>Cambió</em>` : ""}${line.mark === null ? "" : html`<b class="mark ${line.mark}">${MARK_LABELS[line.mark]}</b>`}</div>
${packing && line.mark === null ? html`<div class="buttons">${markButton(order, line, "listo", "Listo")}${markButton(order, line, "no_hay", "No hay")}</div>` : ""}
</li>`;
}

function markButton(order: OrderView, line: OrderLineView, mark: LineMark, label: string) {
  return html`<form method="post" action="/console/acciones">
${hidden(order, "mark_line")}<input type="hidden" name="lineId" value="${line.lineId}"><input type="hidden" name="mark" value="${mark}">
<button class="${mark}">${label}</button></form>`;
}

function orderButton(order: OrderView) {
  const next =
    order.state === "confirmado"
      ? (["start_preparing", "Empezar"] as const)
      : order.state === "preparando"
        ? (["mark_ready", "Pedido listo"] as const)
        : order.state === "listo"
          ? (["mark_delivered", "Entregado"] as const)
          : null;
  if (next === null) return "";
  return html`<form method="post" action="/console/acciones">${hidden(order, next[0])}<button class="primary">${next[1]}</button></form>`;
}

/** Every form carries the version on screen and a fresh operation key: a double tap sends the same key. */
function hidden(order: OrderView, type: string) {
  return html`<input type="hidden" name="type" value="${type}"><input type="hidden" name="orderId" value="${order.orderId}"><input type="hidden" name="version" value="${order.version}"><input type="hidden" name="operationKey" value="${crypto.randomUUID()}">`;
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
