/**
 * Replies to customers about their orders, rendered from engine outcomes by code. Honduran Spanish,
 * one decision per message, never blaming the customer. A stopgap for the no-model path (#16): the
 * replies component and the claim check replace it.
 */
import { formatLempiras } from "./contract/numbers";
import type { EngineOutcome, OrderView, QuestionCode } from "./contract/outcomes";
import type { ReadbackWord } from "./burst";

export const ORDER_CONFIRMED = "Listo, ya está en la lista de preparación. Te aviso cuando esté listo.";
export const ORDER_CANCELLED = "Listo, cancelé tu pedido.";
export const WHAT_TO_CORRECT = "Va. Decime qué le cambiamos al pedido.";
export const ASK_NAME = "¿A nombre de quién lo anoto?";
export const ORDER_NOT_OPEN = "Ese pedido ya no está abierto. Si querés algo más, mandame tu pedido y lo anoto.";
export const HANDOFF = "Le aviso a la tienda para que te atiendan.";
export const OUT_OF_SCOPE = "Te ayudo con pedidos de la tienda. ¿Qué te mando?";
export const READBACK_CHANGED = "Tu pedido cambió. Así quedó:";
/** A typed answer that crossed a newer readback: nothing is confirmed until they answer that one. */
export const ANSWER_NEW_READBACK = "Tu pedido cambió. Revisá cómo quedó arriba y respondé Confirmar, Corregir o Cancelar.";

const READBACK_QUESTION = "¿Está bien así? Respondé Confirmar, Corregir o Cancelar.";

/** The readback: every line before the customer confirms, and the total only when every price is known. */
export function renderReadback(order: OrderView): string {
  const lines = order.lines.map((line, n) => {
    const name = line.productName ?? line.text;
    const quantity = line.quantity === null ? "" : `: ${line.quantity}`;
    const restricted = line.restricted ? " (solo en tienda)" : "";
    return `${n + 1}. ${name}${quantity}${restricted}`;
  });
  const parts = ["Tu pedido:", ...lines];
  const fulfillment =
    order.fulfillment === null
      ? null
      : order.fulfillment.mode === "pickup"
        ? "Lo recogés en la tienda."
        : "Te lo llevamos.";
  const total = order.total === null ? null : `Total: ${formatLempiras(order.total)}`;
  const closing = [fulfillment, total].filter((part) => part !== null).join(" ");
  if (closing !== "") parts.push(closing);
  parts.push(READBACK_QUESTION);
  return parts.join("\n");
}

function question(code: QuestionCode, order: OrderView | null, line: number | null): string {
  const named = line === null ? null : (order?.lines[line]?.productName ?? order?.lines[line]?.text ?? null);
  switch (code) {
    case "customer_name":
      return ASK_NAME;
    case "pickup_or_delivery":
      return "¿Lo recogés en la tienda o te lo llevamos?";
    case "delivery_place":
      return "¿A dónde te lo llevamos? Podés mandarme la ubicación o decirme el lugar.";
    case "same_place":
      return "¿Te lo llevamos al mismo lugar de siempre?";
    case "quantity":
      return named === null ? "¿Cuántos querés?" : `¿Cuántos querés de ${named}?`;
    case "ambiguous_size":
      return named === null ? "¿De qué tamaño lo querés?" : `¿De qué tamaño querés ${named}?`;
    case "ambiguous_product":
      return named === null ? "¿Cuál me decís?" : `¿Cuál ${named} querés?`;
    case "illegible":
      return named === null ? "No alcancé a leer una parte. ¿Me la escribís?" : `No alcancé a leer "${named}". ¿Me lo escribís?`;
    case "embedded_instructions":
      return "¿Qué te anoto?";
  }
}

function orderState(order: OrderView): string {
  switch (order.state) {
    case "confirmado":
    case "preparando":
      return "Tu pedido ya está en la lista de preparación. Te aviso cuando esté listo.";
    case "listo":
      return "Tu pedido ya está listo.";
    case "entregado":
    case "cancelado":
      return ORDER_NOT_OPEN;
    case "armando":
    case "por_confirmar":
      return renderReadback(order);
  }
}

/**
 * The reply for an outcome, or null when nothing should be said (a repeated tap, nothing to do).
 * `answered` is the readback word the customer used, when the outcome answers one.
 */
export function renderOrderOutcome(outcome: EngineOutcome, answered: ReadbackWord | null = null): string | null {
  switch (outcome.type) {
    case "readback":
      return renderReadback(outcome.order);
    case "order_changed":
      return renderReadback(outcome.order);
    case "order_confirmed":
      return ORDER_CONFIRMED;
    case "order_cancelled":
      return ORDER_CANCELLED;
    case "ask":
      return question(outcome.question, outcome.order, outcome.line);
    case "order_status":
      return outcome.order === null ? ORDER_NOT_OPEN : orderState(outcome.order);
    case "rejected":
      if (outcome.order === null) return ORDER_NOT_OPEN;
      if (outcome.reason === "stale_version" && (outcome.order.state === "por_confirmar" || outcome.order.state === "armando")) {
        return `${READBACK_CHANGED}\n${renderReadback(outcome.order)}`;
      }
      return orderState(outcome.order);
    case "handoff":
      return HANDOFF;
    case "out_of_scope":
      return OUT_OF_SCOPE;
    case "nothing":
      return answered === "correct" ? WHAT_TO_CORRECT : null;
    case "duplicate":
      return null;
    case "answer":
    case "balance":
    case "payment_claimed":
    case "stopped":
    case "action_saved":
      // Not reachable without perception (#17); the replies component renders these.
      return null;
  }
}

/** The order a reply shows as a readback, so a typed "confirmar" answers that version. */
export function readbackShown(outcome: EngineOutcome): OrderView | null {
  switch (outcome.type) {
    case "readback":
    case "order_changed":
      return outcome.order;
    case "order_status":
      return outcome.order !== null && (outcome.order.state === "por_confirmar" || outcome.order.state === "armando")
        ? outcome.order
        : null;
    case "rejected":
      return outcome.order !== null && (outcome.order.state === "por_confirmar" || outcome.order.state === "armando")
        ? outcome.order
        : null;
    default:
      return null;
  }
}
