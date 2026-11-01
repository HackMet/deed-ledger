/**
 * Pendientes (wireframe C5, owner only): everything that needs the owner, grouped, so he isn't
 * interrupted message by message. Today: what the customer side raises (a customer asked for a
 * person, a question got "te confirmo", a late reply, a notice that couldn't go out, a reply the
 * claim check stopped). "Listo" takes an item off the list. The engine's items (prices, payments)
 * join once contract gap (c) is agreed.
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import type { OpenPendiente } from "../../../application/ports";
import { formatStoreTime } from "../../../domain/store-time";
import { type ConsoleEnv, requireOwner } from "./auth";
import { csrfField, shell } from "./layout";

const PATH = "/console/pendientes";

const NOTICES = {
  listo: "Listo, ya no aparece en la lista.",
  falta: "Ese pendiente ya no estaba en la lista.",
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
    const { deps } = c.get("runtime");
    const items = await deps.pendientesBoard.listOpen(c.get("member"));
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
        notice: notice !== undefined && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as NoticeKey] : null,
        style: STYLE,
        body:
          groups.length === 0
            ? html`<section class="card"><p class="empty">No hay nada pendiente.</p>
<p class="hint">Aquí aparecen los clientes que piden hablar con vos, las preguntas que quedaron en «te confirmo» y los mensajes que no salieron.</p></section>`
            : groups.map(
                (group) => html`<h2 class="section">${group.title} (${group.items.length})</h2>
${group.items.map((item) => card(item, nowMs, csrf))}`,
              ),
      }),
    );
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
<form method="post" action="${PATH}/listo">${csrfField(csrf)}<input type="hidden" name="pendiente" value="${item.id}"><button>Listo</button></form>
</article>`;
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
.pendiente .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pendiente form{display:flex;justify-content:flex-end}
.hint{font-size:14px;color:var(--mute)}
`;
