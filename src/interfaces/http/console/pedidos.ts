/**
 * The Orders screen: every order with the colour its facts give it, and, for one order, the trail of
 * facts that explain its state. Both pages sit behind the console's session check and look orders up
 * by id within the member's store; the code is display only.
 *
 * K12: an order with a customer's change waiting shows it (added, removed, changed lines) with
 * Aprobar ✓ / Rechazar ✗, each with a required reason. The answer goes to the engine as one
 * `review_change` action under the key it derives; the engine reads, decides and returns the commits.
 *
 * K13: a ready delivery order is dispatched from here with a courier picked from the store's active
 * members; out, it shows blue with the courier's name, and is marked delivered from here too.
 */
import { type Context, type Hono } from "hono";
import { html } from "hono/html";
import { type ConsoleActionResult, runConsoleAction } from "../../../application/console-actions";
import { dispatchOutbox } from "../../../application/dispatch";
import { staffKey } from "../../../application/engine/order-engine";
import { describeError } from "../../../application/errors";
import {
  type Courier,
  D1OrderTrail,
  type OrderColour,
  type OrderListRow,
  type OrderTrail,
  type TrailEntry,
} from "../../../infrastructure/d1/order-trail";
import { REASON_MAX, reviewKey, reviewReason } from "../../../domain/change-request";
import { wordsWithoutQuantity } from "../../../domain/orders";
import type { ActionEnvelope, ConsoleAction } from "../../../domain/contract/actions";
import type { EngineOutcome, LineDiff, OrderLineView, OrderState } from "../../../domain/contract/outcomes";
import { type ConsoleEnv, memberContext } from "./auth";

const STATE_LABELS: Record<OrderState, string> = {
  por_confirmar: "Por confirmar",
  confirmado: "Nuevo",
  preparando: "Preparando",
  armando: "Armando",
  listo: "Listo para entregar",
  en_camino: "En camino",
  entregado: "Entregado",
  cancelado: "Cancelado",
};

export const KIND_LABELS: Record<TrailEntry["kind"], string> = {
  order_version: "Pedido recibido",
  order_confirm: "Pedido confirmado",
  order_cancel: "Pedido cancelado",
  order_status: "Cambio de estado",
  change_request: "Cambio pedido por el cliente",
  change_review: "Cambio revisado",
};

const DECISION_LABELS = { approve: "Aprobado", decline: "Rechazado" } as const;

/** What answering a change tells the person who answered, by key in the redirect. */
const REVIEW_NOTICES = {
  aprobado: "Cambio aprobado. Le avisamos al cliente.",
  rechazado: "Cambio rechazado. Le avisamos al cliente con tu motivo.",
  motivo: `Escribí un motivo corto (hasta ${REASON_MAX} letras).`,
  estado: "Ese cambio ya no está pendiente. La página ya está al día.",
  falta: "Ese cambio no está en la lista.",
  permiso: "Eso no se puede desde tu cuenta.",
  guardar: "No se pudo guardar. La página ya está al día; probá otra vez.",
} as const;
type ReviewNotice = keyof typeof REVIEW_NOTICES;

/** What a dispatch or a delivered tap tells the person who tapped (K13). */
const STEP_NOTICES = {
  despachado: "Va en camino. Le avisamos al cliente.",
  entregado: "Pedido entregado.",
  repartidor: "Esa persona no está activa en la tienda. Elegí a otra.",
  paso: "Ese pedido ya cambió. La página ya está al día.",
  sinpedido: "Ese pedido no está en la lista.",
  permiso: "Eso no se puede desde tu cuenta.",
  guardar: "No se pudo guardar. La página ya está al día; probá otra vez.",
} as const;
type StepNotice = keyof typeof STEP_NOTICES;

const NOTICES: Readonly<Record<string, string>> = { ...REVIEW_NOTICES, ...STEP_NOTICES };

/** The steps this screen sends, by the form's `paso`. */
const STEPS = { despachar: "dispatch", entregar: "mark_delivered" } as const;

const COLOUR_MARKS: Record<OrderColour, string> = { yellow: "Cambió", red: "Cancelado", check: "✓ Entregado", blue: "En camino", none: "" };
export const EVIDENCE_LABELS: Record<string, string> = { inbound_message: "mensaje", media_asset: "foto", member: "miembro" };
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
    const reads = new D1OrderTrail(c.env.DB);
    const tenant = { businessId: c.get("member").businessId };
    const trail = await reads.trail(tenant, c.req.param("orderId"));
    if (trail === null) return notFound(c);
    const notice = c.req.query("aviso");
    const shown = notice !== undefined && Object.hasOwn(NOTICES, notice) ? NOTICES[notice]! : null;
    const members = trail.state === "listo" && trail.fulfillment === "delivery" ? await reads.activeMembers(tenant) : [];
    return c.html(page(`Pedido ${trail.code ?? "—"}`, trailBody(trail, c.req.param("orderId"), c.get("csrf"), shown, members), true));
  });

  app.post("/pedidos/:orderId/paso", async (c) => {
    const orderId = c.req.param("orderId");
    const back = (notice: StepNotice) => c.redirect(`/console/pedidos/${encodeURIComponent(orderId)}?aviso=${notice}`, 303);
    const form = await c.req.parseBody();
    const paso = typeof form["paso"] === "string" && Object.hasOwn(STEPS, form["paso"]) ? STEPS[form["paso"] as keyof typeof STEPS] : null;
    const version = typeof form["version"] === "string" && /^[1-9][0-9]{0,5}$/.test(form["version"]) ? Number(form["version"]) : null;
    const courierMemberId = typeof form["repartidor"] === "string" && form["repartidor"].length <= 64 ? form["repartidor"] : null;
    if (orderId.length > 64 || paso === null || version === null || (paso === "dispatch" && courierMemberId === null)) {
      return c.text("Bad request", 400);
    }

    const { engine } = c.get("runtime");
    if (engine === null) return c.html(page("Pedidos", html`<p class="empty">La lista de pedidos no está lista todavía.</p>`, true), 503);
    const member = memberContext(c);
    const action =
      paso === "dispatch"
        ? ({ type: "dispatch", orderId, version, courierMemberId: courierMemberId! } as const)
        : ({ type: "mark_delivered", orderId, version } as const);
    const envelope: ActionEnvelope<ConsoleAction> = {
      operationKey: staffKey(action),
      actor: { type: "member", memberId: member.memberId, role: member.role },
      action,
    };
    const outcome = await saveAndSend(c, envelope);
    return back(outcome === null ? "guardar" : stepNoticeFor(outcome, paso));
  });

  app.post("/pedidos/:orderId/revision", async (c) => {
    const orderId = c.req.param("orderId");
    const back = (notice: ReviewNotice) => c.redirect(`/console/pedidos/${encodeURIComponent(orderId)}?aviso=${notice}`, 303);
    const form = await c.req.parseBody();
    const requestId = typeof form["cambio"] === "string" ? form["cambio"] : null;
    const decision = form["decision"] === "approve" || form["decision"] === "decline" ? form["decision"] : null;
    if (requestId === null || requestId.length > 64 || decision === null) return c.text("Bad request", 400);
    // Checked here so the person gets the field's message; the engine checks it again.
    const reason = reviewReason(form["motivo"]);
    if (reason === null) return back("motivo");

    const { engine } = c.get("runtime");
    if (engine === null) return c.html(page("Pedidos", html`<p class="empty">La lista de pedidos no está lista todavía.</p>`, true), 503);
    const member = memberContext(c);
    const envelope: ActionEnvelope<ConsoleAction> = {
      operationKey: reviewKey(requestId),
      actor: { type: "member", memberId: member.memberId, role: member.role },
      action: { type: "review_change", changeRequestId: requestId, decision, reason },
    };
    const outcome = await saveAndSend(c, envelope);
    return back(outcome === null ? "guardar" : reviewNoticeFor(outcome, decision));
  });
}

/**
 * Saves the tap the way every console action is saved (#63) and sends the customer's notice after
 * the response; the cron sweep retries what doesn't go. Null when the save was refused: nothing saved.
 */
async function saveAndSend(c: Context<ConsoleEnv>, envelope: ActionEnvelope<ConsoleAction>): Promise<EngineOutcome | null> {
  const { engine, deps } = c.get("runtime");
  const member = memberContext(c);
  let saved: ConsoleActionResult;
  try {
    saved = await runConsoleAction(deps, engine!, member, envelope);
  } catch (error) {
    deps.log.warn("console_action_not_saved", { businessId: member.businessId, reason: describeError(error) });
    return null;
  }
  deps.log.info("console_action", { businessId: member.businessId, outcome: saved.outcome.type, count: saved.dispatch.length });
  for (const conversation of saved.dispatch) {
    c.executionCtx.waitUntil(
      dispatchOutbox(deps, { limit: 10, conversation }).catch((error: unknown) => {
        deps.log.error("outbox_dispatch_failed", { ...conversation, reason: describeError(error) });
      }),
    );
  }
  return saved.outcome;
}

function reviewNoticeFor(outcome: EngineOutcome, decision: "approve" | "decline"): ReviewNotice {
  // A second tap answers with the first: the screen reports the answer that was saved.
  const answered = outcome.type === "duplicate" ? outcome.first : outcome;
  if (answered.type !== "rejected") {
    const saved = answered.type === "action_saved" ? (answered.order?.lastReview?.decision ?? decision) : decision;
    return saved === "approve" ? "aprobado" : "rechazado";
  }
  switch (answered.reason) {
    case "not_found":
      return "falta";
    case "not_allowed":
      return "permiso";
    default:
      return "estado";
  }
}

function stepNoticeFor(outcome: EngineOutcome, paso: "dispatch" | "mark_delivered"): StepNotice {
  // A second tap answers with the first: the screen reports the step that was saved.
  const answered = outcome.type === "duplicate" ? outcome.first : outcome;
  if (answered.type !== "rejected") return paso === "dispatch" ? "despachado" : "entregado";
  switch (answered.reason) {
    case "not_found":
      // The order resolved (the outcome carries it): what wasn't found is the courier.
      return answered.order === null ? "sinpedido" : "repartidor";
    case "not_allowed":
      return "permiso";
    default:
      return "paso";
  }
}

function notFound(c: Context<ConsoleEnv>) {
  return c.html(page("Pedidos", html`<p class="empty">Ese pedido no está en la lista.</p>`, true), 404);
}

function orderRow(row: OrderListRow) {
  return html`<li class="order ${row.colour}"><a href="/console/pedidos/${encodeURIComponent(row.orderId)}">
<div class="head"><strong>${row.code ?? "—"}</strong><span>${COLOUR_MARKS[row.colour]}</span></div>
<p class="meta">${row.customerLabel} · ${STATE_LABELS[row.state]}${row.courier === null ? "" : ` · Lo lleva ${courierName(row.courier)}`}</p>
<p>${row.lines.map((line) => `${line.text} × ${line.quantity ?? "?"}`).join(", ")}</p>
</a></li>`;
}

const courierName = (courier: Courier) => courier.name ?? "Sin nombre";

function trailBody(trail: OrderTrail, orderId: string, csrf: string, notice: string | null, members: readonly Courier[]) {
  const colour = trail.cancelled ? "red" : trail.delivered ? "check" : trail.changed ? "yellow" : trail.dispatched ? "blue" : "none";
  const marks = COLOUR_MARKS[colour];
  const names = new Map(trail.facts.map((entry, n) => [entry.factId, `${KIND_LABELS[entry.kind]} (paso ${n + 1})`]));
  return html`${notice === null ? "" : html`<p class="notice">${notice}</p>`}
<p class="meta">${STATE_LABELS[trail.state]} · Versión ${trail.version}${marks === "" ? "" : ` · ${marks}`}</p>
<p class="meta"><a href="/console/deed/${encodeURIComponent(orderId)}">Ver en Deed</a> · <a href="/console/deed/${encodeURIComponent(orderId)}/libro">Ver libro</a></p>
${trail.courier === null || trail.delivered ? "" : html`<p class="meta">Lo lleva ${courierName(trail.courier)}</p>`}
${trail.openRequest === null ? "" : changeBox(trail.openRequest, orderId, csrf)}
${stepBox(trail, orderId, csrf, members)}
<ol class="trail">${trail.facts.map((entry) => trailEntry(entry, names))}</ol>`;
}

const lineText = (line: OrderLineView) => `${line.productName ?? wordsWithoutQuantity(line.text, line.quantity)} × ${line.quantity ?? "?"}${line.unit === null ? "" : ` ${line.unit}`}`;

/** The change waiting for review: what it adds, removes and changes, and the two answers. */
function changeBox(request: { readonly id: string; readonly diff: LineDiff }, orderId: string, csrf: string) {
  const { added, removed, changed } = request.diff;
  const action = `/console/pedidos/${encodeURIComponent(orderId)}/revision`;
  const answer = (decision: "approve" | "decline", label: string) => html`<form method="post" action="${action}" class="${decision}">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="cambio" value="${request.id}">
<input type="hidden" name="decision" value="${decision}">
<label>Motivo<input name="motivo" required maxlength="${REASON_MAX}" autocomplete="off"></label>
<button type="submit">${label}</button>
</form>`;
  return html`<section class="change">
<h2>El cliente pidió un cambio</h2>
<ul class="diff">
${added.map((line) => html`<li class="added">Agregar: ${lineText(line)}</li>`)}
${removed.map((line) => html`<li class="removed">Quitar: ${lineText(line)}</li>`)}
${changed.map(({ before, after }) => html`<li class="changed">Cambiar: ${lineText(before)} → ${lineText(after)}</li>`)}
${added.length + removed.length + changed.length === 0 ? html`<li>Cambia la entrega, no los productos.</li>` : ""}
</ul>
${answer("approve", "Aprobar ✓")}
${answer("decline", "Rechazar ✗")}
</section>`;
}

/**
 * K13: the next step out the door. A ready delivery order is dispatched with a courier; once out, or
 * ready for pickup, it is marked delivered. With no fulfillment recorded, it can't be dispatched: the
 * screen says why, and staff can still say the customer has it, which closes the order with it left unknown.
 */
function stepBox(trail: OrderTrail, orderId: string, csrf: string, members: readonly Courier[]) {
  if (trail.cancelled || trail.delivered) return "";
  const action = `/console/pedidos/${encodeURIComponent(orderId)}/paso`;
  const hidden = (paso: keyof typeof STEPS) => html`<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="paso" value="${paso}"><input type="hidden" name="version" value="${trail.version}">`;
  if (trail.state === "listo" && trail.fulfillment === null) {
    return html`<p class="notice">Falta saber si lo recogen o se lo llevamos. Preguntale al cliente.</p>
<section class="step"><form method="post" action="${action}">${hidden("entregar")}
<button type="submit">Ya lo tiene el cliente ✓</button>
</form></section>`;
  }
  if (trail.state === "listo" && trail.fulfillment === "delivery") {
    return html`<section class="step"><form method="post" action="${action}">${hidden("despachar")}
<label>¿Quién lo lleva?<select name="repartidor" required>
${members.map((m) => html`<option value="${m.memberId}">${courierName(m)}</option>`)}
</select></label>
<button type="submit">Mandar en camino</button>
</form></section>`;
  }
  if (trail.state === "en_camino" || (trail.state === "listo" && trail.fulfillment === "pickup")) {
    return html`<section class="step"><form method="post" action="${action}">${hidden("entregar")}
<button type="submit">Entregado ✓</button>
</form></section>`;
  }
  return "";
}

function trailEntry(entry: TrailEntry, names: ReadonlyMap<string, string>) {
  const chips = entry.evidence.filter((e) => e.kind in EVIDENCE_LABELS);
  const refs = (ids: readonly string[]) => ids.map((id) => names.get(id) ?? "otro paso").join(", ");
  return html`<li id="${entry.factId}">
<div class="head"><strong>${KIND_LABELS[entry.kind]}</strong><time>${formatTime(entry.recordedAtMs)}</time></div>
<p class="meta">${entry.actor}${entry.agentId === null ? "" : ` · agente ${entry.agentId}`}</p>
${entry.courier === null ? "" : html`<p class="courier">En camino con ${courierName(entry.courier)}</p>`}
${entry.review === null ? "" : html`<p class="review ${entry.review.decision}">${DECISION_LABELS[entry.review.decision]}: ${entry.review.reason}</p>`}
${chips.length === 0 ? "" : html`<p>${chips.map((e) => html`<span class="chip">${EVIDENCE_LABELS[e.kind]}</span>`)}</p>`}
${entry.closedBy === null ? "" : html`<p class="closed">cerrado por <a href="#${entry.closedBy.factId}">${refs([entry.closedBy.factId])}</a> (${CLOSURE_LABELS[entry.closedBy.reason]})</p>`}
${entry.dependsOn.length === 0 ? "" : html`<p class="meta">Depende de: ${refs(entry.dependsOn)}</p>`}
${entry.blocks.length === 0 ? "" : html`<p class="meta">Bloquea: ${refs(entry.blocks)}</p>`}
</li>`;
}

/** Honduras time (UTC−6, no daylight saving), day/month and 24-hour clock. */
export function formatTime(ms: number): string {
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
.orders .blue{border-left-color:#2563c9}.courier{color:#2563c9;font-weight:600}
.step{margin:10px 14px;padding:12px;border-radius:10px;background:#fff;border-left:6px solid #2563c9}
.step form{display:flex;flex-direction:column;gap:6px}.step select{width:100%;padding:8px;font:inherit;border:1px solid #bbb;border-radius:6px}
.step button{padding:10px;font:inherit;font-weight:600;border:0;border-radius:8px;color:#fff;background:#2563c9}
.head{display:flex;justify-content:space-between;gap:8px}
.trail{margin:10px 14px;border-left:3px solid #2f6f45}.trail li{margin:0 0 12px 12px;padding:10px;border-radius:8px;background:#fff}
.chip{font-size:12px;background:#e3efe6;padding:1px 8px;border-radius:10px;margin-right:4px}
.closed{color:#b33;font-weight:600}.closed a{color:#b33}
.notice{margin:10px 14px;padding:10px;border-radius:8px;background:#fff6d6}
.change{margin:10px 14px;padding:12px;border-radius:10px;background:#fff;border-left:6px solid #f0b400}
.change h2{font-size:16px;margin:0 0 6px}.diff li{padding:2px 0}.diff .added{color:#2f6f45}.diff .removed{color:#b33}
.change form{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.change input[name=motivo]{width:100%;padding:8px;font:inherit;border:1px solid #bbb;border-radius:6px}
.change button{padding:10px;font:inherit;font-weight:600;border:0;border-radius:8px;color:#fff}
.change .approve button{background:#2f6f45}.change .decline button{background:#b33}
.review.decline{color:#b33}
`;
