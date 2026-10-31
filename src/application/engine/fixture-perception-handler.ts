/**
 * Fixture perception adapter: replaced by the teammate's perception when it lands (D-37).
 *
 * SCAFFOLDING, not a product feature. The order engine wants a `BurstReading` (observations already
 * interpreted) and a job carries only a raw message; the component that bridges them is perception,
 * Angel's half of D-37, which does not exist yet. Until it does, this handler recognises a few
 * Spanish words in a text message and answers with the matching reading from the contract fixtures
 * (test/fixtures/contract.ts). It reads nothing from the message beyond which words were said: no
 * quantities, no product names, no ids. Anything it cannot read falls through to the placeholder.
 *
 * Owner of the replacement: Angel (perception). Replacement date: when perception lands, before the
 * Saturday gate can be called met. The engine does not import this file and knows nothing of fixtures.
 */
import { firstOrder, firstOrderMatches, moreSugar } from "../../../test/fixtures/contract";
import type { ActionEnvelope, CustomerAction } from "../../domain/contract/actions";
import type { EngineOutcome, OrderView, QuestionCode } from "../../domain/contract/outcomes";
import { PLACEHOLDER_TTL_MS } from "../../domain/outbox";
import type { CustomerContext, Engine, EngineResult } from "../engine";
import { placeholderHandler } from "../placeholder-handler";
import type { Clock, JobHandler, JobInput, JobOutcome, Tenant } from "../ports";
import { actionKey, type StoredOrder } from "./order-engine";

/** The customer's own open order, from our records: the only source of an order id and version. */
export interface OpenOrderReader {
  openOrder(tenant: Tenant, customerId: string): Promise<StoredOrder | null>;
}

/** Replies about an order stay worth sending for the same hour as the placeholder's. */
const REPLY_TTL_MS = PLACEHOLDER_TTL_MS;

type Intent = "confirm" | "cancel" | "change" | "order";

/** The words, normalised: lowercase, no accents, trimmed, no closing punctuation. */
function words(body: string): string {
  return body
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s.!¡¿?]+$/u, "")
    .replace(/^[\s.!¡¿?]+/u, "");
}

function intentOf(body: string): Intent | null {
  const text = words(body);
  if (text === "confirmar" || text === "confirmo") return "confirm";
  if (text === "cancelar" || text === "cancela") return "cancel";
  if (/\b(mejor|que sean)\b/u.test(text)) return "change";
  if (/\b(pedido|quiero|necesito)\b/u.test(text)) return "order";
  return null;
}

export function fixturePerceptionHandler(deps: {
  readonly engine: Engine;
  readonly orders: OpenOrderReader;
  readonly clock: Clock;
}): JobHandler {
  return {
    async handle(input: JobInput): Promise<JobOutcome> {
      const { lease, job, isNewestOfBurst } = input;
      const intent = job.kind === "text" && job.textBody !== null ? intentOf(job.textBody) : null;
      // Photos, voice notes, buttons and words we cannot read are not guessed at.
      if (intent === null) return placeholderHandler.handle(input);

      const context: CustomerContext = {
        businessId: lease.businessId,
        conversationId: lease.conversationId,
        // The conversation IS the customer for a WhatsApp thread, written here and nowhere else. A real
        // customers table replaces this mapping. Never an id from the message body, the model or a button.
        customerId: lease.conversationId,
        jobId: job.id,
        nowMs: deps.clock.now(),
      };

      let result: EngineResult;
      if (intent === "order" || intent === "change") {
        // The fixture matches name fixture product ids; the engine ignores any that this store lacks.
        result = await deps.engine.onBurst(context, intent === "order" ? firstOrder : moreSugar, firstOrderMatches);
      } else {
        const open = await deps.orders.openOrder(context, context.customerId);
        if (open === null) return reply(isNewestOfBurst, NO_OPEN_ORDER, []);
        const { orderId, version } = open.view;
        const action: CustomerAction =
          intent === "confirm" ? { type: "confirm_order", orderId, version } : { type: "cancel_order", orderId, version };
        const envelope: ActionEnvelope<CustomerAction> = {
          operationKey: actionKey(action as Extract<CustomerAction, { type: "confirm_order" | "cancel_order" }>),
          actor: { type: "customer", customerId: context.customerId },
          action,
        };
        result = await deps.engine.onCustomerAction(context, envelope);
      }
      return reply(isNewestOfBurst, render(result.outcome), result.commits);
    },
  };
}

function reply(isNewestOfBurst: boolean, body: string, commits: EngineResult["commits"]): JobOutcome {
  return {
    replies: isNewestOfBurst ? [{ body, ttlMs: REPLY_TTL_MS, closesBurst: true }] : [],
    commits,
  };
}

// ---------------------------------------------------------------------------------------------
// Replies: Honduran Spanish, short, one decision, never a score.

const NO_OPEN_ORDER = "No tengo un pedido abierto tuyo. Mandame lo que necesitás.";
const CONFIRM_PROMPT = "¿Lo confirmo? Confirmar / Corregir / Cancelar";

const money = (centavos: number): string => `L ${(centavos / 100).toFixed(2)}`;

function readback(order: OrderView, lead: string): string {
  const lines = order.lines.map((line) => `• ${line.quantity === null ? "" : `${line.quantity} `}${line.productName ?? line.text}`.replace(/\s+$/u, ""));
  const total = order.total === null ? [] : [`Total: ${money(order.total)}`];
  return [lead, ...lines, ...total, CONFIRM_PROMPT].join("\n");
}

function question(code: QuestionCode): string {
  switch (code) {
    case "pickup_or_delivery":
      return "¿Lo pasás a traer o te lo llevamos?";
    case "ambiguous_size":
      return "¿De qué tamaño lo querés?";
    case "ambiguous_product":
      return "¿Cuál producto de tu pedido querés cambiar?";
    default:
      return "¿Me das un dato más para tu pedido?";
  }
}

function render(outcome: EngineOutcome): string {
  switch (outcome.type) {
    case "readback":
      return readback(outcome.order, "Esto entendí de tu pedido:");
    case "order_changed":
      return readback(outcome.order, "Cambié tu pedido así:");
    case "order_confirmed":
      return "Quedó confirmado tu pedido. Te aviso cuando esté listo.";
    case "order_cancelled":
      return "Cancelé tu pedido.";
    case "ask":
      return question(outcome.question);
    case "duplicate":
      return outcome.first.type === "order_confirmed" ? "Tu pedido ya estaba confirmado." : render(outcome.first);
    case "rejected":
      switch (outcome.reason) {
        case "stale_version":
          return outcome.order === null ? NO_OPEN_ORDER : readback(outcome.order, "Tu pedido cambió. Te lo leo de nuevo:");
        case "not_found":
          return NO_OPEN_ORDER;
        default:
          return "Eso lo ve la tienda. Ya les aviso.";
      }
    case "order_status":
      return outcome.order === null ? NO_OPEN_ORDER : readback(outcome.order, "Tu pedido va así:");
    case "handoff":
    case "out_of_scope":
      return "Se lo paso a la tienda para que te ayuden.";
    default:
      return "Recibí tu mensaje. Lo estoy revisando.";
  }
}
