/**
 * The Orders screen: every order with the colour its facts give it, and, for one order, the trail of
 * facts that explain its state. Both pages sit behind the console's session check and look orders up
 * by id within the member's store; the code is display only.
 *
 * K12: an order with a customer's change waiting shows it (added, removed, changed lines) with
 * Aprobar ✓ / Rechazar ✗, each with a required reason. The answer goes to the engine as one
 * `review_change` action under the key it derives; the engine reads, decides and returns the commits.
 */
import { type Context, type Hono } from "hono";
import { html } from "hono/html";
import { D1OrderTrail, type OrderColour, type OrderListRow, type OrderTrail, type TrailEntry } from "../../../infrastructure/d1/order-trail";
import { REASON_MAX, reviewKey, reviewReason } from "../../../domain/change-request";
import type { ActionEnvelope, ConsoleAction } from "../../../domain/contract/actions";
import type { EngineOutcome, LineDiff, OrderLineView, OrderState } from "../../../domain/contract/outcomes";
import { type ConsoleEnv, memberContext } from "./auth";

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

const DECISION_LABELS = { approve: "Aprobado", decline: "Rechazado" } as const;

/** What answering a change tells the person who answered, by key in the redirect. */
const REVIEW_NOTICES = {
  aprobado: "Cambio aprobado. Le avisamos al cliente.",
  rechazado: "Cambio rechazado. Le avisamos al cliente con tu motivo.",
  motivo: `Escribí un motivo corto (hasta ${REASON_MAX} letras).`,
  estado: "Ese cambio ya no está pendiente. La página ya está al día.",
  falta: "Ese cambio no está en la lista.",
  permiso: "Eso no se puede desde tu cuenta.",
} as const;
type ReviewNotice = keyof typeof REVIEW_NOTICES;

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
    const notice = c.req.query("aviso");
    const shown = notice !== undefined && notice in REVIEW_NOTICES ? REVIEW_NOTICES[notice as ReviewNotice] : null;
    return c.html(page(`Pedido ${trail.code ?? "—"}`, trailBody(trail, c.req.param("orderId"), c.get("csrf"), shown), true));
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

    const { engine, deps } = c.get("runtime");
    if (engine === null) return c.html(page("Pedidos", html`<p class="empty">La lista de pedidos no está lista todavía.</p>`, true), 503);
    const member = memberContext(c);
    const envelope: ActionEnvelope<ConsoleAction> = {
      operationKey: reviewKey(requestId),
      actor: { type: "member", memberId: member.memberId, role: member.role },
      action: { type: "review_change", changeRequestId: requestId, decision, reason },
    };
    // PENDING: the commits run where every console action's do (saveConsoleAction, #63).
    const { outcome } = await engine.onConsoleAction(member, envelope);
    deps.log.info("console_action", { businessId: member.businessId, outcome: outcome.type });
    return back(reviewNoticeFor(outcome, decision));
  });
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

function trailBody(trail: OrderTrail, orderId: string, csrf: string, notice: string | null) {
  const marks = COLOUR_MARKS[trail.cancelled ? "red" : trail.delivered ? "check" : trail.changed ? "yellow" : "none"];
  const names = new Map(trail.facts.map((entry, n) => [entry.factId, `${KIND_LABELS[entry.kind]} (paso ${n + 1})`]));
  return html`${notice === null ? "" : html`<p class="notice">${notice}</p>`}
<p class="meta">${STATE_LABELS[trail.state]} · Versión ${trail.version}${marks === "" ? "" : ` · ${marks}`}</p>
${trail.openRequest === null ? "" : changeBox(trail.openRequest, orderId, csrf)}
<ol class="trail">${trail.facts.map((entry) => trailEntry(entry, names))}</ol>`;
}

const lineText = (line: OrderLineView) => `${line.productName ?? line.text} × ${line.quantity ?? "?"}${line.unit === null ? "" : ` ${line.unit}`}`;

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

function trailEntry(entry: TrailEntry, names: ReadonlyMap<string, string>) {
  const chips = entry.evidence.filter((e) => e.kind in EVIDENCE_LABELS);
  const refs = (ids: readonly string[]) => ids.map((id) => names.get(id) ?? "otro paso").join(", ");
  return html`<li id="${entry.factId}">
<div class="head"><strong>${KIND_LABELS[entry.kind]}</strong><time>${formatTime(entry.recordedAtMs)}</time></div>
<p class="meta">${entry.actor}</p>
${entry.review === null ? "" : html`<p class="review ${entry.review.decision}">${DECISION_LABELS[entry.review.decision]}: ${entry.review.reason}</p>`}
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
.notice{margin:10px 14px;padding:10px;border-radius:8px;background:#fff6d6}
.change{margin:10px 14px;padding:12px;border-radius:10px;background:#fff;border-left:6px solid #f0b400}
.change h2{font-size:16px;margin:0 0 6px}.diff li{padding:2px 0}.diff .added{color:#2f6f45}.diff .removed{color:#b33}
.change form{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.change input[name=motivo]{width:100%;padding:8px;font:inherit;border:1px solid #bbb;border-radius:6px}
.change button{padding:10px;font:inherit;font-weight:600;border:0;border-radius:8px;color:#fff}
.change .approve button{background:#2f6f45}.change .decline button{background:#b33}
.review.decline{color:#b33}
`;
