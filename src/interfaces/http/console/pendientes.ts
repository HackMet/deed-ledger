/**
 * Pendientes (wireframe C5, owner only): everything that needs the owner, grouped, so he isn't
 * interrupted message by message. Today: what the customer side raises (a customer asked for a
 * person, a question got "te confirmo", a late reply, a notice that couldn't go out, a reply the
 * claim check stopped). Each card shows what the customer wrote; "Responder" sends the owner's
 * answer to their chat and takes the item off the list, "Listo" only takes it off. The engine's
 * items (prices, payments) join once contract gap (c) is agreed.
 *
 * Also the words customers used for a product in a confirmed order (learned aliases, D-49):
 * "¿«catsup» es Salsa de tomate Naturas 400 g?" Sí makes the assistant recognize them next time;
 * No drops them. One tap each.
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { dispatchOutbox } from "../../../application/dispatch";
import { describeError } from "../../../application/errors";
import { OWNER_REPLY_MAX_CHARS, replyFromPendientes } from "../../../application/owner-reply";
import type { OpenPendiente } from "../../../application/ports";
import type { ProposedAlias } from "../../../infrastructure/d1/retrieval-repository";
import { formatStoreTime } from "../../../domain/store-time";
import { type ConsoleEnv, requireOwner } from "./auth";
import { approvals, inboxCards } from "./inbox";
import { csrfField, INICIO_PATH, shell } from "./layout";

const PATH = "/console/pendientes";

const NOTICES = {
  listo: "Listo, ya no aparece en la lista.",
  falta: "Ese pendiente ya no estaba en la lista.",
  respondido: "Listo, le mandamos tu respuesta.",
  ventana: "Tu respuesta queda lista, pero WhatsApp no deja mandarla hasta que el cliente vuelva a escribir. Llamale si es urgente.",
  vacio: "Escribí la respuesta antes de tocar Responder.",
  largo: `La respuesta es muy larga: máximo ${OWNER_REPLY_MAX_CHARS} caracteres.`,
  nombre_si: "Listo. La próxima vez el asistente lo reconoce.",
  nombre_no: "Listo. El asistente no va a usar ese nombre.",
} as const;
type NoticeKey = keyof typeof NOTICES;

/** The groups, in the order the owner reads them: someone waiting now comes first. */
const GROUPS: readonly { readonly kind: OpenPendiente["kind"]; readonly title: string }[] = [
  { kind: "slow_reply", title: "Esperando respuesta" },
  { kind: "customer_handoff", title: "Piden hablar con vos" },
  { kind: "customer_question", title: "Preguntas por confirmar" },
  { kind: "notice_waiting_window", title: "Avisos que no salieron" },
  { kind: "claim_blocked", title: "Respuestas detenidas" },
];

export function pendientesScreen(app: Hono<ConsoleEnv>) {
  app.get("/pendientes", requireOwner, async (c) => {
    const { deps, retrieval } = c.get("runtime");
    const [items, names, waiting] = await Promise.all([
      deps.pendientesBoard.listOpen(c.get("member")),
      retrieval.listProposed(c.get("member")),
      approvals(c),
    ]);
    // Change requests and invoices are answered on their own pages; here they are links. Unread: none shown.
    const toApprove = waiting ?? [];
    const notice = c.req.query("aviso");
    const nowMs = deps.clock.now();
    const csrf = c.get("csrf");
    const groups = GROUPS.map((group) => ({ ...group, items: items.filter((item) => item.kind === group.kind) })).filter(
      (group) => group.items.length > 0,
    );
    return c.html(
      shell(c, {
        title: "Pendientes",
        subtitle: "Lo que solo vos decidís",
        path: PATH,
        // Reached from the bell and the Inicio card, so Inicio lights.
        tab: INICIO_PATH,
        notice: notice !== undefined && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as NoticeKey] : null,
        style: STYLE,
        body:
          groups.length === 0 && names.length === 0 && toApprove.length === 0
            ? html`<section class="card"><p class="empty">No hay nada pendiente.</p>
<p class="hint">Aquí aparecen los clientes que piden hablar con vos, las preguntas que quedaron en «te confirmo», los mensajes que no salieron, y los cambios y facturas por aprobar.</p></section>`
            : html`${toApprove.length === 0 ? "" : html`<h2 class="section">Para aprobar (${toApprove.length})</h2>
${inboxCards(toApprove)}`}${groups.map(
                (group) => html`<h2 class="section">${group.title} (${group.items.length})</h2>
${group.items.map((item) => card(item, nowMs, csrf))}`,
              )}${names.length === 0 ? "" : html`<h2 class="section">Cómo piden los clientes (${names.length})</h2>
${names.map((name) => nameCard(name, nowMs, csrf))}`}`,
      }),
    );
  });

  app.post("/pendientes/responder", requireOwner, async (c) => {
    const { deps } = c.get("runtime");
    const form = await c.req.parseBody();
    const id = form["pendiente"];
    const text = form["respuesta"];
    if (typeof id !== "string" || id.length === 0 || id.length > 100 || typeof text !== "string" || text.length > 4 * OWNER_REPLY_MAX_CHARS) {
      return back(c, "falta");
    }
    const result = await replyFromPendientes(deps, c.get("member"), id, text);
    if (result.status === "not_found") return back(c, "falta");
    if (result.status === "empty") return back(c, "vacio");
    if (result.status === "too_long") return back(c, "largo");
    if (result.status === "sent") {
      // Sent after the response; the cron sweep retries what doesn't go out now.
      c.executionCtx.waitUntil(
        dispatchOutbox(deps, { limit: 10, conversation: result.conversation }).catch((error: unknown) => {
          deps.log.error("outbox_dispatch_failed", { ...result.conversation, reason: describeError(error) });
        }),
      );
    }
    return back(c, result.status === "sent" ? "respondido" : "ventana");
  });

  app.post("/pendientes/nombre", requireOwner, async (c) => {
    const { deps, retrieval } = c.get("runtime");
    const form = await c.req.parseBody();
    const id = form["nombre"];
    const answer = form["respuesta"];
    if (typeof id !== "string" || id.length === 0 || id.length > 100 || (answer !== "si" && answer !== "no")) return back(c, "falta");
    const member = c.get("member");
    const nowMs = deps.clock.now();
    const decided =
      answer === "si" ? await retrieval.approveAlias(member, id, member.userId, nowMs) : await retrieval.rejectAlias(member, id, member.userId, nowMs);
    if (!decided) return back(c, "falta");
    return back(c, answer === "si" ? "nombre_si" : "nombre_no");
  });

  app.post("/pendientes/listo", requireOwner, async (c) => {
    const { deps } = c.get("runtime");
    const id = (await c.req.parseBody())["pendiente"];
    if (typeof id !== "string" || id.length === 0 || id.length > 100) return back(c, "falta");
    const member = c.get("member");
    const done = await deps.pendientesBoard.markDone(member, id, member.userId, deps.clock.now());
    return back(c, done ? "listo" : "falta");
  });
}

function back(c: Context<ConsoleEnv>, notice: NoticeKey) {
  return c.redirect(`${PATH}?aviso=${notice}`, 303);
}

function card(item: OpenPendiente, nowMs: number, csrf: string) {
  return html`<article class="card pendiente">
<div class="row"><strong class="name">${item.customerName ?? "Cliente sin nombre"}</strong>${item.urgent ? html`<span class="chip late">urgente</span>` : ""}</div>
<p class="muted">${formatStoreTime(item.raisedAtMs, nowMs)}${item.phoneEnding === null ? "" : html` · Su número termina en ${item.phoneEnding}`}</p>
<p>${whatHappened(item)}</p>
${item.said == null ? "" : html`<blockquote class="said">«${item.said}»</blockquote>`}
${answerable(item) ? html`<form method="post" action="${PATH}/responder" class="answer">${csrfField(csrf)}<input type="hidden" name="pendiente" value="${item.id}">
<label>Tu respuesta <small>(le llega por WhatsApp con tu nombre)</small><textarea name="respuesta" rows="2" maxlength="${OWNER_REPLY_MAX_CHARS}" placeholder="Sí hay, a L 65"></textarea></label>
<button class="primary">Responder</button></form>` : ""}
<form method="post" action="${PATH}/listo">${csrfField(csrf)}<input type="hidden" name="pendiente" value="${item.id}"><button>Resuelto</button></form>
</article>`;
}

/** One tap: the customer's words are that product, or they aren't. */
function nameCard(name: ProposedAlias, nowMs: number, csrf: string) {
  return html`<article class="card pendiente">
<p class="ask"><strong>¿«${name.said}» es ${name.productName}?</strong></p>
<p class="muted">${formatStoreTime(name.proposedAtMs, nowMs)} · Un cliente lo pidió así en un pedido que confirmó. Si es lo mismo, el asistente lo va a reconocer la próxima vez.</p>
<form method="post" action="${PATH}/nombre" class="yes-no">${csrfField(csrf)}<input type="hidden" name="nombre" value="${name.id}">
<button class="primary" name="respuesta" value="si">Sí</button><button name="respuesta" value="no">No</button></form>
</article>`;
}

/** Items where the customer waits for a person's answer, in a conversation we can write to. */
function answerable(item: OpenPendiente): boolean {
  if (item.conversationId == null) return false;
  return item.kind === "customer_question" || item.kind === "customer_handoff" || item.kind === "slow_reply" || item.kind === "claim_blocked";
}

/** What happened, in words the owner reads cold. The codes stay in the code. */
export function whatHappened(item: Pick<OpenPendiente, "kind" | "detail" | "count">): string {
  const many = item.count !== null && item.count > 1 ? item.count : null;
  switch (item.kind) {
    case "slow_reply":
      return "Lleva más de dos minutos esperando respuesta. Ya le avisamos que lo estamos revisando.";
    case "customer_handoff":
      return "Pidió hablar con alguien de la tienda.";
    case "customer_question":
      if (item.detail === "price") {
        return many === null ? "Preguntó un precio que no está confirmado. Le dijimos que le confirmamos." : `Preguntó ${many} precios que no están confirmados. Le dijimos que le confirmamos.`;
      }
      if (item.detail === "availability") {
        return many === null ? "Preguntó si hay un producto y no lo sabemos. Le dijimos que le confirmamos." : `Preguntó si hay ${many} productos y no lo sabemos. Le dijimos que le confirmamos.`;
      }
      if (item.detail === "order_prices") {
        return many === null
          ? "Confirmó un pedido con un producto sin precio. Le dijimos que le confirmamos el precio."
          : `Confirmó un pedido con ${many} productos sin precio. Le dijimos que le confirmamos los precios.`;
      }
      return "Preguntó el horario y no está puesto. Le dijimos que le confirmamos.";
    case "notice_waiting_window":
      return item.detail === "order_ready"
        ? "Su pedido está listo, pero WhatsApp no deja avisarle hasta que vuelva a escribir. Llamale."
        : "Un aviso no pudo salir: WhatsApp no deja escribirle hasta que vuelva a escribir. Llamale.";
    case "claim_blocked":
      return "Una respuesta no salió porque un dato cambió antes de enviarla. Revisá su conversación.";
  }
}

/** The cards, chips and section titles come from the shared layout. */
const STYLE = `
.pendiente p{margin:6px 0}.pendiente .muted{margin-top:2px}
.pendiente .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px;font-weight:800}
.pendiente form{display:flex;justify-content:flex-end;margin-top:10px}
.pendiente form.answer{display:block;margin-top:10px}.pendiente form.answer textarea{width:100%;box-sizing:border-box}
.pendiente form.answer button{margin-top:8px;width:100%}
.pendiente .said{margin:8px 0;padding:8px 12px;border-left:3px solid #d8bb72;border-radius:0 10px 10px 0;background:#f3efdf;color:var(--ink);overflow-wrap:anywhere}
.hint{font-size:15px;color:var(--mute)}
.pendiente .ask{font-size:18px;font-weight:700;overflow-wrap:anywhere}
.pendiente form.yes-no{gap:8px}.pendiente form.yes-no button{flex:1}
.inbox{position:relative;padding-right:52px}.inbox strong{display:block;font-size:18px}.inbox .muted{display:block;margin-top:2px}
.inbox .go{position:absolute;right:18px;top:50%;transform:translateY(-50%);font-size:28px;color:var(--ink)}
.inbox.change{border-left:5px solid #e0a030}.inbox.invoice{border-left:5px solid var(--green)}
`;
