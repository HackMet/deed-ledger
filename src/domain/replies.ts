/**
 * Replies to customers, rendered by code from fixed Spanish templates (Honduran, "vos"). Every
 * number, name, price and state comes from the engine's outcome or notice; no model writes a word
 * here. Each reply carries the claims it makes, so they can be checked twice: against the outcome
 * before the save (firstCheck, below), and against the records right before sending (dispatch).
 *
 * Customer words quoted back ("el arroz", "frente a la iglesia") are data: trimmed, flattened and
 * capped, never read as instructions.
 */
import type { CustomerAction, OrderRef } from "./contract/actions";
import { type Centavos, type DecimalString, formatLempiras, isDecimalString } from "./contract/numbers";
import type {
  AnswerFact,
  Claim,
  CustomerNotice,
  EngineOutcome,
  OrderLineView,
  OrderState,
  OrderView,
  ProductOption,
  QuestionCode,
  StoreHours,
} from "./contract/outcomes";
import { countedLineAmount, countsTowardTotal, orderSubtotal } from "./money";
import type { SavedPlace } from "./place";
import { formatStoreHours, isUsableStoreHours, storeHoursKey } from "./store-hours";

// ---------------------------------------------------------------------------------------------
// Types

/**
 * One thing a reply claims. It holds when any one of `anyOf` holds: "ya está en la lista" is true
 * while the order version is confirmado, preparando or listo, and a staff tap in between must not
 * block it. An empty `anyOf` never holds.
 */
export interface ClaimCheck {
  readonly anyOf: readonly Claim[];
}

/** A reply button. The ID is an operation key (contract gap g), untrusted when it comes back. */
export interface ReplyButton {
  readonly id: string;
  readonly title: string;
}

export interface RenderedReply {
  readonly template: TemplateName;
  readonly body: string;
  readonly claims: readonly ClaimCheck[];
  readonly buttons: readonly ReplyButton[];
}

/** What a reply was rendered from: the first check reads its claims back from this. */
export type ReplySource =
  | { readonly kind: "outcome"; readonly outcome: EngineOutcome; readonly customerId: string }
  | { readonly kind: "notice"; readonly notice: CustomerNotice };

// ---------------------------------------------------------------------------------------------
// The checked-in list: every engine outcome and every customer notice has a named template.
// Adding a kind to the contract fails typecheck here until it gets one.

export const OUTCOME_TEMPLATES = {
  ask: "ask",
  readback: "readback",
  order_confirmed: "order_confirmed",
  order_changed: "order_changed",
  order_cancelled: "order_cancelled",
  order_status: "order_status",
  answer: "answer",
  store_hours: "store_hours",
  balance: "balance",
  payment_claimed: "payment_claimed",
  handoff: "handoff",
  stopped: "stopped",
  out_of_scope: "out_of_scope",
  /** A console action: the console shows it; the customer hears through notices, if at all. */
  action_saved: "no_reply_console",
  /** A tap the engine refused: the customer sees where the order stands now. */
  rejected: "rejected_tap",
  /** Already answered the first time. */
  duplicate: "no_reply_duplicate",
  nothing: "no_reply",
} as const satisfies Record<EngineOutcome["type"], string>;

export const NOTICE_TEMPLATES = {
  order_ready: "notice_order_ready",
  line_unavailable: "notice_line_unavailable",
  substitute_offered: "notice_substitute_offered",
  payment_confirmed: "notice_payment_confirmed",
  payment_rejected: "notice_payment_rejected",
} as const satisfies Record<CustomerNotice["notice"]["type"], string>;

/** Sent instead of a reply whose claims didn't hold. Claims nothing, blames no one. */
export const SAFE_REPLY_TEMPLATE = "safe_reply";

export type TemplateName =
  | (typeof OUTCOME_TEMPLATES)[keyof typeof OUTCOME_TEMPLATES]
  | (typeof NOTICE_TEMPLATES)[keyof typeof NOTICE_TEMPLATES]
  | typeof SAFE_REPLY_TEMPLATE;

// ---------------------------------------------------------------------------------------------
// Fixed lines

export const COPY = {
  safeReply: "Dejame revisar bien y ya te confirmo.",
  /**
   * Queued by the sweep when an answer is slow. Claims nothing, so it is never checked. No time
   * promise: we don't know when the answer goes out.
   */
  slowNotice: "Recibimos tu mensaje, lo estamos revisando.",
  /** The typed choices where no button goes with them (a status answer). */
  typedFallback: "Respondé Confirmar, Corregir o Cancelar.",
  /** The readback's last line, under its buttons: the typed fallback PRD §6.1 requires, softly. */
  typedFallbackSoft: "_O escribí: confirmar, corregir o cancelar._",
  readbackTitle: "Tu pedido:",
  changedTitle: "Listo, así queda tu pedido:",
  staleTapTitle: "Tu pedido cambió desde ese mensaje. Así está ahora:",
  confirmQuestion: "¿Te lo preparo así?",
  pickup: "Lo recogés en la tienda.",
  /** How the store is paid, as the owner works today (to confirm with him): on pickup or delivery. */
  payOnPickup: "Pagás cuando lo recogés.",
  payOnDelivery: "Pagás cuando te lo entregamos.",
  totalUnknown: "El total te lo confirmo.",
  confirmed: "Listo 🙌 Tu pedido quedó anotado. Te aviso cuando esté listo.",
  /** Asked once the customer said the order is right (Confirmar, or a typed yes) and no name is on file. */
  askName: "¡Va! ¿A nombre de quién lo anoto?",
  /** The name question again, once, after an answer that wasn't a name. Never blames. */
  askNameAgain: "Es solo para anotar de quién es el pedido 🙂 ¿A nombre de quién lo anoto?",
  cancelled: "Listo, cancelé tu pedido. Cuando necesités algo, aquí estoy 🙌",
  statusBuilding: "Todavía estamos armando tu pedido.",
  statusAwaitingConfirm: "Tu pedido está armado, solo falta que me lo confirmés.",
  statusOnList: "Tu pedido ya está en la fila. Te aviso apenas esté listo.",
  statusReady: "Tu pedido ya está listo.",
  statusDelivered: "Tu pedido ya fue entregado.",
  statusCancelled: "Ese pedido está cancelado. Si querés hacer otro, escribime.",
  noOpenOrder: "No tenés ningún pedido abierto. ¿Querés hacer uno? Escribime lo que necesitás.",
  balanceUnknown: "Dejame revisar tu saldo y te confirmo.",
  balanceZero: "No tenés saldo pendiente con la tienda.",
  paymentClaimed: "Recibí tu comprobante. Te aviso cuando la tienda confirme el pago.",
  /** No time promise: nobody knows when the store gets to it. */
  handoff: "Se lo dejo anotado a la tienda, te escriben por aquí.",
  // Typed ALTO and deletion requests are decided by code before the engine (customer-gate.ts). This
  // outcome only comes from a model reading, which stops nothing: point to the exact words instead.
  stopped: "Si no querés recibir más mensajes, escribí solo la palabra ALTO.",
  stoppedDelete: "Si querés que borremos tus datos, escribí: borren mis datos.",
  outOfScope: "De eso no sé 😅 Yo te ayudo con pedidos, precios y el horario de la tienda. ¿Qué te mando?",
  refusedTap: "Ese botón ya no aplica. Si necesitás algo con tu pedido, escribime.",
  whichProduct: "¿De qué producto me preguntás?",
  /** Store hours not set in settings (#47): never a guessed schedule. */
  hoursUnknown: "El horario te lo confirmo.",
  paymentRejected: "No pudimos confirmar ese pago. Si tenés otro comprobante, mandámelo.",
  pickupReady: "Ya podés pasar por él.",
  substituteFallback: "Tocá un botón o escribime qué preferís.",
  /** The same, when the buttons couldn't be built: nothing to tap. */
  substituteFallbackTyped: "Escribime qué preferís.",
  removeTitle: "Quitar",
  samePlace: "¿Te lo llevamos al mismo lugar de siempre?",
  samePlaceFallback: "Respondé Sí u Otro lugar.",
  samePlacePin: "La vez pasada nos mandaste tu ubicación.",
  deliveryToPin: "Te lo llevamos a la ubicación que nos mandaste.",
  /** "Gracias", "ok" with nothing waiting on the customer. */
  welcome: "¡A la orden! 🙌",
  /** "Gracias" under a readback that waits: the Confirmar button goes with it. */
  confirmNudge: "Para dejarlo listo, tocá Confirmar ✅",
  /** The same when the buttons couldn't be built. */
  confirmNudgeTyped: "Para dejarlo listo, respondé Confirmar.",
  /** The last resort when nothing else would be said (an order is open). */
  anythingElse: "¿Qué más te mando?",
  /** Under a list of options for an unclear line. */
  pickOption: "¿Cuál te mando? Respondé con el número.",
  /** Before the next question, what the order holds so far: the customer sees it was understood. */
  noted: "Anotado ✅",
} as const;

/** "Se lo dejo anotado a Johan, te escribe por aquí." The owner's first name, as the console has it. */
export function handoffText(ownerName: string | null | undefined): string {
  return ownerName == null ? COPY.handoff : `Se lo dejo anotado a ${quote(ownerName)}, te escribe por aquí.`;
}

/** A greeting in the middle of a conversation: "¡Buenas, Carla! 👋" (no name: "¡Buenas! 👋"). */
export function greetingLine(customerName: string | null | undefined): string {
  return customerName == null ? "¡Buenas! 👋" : `¡Buenas, ${firstName(customerName)}! 👋`;
}

export const PLACE_BUTTON_TITLES = { same: "Sí", other: "Otro lugar" } as const;

export const BUTTON_TITLES = { confirm: "Confirmar", correct: "Corregir", cancel: "Cancelar" } as const;

/** Customer words quoted back are capped at this many characters. */
export const QUOTE_MAX_CHARS = 60;

const BUTTON_TITLE_MAX = 20;

/**
 * The what-to-order question alone. A new customer's first reply that is just this becomes the
 * welcome, with its buttons (customer-gate.ts).
 */
export const WHAT_TO_ORDER = "¿Qué te mando? Escribime la lista, mandame una foto o una nota de voz.";

// ---------------------------------------------------------------------------------------------
// Operation keys for buttons and typed words (contract gap g)

export type Decision = "confirm" | "correct" | "cancel";

const KEY_ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,119}";
const DECISION_KEY = new RegExp(`^(confirm|correct|cancel):(${KEY_ID}):v([1-9]\\d{0,8})$`);
const LINE_KEY = new RegExp(`^(substitute|remove):(${KEY_ID}):v([1-9]\\d{0,8}):(${KEY_ID})$`);
const PLACE_KEY = new RegExp(`^place:(${KEY_ID}):v([1-9]\\d{0,8}):(${KEY_ID})$`);
const OTHER_PLACE_KEY = new RegExp(`^otherplace:(${KEY_ID}):v([1-9]\\d{0,8})$`);
const SAFE_ID = new RegExp(`^${KEY_ID}$`);

/** `confirm:<order>:v<version>`: the button's ID and the typed word's operation key alike. */
export function decisionKey(decision: Decision, ref: OrderRef): string | null {
  if (!SAFE_ID.test(ref.orderId) || !Number.isSafeInteger(ref.version) || ref.version < 1) return null;
  return `${decision}:${ref.orderId}:v${ref.version}`;
}

/** `substitute:<order>:v<version>:<line>` or `remove:…`, for the out-of-stock question. */
export function lineChoiceKey(choice: "substitute" | "remove", ref: OrderRef, lineId: string): string | null {
  const base = decisionKey("confirm", ref);
  if (base === null || !SAFE_ID.test(lineId)) return null;
  return `${choice}:${ref.orderId}:v${ref.version}:${lineId}`;
}

/**
 * The same-place question's buttons (#29, proposed): `place:<order>:v<version>:<place>` for Sí,
 * `otherplace:<order>:v<version>` for Otro lugar.
 */
export function placeChoiceKey(choice: "same" | "other", ref: OrderRef, placeId: string): string | null {
  if (decisionKey("confirm", ref) === null || !SAFE_ID.test(placeId)) return null;
  return choice === "same" ? `place:${ref.orderId}:v${ref.version}:${placeId}` : `otherplace:${ref.orderId}:v${ref.version}`;
}

/**
 * Reads a tapped button's ID back into the action it stands for. Untrusted: the engine resolves it
 * only inside the tapping customer's own orders and refuses a stale version. Null for anything else.
 */
export function actionFromButtonId(id: string): CustomerAction | null {
  if (id.length > 256) return null;
  const decision = DECISION_KEY.exec(id);
  if (decision !== null) {
    const ref = { orderId: decision[2]!, version: Number(decision[3]) };
    const type = ({ confirm: "confirm_order", correct: "correct_order", cancel: "cancel_order" } as const)[
      decision[1] as Decision
    ];
    return { type, ...ref };
  }
  const place = PLACE_KEY.exec(id);
  if (place !== null) return { type: "accept_saved_place", orderId: place[1]!, version: Number(place[2]), placeId: place[3]! };
  const other = OTHER_PLACE_KEY.exec(id);
  if (other !== null) return { type: "decline_saved_place", orderId: other[1]!, version: Number(other[2]) };
  const line = LINE_KEY.exec(id);
  if (line !== null) {
    const ref = { orderId: line[2]!, version: Number(line[3]) };
    return line[1] === "substitute"
      ? { type: "accept_substitute", lineId: line[4]!, ...ref }
      : { type: "remove_line", lineId: line[4]!, ...ref };
  }
  return null;
}

const TYPED: Readonly<Record<string, Decision>> = { confirmar: "confirm", corregir: "correct", cancelar: "cancel" };

/**
 * "Confirmar", "CORREGIR", "cancelár", "¡Confirmar!": the readback's three words typed instead of
 * tapped, in any case, with or without accents or punctuation around them. Only the word alone:
 * anything longer is a message for perception, never guessed here.
 */
export function typedDecision(text: string): Decision | null {
  const word = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim();
  return Object.hasOwn(TYPED, word) ? TYPED[word]! : null;
}

// ---------------------------------------------------------------------------------------------
// Rendering

const NO_REPLY = null;

/** An order is open until it's delivered or cancelled. */
const OPEN_STATES: readonly OrderState[] = ["armando", "por_confirmar", "confirmado", "preparando", "listo"];

/**
 * The reply to a customer for an engine outcome, or null when the outcome gets none (a console
 * action, a duplicate, nothing to say). `customerId` is the conversation's customer, from our
 * records: the balance claim names it.
 */
export interface RenderContext {
  readonly customerId: string;
  readonly savedPlace?: SavedPlace | null;
  /** The store owner's first name, for the handoff line; null or absent: "la tienda". */
  readonly ownerName?: string | null;
  /** The customer's name, from our records: the confirmation says it. */
  readonly customerName?: string | null;
  /** The name was asked already: asked again, it's the gentler second ask. */
  readonly nameAsked?: boolean;
}

export function renderOutcome(outcome: EngineOutcome, context: RenderContext): RenderedReply | null {
  switch (outcome.type) {
    case "ask":
      if (outcome.question === "same_place") return samePlaceReply(outcome.order, context.savedPlace ?? null);
      // A question about an order holds only while that version is still open: once it's
      // cancelled or delivered, asking about it would be wrong.
      if (outcome.options !== undefined && outcome.options.length > 1 && outcome.order !== null) {
        return optionsReply(outcome.order, outcome.line, outcome.options);
      }
      return reply(
        "ask",
        outcome.question === "customer_name" && context.nameAsked === true
          ? COPY.askNameAgain
          : withEcho(outcome.question, outcome.order, askText(outcome.question, outcome.line, outcome.order), outcome.line),
        outcome.order === null ? [] : [stateIn(outcome.order, OPEN_STATES)],
      );
    case "readback":
      return readbackReply("readback", COPY.readbackTitle, outcome.order);
    case "order_changed":
      return readbackReply("order_changed", COPY.changedTitle, outcome.order);
    case "order_confirmed":
      return confirmedReply(outcome.order, context.customerName);
    case "order_cancelled":
      return reply("order_cancelled", COPY.cancelled, [stateIn(outcome.order, ["cancelado"])]);
    case "order_status":
      return statusReply("order_status", outcome.order);
    case "answer":
      return answerReply(outcome.topic, outcome.facts);
    case "store_hours":
      return storeHoursReply(outcome.hours);
    case "balance":
      return balanceReply(outcome.balance, context.customerId);
    case "payment_claimed":
      return reply("payment_claimed", COPY.paymentClaimed);
    case "handoff":
      return reply("handoff", handoffText(context.ownerName));
    case "stopped":
      return reply("stopped", outcome.deleteRequested ? COPY.stoppedDelete : COPY.stopped);
    case "out_of_scope":
      return reply("out_of_scope", COPY.outOfScope);
    case "rejected":
      return rejectedReply(outcome.order);
    case "action_saved":
    case "duplicate":
    case "nothing":
      return NO_REPLY;
    default:
      return unreachable(outcome);
  }
}

/** The message a customer gets because of someone else's action (staff, the owner). */
export function renderNotice(notice: CustomerNotice["notice"]): RenderedReply {
  switch (notice.type) {
    case "order_ready":
      return readyReply(notice.order);
    case "line_unavailable": {
      const line = notice.order.lines.find((l) => l.lineId === notice.lineId);
      const name = line === undefined ? "uno de los productos" : lineName(line);
      const claims: ClaimCheck[] = [stateIn(notice.order, ["confirmado", "preparando"]), ...soldOut(line)];
      let total = "";
      if (notice.order.total !== null && notice.order.total === orderSubtotal(notice.order)) {
        total = ` Tu pedido queda en ${formatLempiras(notice.order.total)}.`;
        claims.push(one({ type: "order_total", orderId: notice.order.orderId, version: notice.order.version, total: notice.order.total }));
      }
      return reply(
        "notice_line_unavailable",
        `Perdón, no nos queda ${name} 😔${total} Si querés otra cosa en su lugar, decime.`,
        claims,
      );
    }
    case "substitute_offered":
      return substituteReply(notice.order, notice.lineId);
    case "payment_confirmed":
      return reply("notice_payment_confirmed", `La tienda confirmó tu pago de ${formatLempiras(notice.amount)}. ¡Gracias!`, [
        one({ type: "payment_confirmed", paymentClaimId: notice.paymentClaimId, amount: notice.amount }),
      ]);
    case "payment_rejected":
      // No claim is possible: the notice names no order, and the contract has no claim for a
      // rejected payment (only payment_confirmed). The copy claims no state either.
      return reply("notice_payment_rejected", COPY.paymentRejected);
    default:
      return unreachable(notice);
  }
}

/** The fixed reply that goes instead of one whose claims didn't hold. */
export function safeReply(): RenderedReply {
  return reply(SAFE_REPLY_TEMPLATE, COPY.safeReply);
}

function reply(
  template: TemplateName,
  body: string,
  claims: readonly ClaimCheck[] = [],
  buttons: readonly ReplyButton[] = [],
): RenderedReply {
  return { template, body, claims, buttons };
}

function one(claim: Claim): ClaimCheck {
  return { anyOf: [claim] };
}

function stateIn(order: OrderView, states: readonly OrderState[]): ClaimCheck {
  return { anyOf: states.map((state) => ({ type: "order_state", orderId: order.orderId, version: order.version, state })) };
}

function soldOut(line: OrderLineView | undefined): ClaimCheck[] {
  return line?.productId == null ? [] : [one({ type: "availability", productId: line.productId, availability: "se_acabo" })];
}

// --- Questions

/** A question again, without the line it may be about: the never-silent fallback's restatement. */
export function questionText(question: QuestionCode): string {
  return askText(question, null, null);
}

/**
 * "Listo, María 🙌 Tu pedido #101 quedó anotado. Total: L 172.50. Te aviso cuando esté listo." The
 * first name only ("Doña Rosa" keeps the title); the number and total when the order has them.
 */
function confirmedReply(order: OrderView, customerName: string | null | undefined): RenderedReply {
  const claims: ClaimCheck[] = [stateIn(order, ["confirmado", "preparando", "listo"])];
  const name = customerName == null ? null : firstName(customerName);
  const opening = name === null ? "Listo 🙌" : `Listo, ${name} 🙌`;
  const which = order.code === undefined ? "Tu pedido" : `Tu pedido #${order.code}`;
  let total = "";
  if (order.total !== null) {
    total = ` Total: ${formatLempiras(order.total + (feeOf(order) ?? 0))}.`;
    claims.push(one({ type: "order_total", orderId: order.orderId, version: order.version, total: order.total }));
  }
  return reply("order_confirmed", `${opening} ${which} quedó anotado.${total} Te aviso cuando esté listo.`, claims);
}

/** "María" from "Maria Lopez"; a title stays with the name ("Doña Rosa", "Don Mario"). */
export function firstName(name: string): string {
  const words = quote(name).split(" ").filter((word) => word !== "");
  if (words.length === 0) return quote(name);
  const title = /^(?:don|doña|dona|doña|sra|sr|señora|senora|señor|senor|seño|seno|profe|ing|lic)\.?$/iu;
  return title.test(words[0]!) && words[1] !== undefined ? `${words[0]} ${words[1]}` : words[0]!;
}

/**
 * "Anotado ✅ 5 × Arroz 1 lb, 5 × Azúcar 1 lb." before a question about how the order goes, so the
 * customer sees what was understood before answering. Lists up to four lines; more are counted.
 */
function withEcho(question: QuestionCode, order: OrderView | null, text: string, lineIndex: number | null = null): string {
  const echoed: readonly QuestionCode[] = ["pickup_or_delivery", "delivery_place", "same_place"];
  const aboutLine: readonly QuestionCode[] = ["quantity", "ambiguous_size", "ambiguous_product", "illegible"];
  if (order === null || order.lines.length === 0) return text;
  if (echoed.includes(question)) return `${echoLine(order.lines)}\n${text}`;
  if (question === "quantities") {
    const known = order.lines.filter((line) => line.quantity !== null);
    return known.length > 0 ? `${echoLine(known)}\n${text}` : `${COPY.noted} ${order.lines.length} productos.\n${text}`;
  }
  if (aboutLine.includes(question) && lineIndex !== null && order.lines[lineIndex] !== undefined) {
    const others = order.lines.filter((_, n) => n !== lineIndex);
    if (others.length > 0) return `${echoLine(others)}\n${text}`;
  }
  return text;
}

/** "Anotado ✅ 5 × Arroz 1 lb, 5 × Azúcar 1 lb." Up to four lines; more are counted. */
function echoLine(lines: readonly OrderLineView[]): string {
  const items = lines.length <= 4 ? lines.map(shortLine).join(", ") : `tus ${lines.length} productos`;
  return `${COPY.noted} ${items}.`;
}

function shortLine(line: OrderLineView): string {
  const quantity = line.quantity === null ? null : quantityShown(line);
  return quantity === null ? lineName(line) : `${quantity} ${lineName(line)}`;
}

/** An unclear line's options, numbered, each with its confirmed price (a claim) when there is one. */
function optionsReply(order: OrderView, lineIndex: number | null, options: readonly ProductOption[]): RenderedReply {
  const line = lineIndex === null ? undefined : order.lines[lineIndex];
  const claims: ClaimCheck[] = [stateIn(order, OPEN_STATES)];
  const rows = options.map((option, n) => {
    if (option.unitPrice === null) return `${n + 1}. ${quote(option.name)}`;
    claims.push(one({ type: "unit_price", productId: option.productId, price: option.unitPrice }));
    return `${n + 1}. ${quote(option.name)} · ${formatLempiras(option.unitPrice)}`;
  });
  const head = line === undefined ? "Tengo estos:" : `Para ${lineName(line)} tengo:`;
  const others = order.lines.filter((_, n) => n !== lineIndex);
  const echo = others.length > 0 ? [echoLine(others)] : [];
  return reply("ask", [...echo, head, ...rows, COPY.pickOption].join("\n"), claims);
}

/**
 * "Para dejarlo listo, tocá Confirmar ✅" under a readback that waits, with the readback's buttons
 * on this same message, so the button it points at is on the last message. Without buttons, it
 * says what to write instead. Claims what the readback claimed: the version still waits.
 */
export function confirmNudge(order: OrderView): RenderedReply {
  const buttons = decisionButtons(order);
  return reply(
    "readback",
    buttons.length > 0 ? COPY.confirmNudge : COPY.confirmNudgeTyped,
    [stateIn(order, ["por_confirmar"])],
    buttons,
  );
}

function askText(question: QuestionCode, lineIndex: number | null, order: OrderView | null): string {
  const line = lineIndex === null ? undefined : order?.lines[lineIndex];
  const name = line === undefined ? null : lineName(line);
  switch (question) {
    case "illegible":
      return name === null
        ? "No alcancé a leer una parte de tu lista. ¿Me la escribís?"
        : `No alcancé a leer bien ${name}. ¿Me lo escribís?`;
    case "ambiguous_size":
      return name === null ? "¿De qué tamaño lo querés?" : `¿De qué tamaño querés ${name}?`;
    case "ambiguous_product":
      return name === null
        ? "¿Cuál producto querés? Decime la marca o mandame una foto."
        : `¿Cuál ${name} querés? Decime la marca o mandame una foto.`;
    case "embedded_instructions":
      // The message held text aimed at the assistant: treated as data, never mentioned.
      return "Te ayudo con tu pedido. ¿Qué te mando?";
    case "quantity":
      return name === null ? "¿Cuántos querés?" : `¿Cuánto querés de ${name}?`;
    case "quantities":
      return quantitiesText(order);
    case "pickup_or_delivery":
      return "¿Lo recogés en la tienda o te lo llevamos?";
    case "what_to_order":
      return WHAT_TO_ORDER;
    case "delivery_place":
      return "¿A dónde te lo llevamos? Mandame tu ubicación o escribime la dirección.";
    case "same_place":
      return "¿Te lo llevamos al mismo lugar de siempre?";
    case "customer_name":
      return COPY.askName;
    default:
      return unreachable(question);
  }
}

/**
 * One question for every line still without a quantity (a list from a photo), with an example built
 * from the first two, so the customer answers them all in one message.
 */
function quantitiesText(order: OrderView | null): string {
  const waiting = (order?.lines ?? []).filter((line) => line.quantity === null && !line.restricted);
  if (waiting.length === 0) return "¿Cuántos querés de cada uno?";
  const shown = waiting.slice(0, 12).map((line) => `• ${lineName(line)}`);
  if (waiting.length > 12) shown.push(`…y ${waiting.length - 12} más`);
  const example = waiting
    .slice(0, 2)
    .map((line, n) => `${n === 0 ? 2 : 1} ${lineName(line).toLocaleLowerCase("es")}`)
    .join(", ");
  return ["¿Cuántos querés de cada uno?", ...shown, `Escribime, por ejemplo: «${example}».`].join("\n");
}

/**
 * "¿Te lo llevamos al mismo lugar de siempre?" with the place echoed back and Sí / Otro lugar. The
 * place is the one the engine was given in the customer's context (our records); the outcome
 * names none yet (proposed in the contract). Without it, the question goes with the typed choices.
 */
function samePlaceReply(order: OrderView | null, place: SavedPlace | null): RenderedReply {
  const claims = order === null ? [] : [stateIn(order, OPEN_STATES)];
  const lines: string[] = [COPY.samePlace];
  if (place?.placeText != null) lines.push(`La vez pasada te lo llevamos a: ${quote(place.placeText)}.`);
  else if (place?.pin != null) lines.push(COPY.samePlacePin);
  lines.push(COPY.samePlaceFallback);
  const same = order === null || place === null ? null : placeChoiceKey("same", order, place.placeId);
  const other = order === null || place === null ? null : placeChoiceKey("other", order, place.placeId);
  const buttons =
    same === null || other === null
      ? []
      : [
          { id: same, title: PLACE_BUTTON_TITLES.same },
          { id: other, title: PLACE_BUTTON_TITLES.other },
        ];
  return reply("ask", lines.join("\n"), claims, buttons);
}

// --- Readback

function readbackReply(template: "readback" | "order_changed" | "rejected_tap", title: string, order: OrderView): RenderedReply {
  const awaiting = order.state === "por_confirmar";
  const lines = [title, ...order.lines.map((line) => readbackLine(line)), ...fulfillmentLines(order)];
  const claims: ClaimCheck[] = [stateIn(order, [order.state])];
  const fee = feeOf(order);
  if (order.total !== null) {
    lines.push(
      fee === null
        ? `*Total: ${formatLempiras(order.total)}*`
        : `*Total: ${formatLempiras(order.total + fee)}* (${formatLempiras(order.total)} + ${formatLempiras(fee)} de envío)`,
    );
    claims.push(one({ type: "order_total", orderId: order.orderId, version: order.version, total: order.total }));
  } else {
    lines.push(COPY.totalUnknown);
  }
  const pay = payLine(order);
  if (pay !== null) lines.push(pay);
  const buttons = awaiting ? decisionButtons(order) : [];
  if (awaiting) {
    lines.push(COPY.confirmQuestion);
    // With buttons, the typed words are a soft last line; without, the instruction itself.
    lines.push(buttons.length > 0 ? COPY.typedFallbackSoft : COPY.typedFallback);
  }
  return reply(template, lines.join("\n"), claims, buttons);
}

/**
 * "• 5 × Arroz 1 lb · L 90", the way a receipt reads. A weight in parts keeps its unit ("• Queso
 * seco 1 lb, 1.5 libras · L 105"). What isn't known says so, never a guessed number.
 */
function readbackLine(line: OrderLineView): string {
  const name = lineName(line);
  if (line.restricted) return `• ${name}: eso solo lo vendemos aquí en la tienda.`;
  if (!countsTowardTotal(line)) return `• ${name}: no nos queda.`;
  if (line.quantity === null) return `• ${name}: falta la cantidad.`;
  const item = `${quantityShown(line)} ${name}`;
  const amount = countedLineAmount(line);
  if (line.productId === null) return `• ${item}: te confirmo si hay y el precio.`;
  if (line.unitPrice === null || amount === null) return `• ${item}: el precio te lo confirmo.`;
  return `• ${item} · ${formatLempiras(amount)}`;
}

/** "5 ×" for whole numbers; "1.5 libras" with its unit otherwise (before the name: "1.5 libras de"). */
function quantityShown(line: OrderLineView): string {
  const quantity = line.quantity!;
  if (/^\d+$/u.test(quantity)) return `${quantity} ×`;
  return `${formatQuantity(quantity, line.unit)}${line.unit === null ? " ×" : " de"}`;
}

/** How the order is paid, once it says how it's received. */
function payLine(order: OrderView): string | null {
  if (order.fulfillment === null) return null;
  return order.fulfillment.mode === "pickup" ? COPY.payOnPickup : COPY.payOnDelivery;
}

function fulfillmentLines(order: OrderView): string[] {
  const fulfillment = order.fulfillment;
  if (fulfillment === null) return [];
  if (fulfillment.mode === "pickup") return [COPY.pickup];
  const place =
    fulfillment.placeText !== null
      ? `Te lo llevamos a: ${quote(fulfillment.placeText)}.`
      : fulfillment.pin != null
        ? COPY.deliveryToPin
        : fulfillment.placeId !== null
          ? "Te lo llevamos al lugar que nos diste."
          : "Te lo llevamos. Falta la dirección.";
  return [place];
}

/** A fee shows only when the store set one above zero. */
function feeOf(order: OrderView): Centavos | null {
  const f = order.fulfillment;
  return f !== null && f.mode === "delivery" && f.fee !== null && f.fee > 0 ? f.fee : null;
}

function decisionButtons(order: OrderView): ReplyButton[] {
  const decisions: Decision[] = ["confirm", "correct", "cancel"];
  const buttons: ReplyButton[] = [];
  for (const decision of decisions) {
    const id = decisionKey(decision, order);
    // An order ID that can't be a key gets no buttons; the typed words still work.
    if (id === null) return [];
    buttons.push({ id, title: BUTTON_TITLES[decision] });
  }
  return buttons;
}

// --- Status: "¿A qué hora está?" Never a time, only where the order stands.

const ORDINALS = ["primero", "segundo", "tercero", "cuarto", "quinto", "sexto", "séptimo", "octavo", "noveno", "décimo"];

export function queuePlace(position: number): string {
  const ordinal = ORDINALS[position - 1];
  return ordinal === undefined ? `Vas en el lugar ${position} de la fila.` : `Vas ${ordinal} en la fila.`;
}

function statusReply(template: "order_status", order: OrderView | null): RenderedReply {
  // "No open order" can't be claimed: every Claim names an order (or a product, payment or
  // balance), so absence has no claim in the contract. A contract question.
  if (order === null) return reply(template, COPY.noOpenOrder);
  switch (order.state) {
    case "armando":
      return reply(template, COPY.statusBuilding, [stateIn(order, ["armando", "por_confirmar"])]);
    case "por_confirmar":
      return reply(template, `${COPY.statusAwaitingConfirm} ${COPY.typedFallback}`, [stateIn(order, ["por_confirmar"])]);
    case "confirmado":
    case "preparando":
      return reply(
        template,
        order.queuePosition === null || order.queuePosition < 1
          ? COPY.statusOnList
          : `${queuePlace(order.queuePosition)} Te aviso apenas esté listo.`,
        [stateIn(order, ["confirmado", "preparando"])],
      );
    case "listo": {
      const ready = order.code === undefined ? COPY.statusReady : `Tu pedido #${order.code} ya está listo.`;
      const body = order.fulfillment?.mode === "pickup" ? `${ready} Te esperamos 🙌` : ready;
      return reply(template, body, [stateIn(order, ["listo"])]);
    }
    case "entregado":
      return reply(template, COPY.statusDelivered, [stateIn(order, ["entregado"])]);
    case "cancelado":
      return reply(template, COPY.statusCancelled, [stateIn(order, ["cancelado"])]);
    default:
      return unreachable(order.state);
  }
}

function rejectedReply(order: OrderView | null): RenderedReply {
  if (order === null) return reply("rejected_tap", COPY.refusedTap);
  if (order.state === "por_confirmar") return readbackReply("rejected_tap", COPY.staleTapTitle, order);
  const status = statusReply("order_status", order);
  return reply("rejected_tap", status.body, status.claims);
}

// --- Answers

function answerReply(topic: "price" | "availability", facts: readonly AnswerFact[]): RenderedReply {
  if (facts.length === 0) return reply("answer", COPY.whichProduct);
  const lines: string[] = [];
  const claims: ClaimCheck[] = [];
  for (const fact of facts) {
    const asked = quote(fact.asked);
    if (fact.restricted) {
      lines.push(`${capitalize(asked)}: eso solo lo vendemos aquí en la tienda.`);
    } else if (topic === "price") {
      if (fact.productId !== null && fact.unitPrice !== null) {
        lines.push(`${capitalize(asked)}: ${formatLempiras(fact.unitPrice)}.`);
        claims.push(one({ type: "unit_price", productId: fact.productId, price: fact.unitPrice }));
      } else {
        lines.push(`${capitalize(asked)}: el precio te lo confirmo.`);
      }
    } else if (fact.productId !== null && fact.availability === "hay") {
      lines.push(`${capitalize(asked)}: sí hay.`);
      claims.push(one({ type: "availability", productId: fact.productId, availability: "hay" }));
    } else if (fact.productId !== null && fact.availability === "se_acabo") {
      lines.push(`${capitalize(asked)}: se nos acabó.`);
      claims.push(one({ type: "availability", productId: fact.productId, availability: "se_acabo" }));
    } else {
      // No record (or no recent evidence): never a guess (PRD "Honest stock").
      lines.push(`${capitalize(asked)}: te confirmo si hay.`);
    }
  }
  return reply("answer", lines.join("\n"), claims);
}

/** Hours from store settings only; unset (or unreadable) is "te confirmo", never a default. */
function storeHoursReply(hours: StoreHours | null): RenderedReply {
  if (!isUsableStoreHours(hours)) return reply("store_hours", COPY.hoursUnknown);
  return reply("store_hours", formatStoreHours(hours), [one({ type: "store_hours", hours })]);
}

/**
 * How many things a reply to this outcome tells the customer "te confirmo" about (#47): products
 * with no match, no confirmed price or no recent stock evidence, or hours not set. Restricted
 * products and "¿de qué producto?" promise nothing. Zero for every other outcome.
 */
export function unansweredCount(outcome: EngineOutcome): number {
  if (outcome.type === "store_hours") return isUsableStoreHours(outcome.hours) ? 0 : 1;
  // A confirmed order with lines we couldn't price or find: "te confirmo" the owner must answer.
  if (outcome.type === "order_confirmed") {
    return outcome.order.lines.filter((line) => !line.restricted && countsTowardTotal(line) && (line.productId === null || line.unitPrice === null)).length;
  }
  if (outcome.type !== "answer") return 0;
  return outcome.facts.filter((fact) => {
    if (fact.restricted) return false;
    if (fact.productId === null) return true;
    return outcome.topic === "price" ? fact.unitPrice === null : fact.availability === "no_se";
  }).length;
}

function balanceReply(balance: Centavos | null, customerId: string): RenderedReply {
  if (balance === null) return reply("balance", COPY.balanceUnknown);
  const claims = [one({ type: "balance", customerId, balance })];
  return balance === 0
    ? reply("balance", COPY.balanceZero, claims)
    : reply("balance", `Tu saldo pendiente con la tienda es ${formatLempiras(balance)}.`, claims);
}

// --- Notices

function readyReply(order: OrderView): RenderedReply {
  const claims: ClaimCheck[] = [stateIn(order, ["listo"])];
  const missing = order.lines.filter((line) => !line.restricted && !countsTowardTotal(line)).map(lineName);
  const without = missing.length === 0 ? "" : `, sin ${missing.join(", ")}`;
  let body: string;
  const ready = order.code === undefined ? "¡Tu pedido ya está listo! 🙌" : `¡Tu pedido #${order.code} ya está listo! 🙌`;
  if (order.total !== null) {
    body = `${ready} Total: ${formatLempiras(order.total + (feeOf(order) ?? 0))}${without}.`;
    claims.push(one({ type: "order_total", orderId: order.orderId, version: order.version, total: order.total }));
  } else {
    body = `${ready} ${COPY.totalUnknown}`;
  }
  if (order.fulfillment?.mode === "pickup") body += ` ${COPY.pickupReady}`;
  return reply("notice_order_ready", body, claims);
}

function substituteReply(order: OrderView, lineId: string): RenderedReply {
  const line = order.lines.find((l) => l.lineId === lineId);
  const substitute = line?.substitute ?? null;
  if (line === undefined || substitute === null) {
    // Nothing to offer after all: say only what's certain.
    return reply("notice_substitute_offered", COPY.safeReply);
  }
  const claims: ClaimCheck[] = [stateIn(order, ["confirmado", "preparando"]), ...soldOut(line)];
  const offered = quote(substitute.productName);
  let question: string;
  if (substitute.unitPrice !== null) {
    question = `¿Te mandamos ${offered} (${formatLempiras(substitute.unitPrice)}) o lo quitamos?`;
    claims.push(one({ type: "unit_price", productId: substitute.productId, price: substitute.unitPrice }));
  } else {
    question = `¿Te mandamos ${offered} o lo quitamos? El precio te lo confirmo.`;
  }
  const accept = lineChoiceKey("substitute", order, lineId);
  const remove = lineChoiceKey("remove", order, lineId);
  const title = buttonTitle(substitute.productName);
  const buttons =
    accept === null || remove === null || title === COPY.removeTitle
      ? []
      : [
          { id: accept, title },
          { id: remove, title: COPY.removeTitle },
        ];
  // "Tocá…" only when there is something to tap.
  const fallback = buttons.length > 0 ? COPY.substituteFallback : COPY.substituteFallbackTyped;
  return reply("notice_substitute_offered", `No nos queda ${lineName(line)}. ${question} ${fallback}`, claims, buttons);
}

// --- Helpers

function lineName(line: OrderLineView): string {
  return line.productName !== null ? quote(line.productName) : quote(line.text) || "un producto";
}

/** Customer or catalog words, flattened to one line and capped. Data, never instructions. */
export function quote(text: string): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= QUOTE_MAX_CHARS ? flat : `${chars.slice(0, QUOTE_MAX_CHARS - 1).join("").trimEnd()}…`;
}

function buttonTitle(text: string): string {
  const chars = [...quote(text)];
  return chars.length <= BUTTON_TITLE_MAX ? chars.join("") : `${chars.slice(0, BUTTON_TITLE_MAX - 1).join("").trimEnd()}…`;
}

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase("es") + text.slice(1);
}

/** "3 libras", "1 unidad", "1.5 libras"; trailing zeros dropped. No unit: the number alone. */
export function formatQuantity(quantity: DecimalString, unit: string | null): string {
  const shown = isDecimalString(quantity) && quantity.includes(".") ? quantity.replace(/\.?0+$/, "") : quantity;
  if (unit === null || unit.trim() === "") return shown;
  const word = quote(unit);
  return shown === "1" ? `${shown} ${word}` : `${shown} ${plural(word)}`;
}

function plural(word: string): string {
  if (/s$/i.test(word)) return word;
  return /[aeiouáéíóú]$/i.test(word) ? `${word}s` : `${word}es`;
}

function unreachable(value: never): never {
  throw new Error(`No template for ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------------------------
// The first check: before the save, every claim is read back from what the reply was rendered from.

function claimKey(claim: Claim): string {
  switch (claim.type) {
    case "order_state":
      return `order_state|${claim.orderId}|${claim.version}|${claim.state}`;
    case "order_total":
      return `order_total|${claim.orderId}|${claim.version}|${claim.total}`;
    case "unit_price":
      return `unit_price|${claim.productId}|${claim.price}`;
    case "availability":
      return `availability|${claim.productId}|${claim.availability}`;
    case "payment_confirmed":
      return `payment_confirmed|${claim.paymentClaimId}|${claim.amount}`;
    case "balance":
      return `balance|${claim.customerId}|${claim.balance}`;
    case "store_hours":
      return `store_hours|${storeHoursKey(claim.hours)}`;
    default:
      return unreachable(claim);
  }
}

/**
 * The claims the source itself backs. An order total is backed only when it equals the sum of its
 * counted lines (gap j): the readback shows both, and they must agree.
 */
export function backedClaims(source: ReplySource): Claim[] {
  const claims: Claim[] = [];
  const order = (o: OrderView | null) => {
    if (o === null) return;
    claims.push({ type: "order_state", orderId: o.orderId, version: o.version, state: o.state });
    if (o.total !== null && o.total === orderSubtotal(o)) {
      claims.push({ type: "order_total", orderId: o.orderId, version: o.version, total: o.total });
    }
    for (const line of o.lines) {
      if (line.productId !== null && line.availability !== "no_se") {
        claims.push({ type: "availability", productId: line.productId, availability: line.availability });
      }
      if (line.substitute !== null && line.substitute.unitPrice !== null) {
        claims.push({ type: "unit_price", productId: line.substitute.productId, price: line.substitute.unitPrice });
      }
    }
  };
  if (source.kind === "notice") {
    const notice = source.notice.notice;
    if (notice.type === "payment_confirmed") {
      claims.push({ type: "payment_confirmed", paymentClaimId: notice.paymentClaimId, amount: notice.amount });
    } else if (notice.type !== "payment_rejected") {
      order(notice.order);
    }
    return claims;
  }
  const outcome = source.outcome;
  switch (outcome.type) {
    case "ask":
      order(outcome.order);
      for (const option of outcome.options ?? []) {
        if (option.unitPrice !== null) claims.push({ type: "unit_price", productId: option.productId, price: option.unitPrice });
      }
      break;
    case "order_status":
    case "rejected":
    case "readback":
    case "order_confirmed":
    case "order_changed":
    case "order_cancelled":
      order(outcome.order);
      break;
    case "answer":
      for (const fact of outcome.facts) {
        if (fact.productId === null || fact.restricted) continue;
        if (fact.unitPrice !== null) claims.push({ type: "unit_price", productId: fact.productId, price: fact.unitPrice });
        if (fact.availability !== "no_se") {
          claims.push({ type: "availability", productId: fact.productId, availability: fact.availability });
        }
      }
      break;
    case "balance":
      if (outcome.balance !== null) claims.push({ type: "balance", customerId: source.customerId, balance: outcome.balance });
      break;
    case "store_hours":
      if (outcome.hours !== null) claims.push({ type: "store_hours", hours: outcome.hours });
      break;
    default:
      break;
  }
  return claims;
}

/** True when every claim check has at least one alternative the source backs. */
export function firstCheck(claims: readonly ClaimCheck[], source: ReplySource): boolean {
  const backed = new Set(backedClaims(source).map(claimKey));
  return claims.every((check) => check.anyOf.some((claim) => backed.has(claimKey(claim))));
}

/**
 * The second check's verdict from verifyClaims' answers: `verified` holds one boolean per claim of
 * `flattenClaims(claims)`, in order. A short or missing answer is a failure.
 */
export function flattenClaims(claims: readonly ClaimCheck[]): Claim[] {
  return claims.flatMap((check) => check.anyOf);
}

export function secondCheckHolds(claims: readonly ClaimCheck[], verified: readonly boolean[]): boolean {
  if (verified.length !== flattenClaims(claims).length) return false;
  let at = 0;
  return claims.every((check) => {
    const answers = verified.slice(at, at + check.anyOf.length);
    at += check.anyOf.length;
    return answers.some((ok) => ok === true);
  });
}
