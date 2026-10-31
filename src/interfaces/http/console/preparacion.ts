/**
 * The preparation list: every order to pack, refreshed every few seconds. Every button posts one
 * action with the version on screen, its own operation key and the session's CSRF value, so a
 * double tap saves once.
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { type ConsoleActionResult, runConsoleAction } from "../../../application/console-actions";
import { dispatchOutbox } from "../../../application/dispatch";
import type { MemberContext } from "../../../application/engine";
import { describeError } from "../../../application/errors";
import type { ActionEnvelope, ConsoleAction, LineMark } from "../../../domain/contract/actions";
import { formatLempiras } from "../../../domain/contract/numbers";
import { mapLink } from "../../../domain/place";
import type { EngineOutcome, OrderLineView, OrderView, PreparationCard } from "../../../domain/contract/outcomes";
import { type ConsoleEnv, memberContext } from "./auth";
import { csrfField, shell } from "./layout";

const PATH = "/console/preparacion";
const REFRESH_SECONDS = 15;

/** What a tap's result tells the person who tapped, by key in the redirect. */
const NOTICES = {
  cambio: "Este pedido cambió. Revisá la versión nueva.",
  estado: "Ese botón ya no aplica. La lista ya está al día.",
  permiso: "Eso lo confirma el dueño.",
  falta: "Ese pedido ya no está en la lista.",
  guardar: "No se pudo guardar. Revisá el pedido y tocá otra vez.",
} as const;
type NoticeKey = keyof typeof NOTICES;

const STATE_LABELS: Partial<Record<OrderView["state"], string>> = {
  confirmado: "Nuevo",
  preparando: "Preparando",
  listo: "Listo para entregar",
};

const MARK_LABELS: Record<LineMark, string> = { listo: "Listo", no_hay: "No hay", ofrecer_otro: "Otro ofrecido" };

export function preparacionScreen(app: Hono<ConsoleEnv>) {
  app.get("/preparacion", async (c) => {
    const engine = c.get("runtime").engine;
    if (engine === null) return engineNotReady(c);
    const cards = await engine.preparationList(memberContext(c));
    const notice = c.req.query("aviso");
    const csrf = c.get("csrf");
    return c.html(
      shell(c, {
        title: "Pedidos por preparar",
        path: PATH,
        refreshSeconds: REFRESH_SECONDS,
        notice: notice !== undefined && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as NoticeKey] : null,
        style: STYLE,
        body:
          cards.length === 0
            ? html`<p class="empty">No hay pedidos por preparar.</p>`
            : cards.map((card, n) => orderCard(card, n + 1, csrf)),
      }),
    );
  });

  app.post("/acciones", async (c) => {
    const { engine, deps } = c.get("runtime");
    if (engine === null) return engineNotReady(c);
    const member = memberContext(c);
    const envelope = parseAction(await c.req.parseBody(), member);
    if (envelope === null) return c.text("Bad request", 400);
    const anchor = "orderId" in envelope.action ? `#${envelope.action.orderId}` : "";
    let saved: ConsoleActionResult;
    try {
      saved = await runConsoleAction(deps, engine, member, envelope);
    } catch (error) {
      // Nothing was saved and no message queued: the list shows what holds now.
      deps.log.warn("console_action_not_saved", { businessId: member.businessId, reason: describeError(error) });
      return c.redirect(`${PATH}?aviso=guardar${anchor}`, 303);
    }
    const { outcome, dispatch } = saved;
    deps.log.info("console_action", { businessId: member.businessId, outcome: outcome.type, count: dispatch.length });
    // The customer's message goes out after the response; the cron sweep retries what doesn't.
    for (const conversation of dispatch) {
      c.executionCtx.waitUntil(
        dispatchOutbox(deps, { limit: 10, conversation }).catch((error: unknown) => {
          deps.log.error("outbox_dispatch_failed", { ...conversation, reason: describeError(error) });
        }),
      );
    }
    const notice = noticeFor(outcome);
    return c.redirect(`${PATH}${notice === null ? "" : `?aviso=${notice}`}${anchor}`, 303);
  });
}

function engineNotReady(c: Context<ConsoleEnv>) {
  return c.html(shell(c, { title: "Pedidos por preparar", path: PATH, body: html`<p class="empty">La lista de pedidos no está lista todavía.</p>` }), 503);
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
  return html`<input type="hidden" name="type" value="${type}"><input type="hidden" name="orderId" value="${order.orderId}"><input type="hidden" name="version" value="${order.version}"><input type="hidden" name="operationKey" value="${crypto.randomUUID()}">${csrfField(csrf)}`;
}

function fulfillmentText(order: OrderView) {
  const f = order.fulfillment;
  if (f === null) return "Sin definir";
  if (f.mode === "pickup") return "Para recoger";
  const pin = f.pin ?? null;
  // The link is built from the pin's numbers only; the customer's words are escaped by `html`.
  const map = pin === null ? "" : html` · <a href="${mapLink(pin)}" target="_blank" rel="noopener noreferrer">Ver ubicación</a>`;
  const where = f.placeText ?? (pin !== null ? "ubicación compartida" : f.placeId !== null ? "lugar guardado" : "falta la dirección");
  const fee = f.fee !== null && f.fee > 0 ? ` · Envío ${formatLempiras(f.fee)}` : "";
  return html`Para llevar: ${where}${map}${fee}`;
}

/** The order cards; the header, tabs, notice and buttons come from the shared layout. */
const STYLE = `
.order{margin:10px;padding:12px;border-radius:10px;background:#fff;border-left:6px solid #2f6f45}
.order.listo{border-left-color:#999;opacity:.85}
.head{display:flex;justify-content:space-between;gap:8px}.state{font-size:14px;color:#2f6f45}
.meta{margin:4px 0 8px;font-size:14px;color:#555}
li{padding:8px 0;border-top:1px solid #eee}
li.changed{background:#fff8e1}.line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
em{font-style:normal;font-size:12px;background:#f0b400;color:#000;padding:1px 6px;border-radius:4px}
.mark{font-size:13px;padding:1px 6px;border-radius:4px;background:#e3efe6}.mark.no_hay{background:#f8d7da}
.buttons{display:flex;gap:8px;margin-top:6px}
button.listo{border-color:#2f6f45}button.no_hay{border-color:#b33}
.total{font-weight:600;margin:8px 0 0}
`;
