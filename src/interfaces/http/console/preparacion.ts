/**
 * Pedidos (wireframes C1 and C2). The list shows every order on the preparation list as one compact
 * card and refreshes on screen; tapping a card opens the order, where the packer ticks lines, marks
 * "No hay", and taps "Listo", which tells the customer. Every button posts one action with the
 * version on screen, its own operation key and the session's CSRF value, so a double tap saves once
 * and a tap on an old version is refused.
 *
 * An order's page looks the order up in the session store's own list. The ID in the address is
 * used for nothing else, so another store's order is simply not there.
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { type ConsoleActionResult, runConsoleAction } from "../../../application/console-actions";
import { dispatchOutbox } from "../../../application/dispatch";
import type { MemberContext } from "../../../application/engine";
import { describeError } from "../../../application/errors";
import type { ActionEnvelope, ConsoleAction, LineMark } from "../../../domain/contract/actions";
import { formatLempiras } from "../../../domain/contract/numbers";
import type { EngineOutcome, OrderLineView, OrderView, PreparationCard } from "../../../domain/contract/outcomes";
import { mapLink } from "../../../domain/place";
import { formatStoreTime } from "../../../domain/store-time";
import { type ConsoleEnv, memberContext } from "./auth";
import { csrfField, shell } from "./layout";

const PATH = "/console/preparacion";
const REFRESH_SECONDS = 15;

/**
 * An order waiting this long since it was confirmed shows how long instead of its state. The
 * wireframe calls it Johan's limit; it becomes a store setting when there is one.
 */
export const LATE_AFTER_MINUTES = 30;

/** What a tap's result tells the person who tapped, by key in the redirect. */
const NOTICES = {
  cambio: "Este pedido cambió. Revisá la versión nueva.",
  estado: "Ese botón ya no aplica. El pedido ya está al día.",
  permiso: "Eso lo confirma el dueño.",
  falta: "Ese pedido ya no está en la lista.",
  guardar: "No se pudo guardar. Revisá el pedido y tocá otra vez.",
} as const;
type NoticeKey = keyof typeof NOTICES;

/** Orders still being packed; the rest of the list is ready and waits to be handed over. */
const PACKING = new Set<OrderView["state"]>(["confirmado", "preparando"]);

const MARK_LABELS: Record<LineMark, string> = { listo: "Listo", no_hay: "No hay", ofrecer_otro: "Otro ofrecido" };

/** An order's own page. */
export function orderPath(orderId: string): string {
  return `${PATH}/${encodeURIComponent(orderId)}`;
}

export function preparacionScreen(app: Hono<ConsoleEnv>) {
  app.get("/preparacion", async (c) => {
    const engine = c.get("runtime").engine;
    if (engine === null) return engineNotReady(c);
    const member = memberContext(c);
    const cards = await engine.preparationList(member);
    // Oldest first, as the engine lists them; orders already packed go below the ones to pack.
    const toPack = cards.filter((card) => PACKING.has(card.order.state));
    const packed = cards.filter((card) => !PACKING.has(card.order.state));
    return c.html(
      shell(c, {
        title: "Pedidos",
        subtitle: `Hoy · ${toPack.length === 0 ? "nada" : toPack.length} por preparar`,
        path: PATH,
        refreshSeconds: REFRESH_SECONDS,
        notice: noticeText(c.req.query("aviso")),
        style: LIST_STYLE,
        body:
          cards.length === 0
            ? html`<p class="empty">No hay pedidos por preparar.</p>`
            : [...toPack, ...packed].map((card) => listCard(card, member.nowMs)),
      }),
    );
  });

  app.get("/preparacion/:orderId", async (c) => {
    const engine = c.get("runtime").engine;
    if (engine === null) return engineNotReady(c);
    const member = memberContext(c);
    const orderId = c.req.param("orderId");
    // Only this store's own list is searched.
    const card = (await engine.preparationList(member)).find((candidate) => candidate.order.orderId === orderId);
    if (card === undefined) return c.redirect(`${PATH}?aviso=falta`, 302);
    return c.html(
      shell(c, {
        title: card.customerName ?? "Cliente sin nombre",
        subtitle: `Versión ${card.order.version} · ${fulfillmentKind(card.order)}`,
        back: PATH,
        path: orderPath(card.order.orderId),
        tab: PATH,
        refreshSeconds: REFRESH_SECONDS,
        notice: noticeText(c.req.query("aviso")),
        style: ORDER_STYLE,
        body: orderPage(card, member.nowMs, c.get("csrf")),
      }),
    );
  });

  app.post("/acciones", async (c) => {
    const { engine, deps } = c.get("runtime");
    if (engine === null) return engineNotReady(c);
    const member = memberContext(c);
    const envelope = parseAction(await c.req.parseBody(), member);
    if (envelope === null) return c.text("Bad request", 400);
    let saved: ConsoleActionResult;
    try {
      saved = await runConsoleAction(deps, engine, member, envelope);
    } catch (error) {
      // Nothing was saved and no message queued: the order shows what holds now.
      deps.log.warn("console_action_not_saved", { businessId: member.businessId, reason: describeError(error) });
      return c.redirect(landing(envelope.action, "guardar"), 303);
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
    return c.redirect(landing(envelope.action, noticeFor(outcome)), 303);
  });
}

function engineNotReady(c: Context<ConsoleEnv>) {
  return c.html(shell(c, { title: "Pedidos", path: PATH, body: html`<p class="empty">La lista de pedidos no está lista todavía.</p>` }), 503);
}

function noticeText(key: string | undefined): string | null {
  return key !== undefined && Object.hasOwn(NOTICES, key) ? NOTICES[key as NoticeKey] : null;
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

/**
 * Where a tap lands: back on its order, to keep packing or to see why it was refused; on the list
 * once the order is handed on (Listo, Entregado) or isn't on the list anymore.
 */
function landing(action: OrderAction, notice: NoticeKey | null): string {
  if (notice === "falta") return `${PATH}?aviso=falta`;
  if (notice === null && (action.type === "mark_ready" || action.type === "mark_delivered")) {
    return `${PATH}#${encodeURIComponent(action.orderId)}`;
  }
  return `${orderPath(action.orderId)}${notice === null ? "" : `?aviso=${notice}`}`;
}

type OrderAction = Extract<ConsoleAction, { type: "start_preparing" | "mark_ready" | "mark_delivered" | "mark_line" }>;

const ORDER_ACTIONS = new Set(["start_preparing", "mark_ready", "mark_delivered"]);
const MARKS = new Set<string>(["listo", "no_hay"]);

/** Builds the action from the form, field by field. Anything unexpected is a 400. */
function parseAction(form: Record<string, unknown>, member: MemberContext): ActionEnvelope<OrderAction> | null {
  const field = (name: string) => (typeof form[name] === "string" ? (form[name] as string) : null);
  const type = field("type");
  const orderId = field("orderId");
  const operationKey = field("operationKey");
  const version = Number(field("version"));
  if (type === null || orderId === null || operationKey === null || !Number.isSafeInteger(version) || version < 1) return null;
  if (orderId.length > 64 || operationKey.length > 64) return null;

  let action: OrderAction;
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
// The list (C1). `html` escapes every interpolated string.

function listCard(card: PreparationCard, nowMs: number) {
  const { order } = card;
  const chip = chipFor(card, nowMs);
  const count = order.lines.length;
  const when = `${card.changedLineIds.length > 0 ? "cambió" : "confirmado"} ${formatStoreTime(card.confirmedAtMs, nowMs)}`;
  return html`<a class="card order${PACKING.has(order.state) ? "" : " packed"}" id="${order.orderId}" href="${orderPath(order.orderId)}">
<span class="row"><strong class="name">${card.customerName ?? "Cliente sin nombre"}</strong><span class="${chip.tone === "" ? "chip" : `chip ${chip.tone}`}">${chip.label}</span></span>
<span class="muted">${count === 1 ? "1 producto" : `${count} productos`} · ${fulfillmentLine(order)} · <span class="when">${when}</span></span>
</a>`;
}

/** The one thing to notice about an order: ready, changed by the customer, waiting too long, or its state. */
export function chipFor(card: PreparationCard, nowMs: number): { readonly label: string; readonly tone: string } {
  if (!PACKING.has(card.order.state)) return { label: "Listo", tone: "ok" };
  if (card.changedLineIds.length > 0) return { label: "Cambió", tone: "chg" };
  const waited = Math.floor((nowMs - card.confirmedAtMs) / 60_000);
  if (waited >= LATE_AFTER_MINUTES) return { label: waitedText(waited), tone: "late" };
  return card.order.state === "confirmado" ? { label: "Nuevo", tone: "new" } : { label: "Preparando", tone: "" };
}

function waitedText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

/** How the order leaves the store, short enough for one card line. */
function fulfillmentLine(order: OrderView): string {
  const f = order.fulfillment;
  if (f?.mode !== "delivery") return fulfillmentKind(order);
  const where = placeOf(f);
  return `Entrega: ${where.length > 40 ? `${where.slice(0, 39)}…` : where}`;
}

// ---------------------------------------------------------------------------------------------
// The order (C2).

function orderPage(card: PreparationCard, nowMs: number, csrf: string) {
  const { order } = card;
  const packing = PACKING.has(order.state);
  const changed = new Set(card.changedLineIds);
  return html`${changed.size === 0 ? "" : html`<p class="notice changed-note">${changeNote(card, changed.size, nowMs)}</p>`}
${order.fulfillment?.mode === "delivery" ? html`<p class="where">${deliveryText(order.fulfillment)}</p>` : ""}
<ul class="card lines">${order.lines.map((line) => lineItem(order, line, packing, changed.has(line.lineId), csrf))}</ul>
<p class="total">${order.total === null ? "Total: falta precio" : `Total ${formatLempiras(order.total)}`}</p>
<div class="actions">${orderActions(card, csrf)}</div>`;
}

/** "Marta Reyes cambió el pedido a las 8:05 a. m. Revisá la línea marcada." */
function changeNote(card: PreparationCard, lines: number, nowMs: number): string {
  const time = formatStoreTime(card.confirmedAtMs, nowMs);
  // Today it reads "a las 8:05 a. m."; an older change already says its day ("ayer 8:05 p. m.").
  const at = /^\d/.test(time) ? `${time.startsWith("1:") ? "a la" : "a las"} ${time}` : time;
  const who = card.customerName === null ? "El pedido cambió" : `${card.customerName} cambió el pedido`;
  // The time already ends in a period ("p. m.").
  const said = `${who} ${at}`;
  return `${said.endsWith(".") ? said : `${said}.`} Revisá ${lines === 1 ? "la línea marcada" : "las líneas marcadas"}.`;
}

function lineItem(order: OrderView, line: OrderLineView, packing: boolean, changed: boolean, csrf: string) {
  const name = line.productName ?? `"${line.text}"`;
  return html`<li class="line${changed ? " changed" : ""}">
${tick(order, line, packing, name, csrf)}
<span class="what">${name} <span class="qty">× ${line.quantity ?? "¿cuántos?"}</span>${changed ? html` <span class="chip chg">Cambió</span>` : ""}${
    line.mark === null || line.mark === "listo" ? "" : html` <span class="chip late">${MARK_LABELS[line.mark]}</span>`
  }</span>
${packing && line.mark === null ? markButton(order, line, "no_hay", html`No hay`, "no_hay", csrf) : ""}
</li>`;
}

/** The packer's own check: a tap marks the line as put in the bag. */
function tick(order: OrderView, line: OrderLineView, packing: boolean, name: string, csrf: string) {
  if (line.mark === "listo") return html`<div class="tick"><span class="box done" role="img" aria-label="Ya está">✓</span></div>`;
  if (!packing || line.mark !== null) return html`<div class="tick"></div>`;
  return html`<div class="tick">${markButton(order, line, "listo", html`<span class="box"></span>`, "check", csrf, `Ya está: ${name}`)}</div>`;
}

function markButton(
  order: OrderView,
  line: OrderLineView,
  mark: LineMark,
  label: unknown,
  kind: string,
  csrf: string,
  ariaLabel?: string,
) {
  return html`<form method="post" action="/console/acciones">
${hidden(order, "mark_line", csrf)}<input type="hidden" name="lineId" value="${line.lineId}"><input type="hidden" name="mark" value="${mark}">
<button class="${kind}"${ariaLabel === undefined ? "" : html` aria-label="${ariaLabel}"`}>${label}</button></form>`;
}

function orderActions(card: PreparationCard, csrf: string) {
  const { order } = card;
  if (PACKING.has(order.state)) {
    const to = card.customerName === null ? "al cliente" : `a ${card.customerName}`;
    return html`${
      order.state === "confirmado"
        ? html`<form method="post" action="/console/acciones">${hidden(order, "start_preparing", csrf)}<button class="wide">Empezar a preparar</button></form>`
        : ""
    }
<p class="hint">Al marcar Listo se le avisa ${to}${order.total === null ? "" : " con el total"}.</p>
<form method="post" action="/console/acciones">${hidden(order, "mark_ready", csrf)}<button class="primary">Listo</button></form>`;
  }
  if (order.state === "listo") {
    const who = card.customerName ?? "el cliente";
    return html`<p class="hint">Ya está listo. Cuando ${who} ya lo tenga, tocá Entregado.</p>
<form method="post" action="/console/acciones">${hidden(order, "mark_delivered", csrf)}<button class="primary">Entregado</button></form>`;
  }
  return "";
}

/** Every form carries the version on screen and a fresh operation key: a double tap sends the same key. */
function hidden(order: OrderView, type: string, csrf: string) {
  return html`<input type="hidden" name="type" value="${type}"><input type="hidden" name="orderId" value="${order.orderId}"><input type="hidden" name="version" value="${order.version}"><input type="hidden" name="operationKey" value="${crypto.randomUUID()}">${csrfField(csrf)}`;
}

function fulfillmentKind(order: OrderView): string {
  const f = order.fulfillment;
  if (f === null) return "Sin decir si recoge o se lo llevan";
  return f.mode === "pickup" ? "Recoge en tienda" : "Entrega a domicilio";
}

type Delivery = Extract<NonNullable<OrderView["fulfillment"]>, { mode: "delivery" }>;

function placeOf(f: Delivery): string {
  return f.placeText ?? ((f.pin ?? null) !== null ? "ubicación compartida" : f.placeId !== null ? "lugar guardado" : "falta la dirección");
}

function deliveryText(f: Delivery) {
  const pin = f.pin ?? null;
  // The link is built from the pin's numbers only; the customer's words are escaped by `html`.
  const map = pin === null ? "" : html` · <a href="${mapLink(pin)}" target="_blank" rel="noopener noreferrer">Ver ubicación</a>`;
  const fee = f.fee !== null && f.fee > 0 ? ` · Envío ${formatLempiras(f.fee)}` : "";
  return html`Entrega: ${placeOf(f)}${map}${fee}`;
}

/** The cards; the header, tabs, notice and chips come from the shared layout. */
const LIST_STYLE = `
.order{padding:12px 14px}
.order .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.order .muted{display:block;margin-top:4px}
.order.packed{opacity:.6}
.when{white-space:nowrap}
`;

const ORDER_STYLE = `
.where{margin:10px 14px;font-size:15px}
.lines{padding:0 12px}
.line{display:flex;align-items:center;gap:6px;min-height:56px;padding:4px 0;border-top:1px solid #eee}
.line:first-child{border-top:0}
.line.changed{margin:0 -12px;padding:4px 12px;background:var(--hi)}
.what{flex:1;min-width:0}.qty{color:var(--mute);white-space:nowrap}
.tick{flex:none;display:flex;align-items:center;justify-content:center;width:48px;min-height:48px;margin-left:-8px}
button.check{width:48px;min-width:48px;padding:0;border:0;background:none}
.box{display:block;width:26px;height:26px;border:2px solid #555;border-radius:6px;background:#fff;color:#fff;font-size:18px;line-height:22px;text-align:center}
.box.done{background:var(--accent);border-color:var(--accent)}
button.no_hay{flex:none;min-width:0;padding:0 12px;font-size:15px}
.total{margin:12px 14px 0;font-size:18px;font-weight:700;text-align:right}
.actions{margin:0 10px 12px}
.hint{margin:14px 4px 0;text-align:center;color:var(--mute);font-size:14px}
button.wide{width:100%;margin-top:10px}
`;
