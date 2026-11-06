/**
 * Replies to customers, rendered by code from fixed Spanish templates (Honduran, "vos"). Every
 * number, name, price and state comes from the engine's outcome or notice; no model writes a word
 * here. Each reply carries the claims it makes, so they can be checked twice: against the outcome
 * before the save (firstCheck, below), and against the records right before sending (dispatch).
 *
 * Customer words quoted back ("el arroz", "frente a la iglesia") are data: trimmed, flattened and
 * capped, never read as instructions.
 */
import { wordsWithoutQuantity } from "./orders";
import type { CustomerAction, OrderRef } from "./contract/actions";
import { type Centavos, type DecimalString, formatLempiras, isDecimalString } from "./contract/numbers";
import type {
  AnswerFact,
  AskQuestions,
  Claim,
  CustomerNotice,
  EngineOutcome,
  LineDiff,
  OrderLineView,
  OrderState,
  OrderView,
  ProductOption,
  QuestionCode,
  StoreHours,
} from "./contract/outcomes";
import { countedLineAmount, countsTowardTotal, nothingToPrepare, orderSubtotal } from "./money";
import type { SavedPlace } from "./place";
import { formatStoreHours, isUsableStoreHours, storeHoursKey } from "./store-hours";
import { isWeightUnit } from "./planner/validate";

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
  /** WhatsApp's grey line under the buttons, sent only with them. Plain text, one line. */
  readonly footer?: string;
  /**
   * The typed choices, put under the body only when it goes out as plain text (its buttons can't
   * be shown): the text fallback every decision needs. With the buttons, the footer stands in.
   */
  readonly textFallback?: string;
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
  change_approved: "notice_change_approved",
  change_declined: "notice_change_declined",
  order_dispatched: "notice_order_dispatched",
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
  /**
   * The readback's typed fallback (PRD §6.1), softly: under the body when its buttons couldn't be
   * shown and it went as plain text. With the buttons, the footer (fixHint) says it instead.
   */
  typedFallbackSoft: "_O escribí: confirmar, corregir o cancelar._",
  /** The readback's footer, in grey under its buttons. At most 60 characters (WhatsApp). */
  fixHint: "Si algo está mal, escribime o mandame un audio.",
  /** After the readback's items, for lines with no product or no confirmed price. */
  confirmLater: "De estos te confirmo si hay y el precio",
  readbackTitle: "Tu pedido:",
  changedTitle: "Listo, así queda tu pedido:",
  staleTapTitle: "Tu pedido cambió desde ese mensaje. Así está ahora:",
  confirmQuestion: "¿Te lo preparo así?",
  /** Under a readback where nothing is left to prepare: nothing to confirm, the typed way out. */
  soldOutAll: "¿Qué más te mando? Si no querés nada más, respondé Cancelar.",
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
  /**
   * A change asked after confirming waits for the store (K12): the customer hears what is waiting,
   * true on the turn that asked it and on any later status answer.
   */
  changeRequested: "Tu pedido ya está confirmado. Este cambio está esperando que la tienda lo revise:",
  /** The same, for a change with no line to list (pickup or delivery only). */
  changeRequestedPlain: "Tu pedido ya está confirmado. Tu cambio está esperando que la tienda lo revise.",
  changeRequestedAfter: "Te aviso apenas lo revisen.",
  statusReady: "Tu pedido ya está listo.",
  statusOnTheWay: "Tu pedido va en camino 🛵",
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
  /** Before the next question, what this burst added or changed: the customer sees it was understood. */
  noted: "Anotado ✅",
  /** Planner path (D-47): every missing quantity in one question. */
  quantitiesTitle: "¿Cuántos querés de estos?",
  /** Planner path: under the options of one or more lines. */
  pickOptionByName: "¿Cuál te mando? Respondé con el número o el nombre.",
  /** Planner path (D-46): after "Te puse 1 de…". */
  assumedMore: "Si querés más, decime.",
  assumedOther: "Si querés otra cantidad, decime.",
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

/**
 * A delivery place is read back whole up to this many characters: a real address with its
 * landmarks fits, and pasted text still can't flood the reply.
 */
export const PLACE_QUOTE_MAX_CHARS = 160;

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
export const OPEN_STATES: readonly OrderState[] = ["armando", "por_confirmar", "confirmado", "preparando", "listo", "en_camino"];

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
    case "ask": {
      const noted = notedLines(outcome);
      if (outcome.question === "same_place") return samePlaceReply(outcome.order, context.savedPlace ?? null, noted);
      if (outcome.questions !== undefined && outcome.order !== null) {
        return plannedAskReply(outcome.order, outcome.questions, outcome.assumed ?? [], noted);
      }
      // A question about an order holds only while that version is still open: once it's
      // cancelled or delivered, asking about it would be wrong.
      if (outcome.options !== undefined && outcome.options.length > 1 && outcome.order !== null) {
        return optionsReply(outcome.order, outcome.line, outcome.options, noted);
      }
      return reply(
        "ask",
        outcome.question === "customer_name" && context.nameAsked === true
          ? COPY.askNameAgain
          : withEcho(outcome.question, outcome.order, askText(outcome.question, outcome.line, outcome.order), outcome.line, noted),
        outcome.order === null ? [] : [stateIn(outcome.order, OPEN_STATES)],
      );
    }
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
        `Perdón, ahorita no hay ${name} 😔${total} Si querés otra cosa en su lugar, decime.`,
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
    // Proposed (K12, K13), pending Angel's OK on the copy. The contract has no claim for a reviewed
    // change, so those two claim where the order stands, which also resolves them to it (C11); the
    // dispatch claims en_camino.
    case "change_approved":
      return reply("notice_change_approved", "Tu cambio fue aprobado. Tu pedido ya quedó actualizado ✅", [standsOrMovedOn(notice.order)]);
    case "change_declined":
      return reply("notice_change_declined", `No pudimos hacer el cambio: ${notice.reason}. Tu pedido sigue como estaba.`, [standsOrMovedOn(notice.order)]);
    case "order_dispatched":
      return reply(
        "notice_order_dispatched",
        notice.courierName === null ? COPY.statusOnTheWay : `Tu pedido va en camino con ${notice.courierName} 🛵`,
        [stateIn(notice.order, ["en_camino"])],
      );
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

export function stateIn(order: { readonly orderId: string; readonly version: number }, states: readonly OrderState[]): ClaimCheck {
  return { anyOf: states.map((state) => ({ type: "order_state", orderId: order.orderId, version: order.version, state })) };
}

/** The steps a staff tap moves an order through while a notice waits to go out. */
const STAFF_STEPS: readonly OrderState[] = ["confirmado", "preparando", "listo"];

/** The version is where the notice found it, or a staff step further on: a tap in between must not block the notice. */
function standsOrMovedOn(order: OrderView): ClaimCheck {
  const at = STAFF_STEPS.indexOf(order.state);
  return stateIn(order, at === -1 ? [order.state] : STAFF_STEPS.slice(at));
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

/** A message's blocks, one blank line apart; absent or empty ones are left out. */
export function joinBlocks(...parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => part != null && part !== "").join("\n\n");
}

/**
 * The lines an ask echoes back: those this burst added or changed (`noted`). An outcome that
 * doesn't say (an engine that doesn't track bursts) echoes every line, as before.
 */
function notedLines(outcome: Extract<EngineOutcome, { type: "ask" }>): readonly OrderLineView[] {
  const lines = outcome.order?.lines ?? [];
  const noted = outcome.noted;
  return noted === undefined ? lines : lines.filter((line) => noted.includes(line.lineId));
}

/** A line the quantities question lists (it names the line itself, so the echo doesn't). */
function waitsForQuantity(line: OrderLineView): boolean {
  return line.quantity === null && !line.restricted;
}

/**
 * "Anotado ✅" with what this burst added or changed, before a question about how the order goes
 * or about one of its lines, so the customer sees what was understood before answering. A line the
 * question names itself isn't echoed: each line is accounted for once. Nothing new: no echo.
 */
function withEcho(
  question: QuestionCode,
  order: OrderView | null,
  text: string,
  lineIndex: number | null,
  noted: readonly OrderLineView[],
): string {
  const echoed: readonly QuestionCode[] = ["pickup_or_delivery", "delivery_place"];
  const aboutLine: readonly QuestionCode[] = ["quantity", "ambiguous_size", "ambiguous_product", "illegible"];
  if (order === null) return text;
  let shown: readonly OrderLineView[] = [];
  if (echoed.includes(question)) shown = noted;
  else if (question === "quantities") shown = noted.filter((line) => !waitsForQuantity(line));
  else if (aboutLine.includes(question) && lineIndex !== null && order.lines[lineIndex] !== undefined) {
    const asked = order.lines[lineIndex]!.lineId;
    shown = noted.filter((line) => line.lineId !== asked);
  }
  return joinBlocks(shown.length > 0 ? echoBlock(shown) : null, text);
}

/** At most this many items are echoed by name; the rest are counted ("• y 2 más"). */
const ECHO_MAX_ITEMS = 4;

/**
 * "Anotado ✅" then one "• 2 Arroz 1 lb" per item, up to four, the rest counted; then the items
 * still without an amount, named once in a sentence. Listed under "Anotado ✅" they would read as
 * settled, and a per-pound name ("Tomate 1 lb") as a chosen pound.
 */
export function echoBlock(lines: readonly OrderLineView[]): string {
  const { noted, missing } = echoParts(lines);
  return joinBlocks(noted, missing);
}

function echoParts(lines: readonly OrderLineView[]): { noted: string | null; missing: string | null } {
  const settled = lines.filter((line) => !waitsForQuantity(line));
  const waiting = lines.filter(waitsForQuantity);
  let noted: string | null = null;
  if (settled.length > 0) {
    const shown = settled.slice(0, ECHO_MAX_ITEMS).map((line) => `• ${shortLine(line)}`);
    if (settled.length > ECHO_MAX_ITEMS) shown.push(`• y ${settled.length - ECHO_MAX_ITEMS} más`);
    noted = [COPY.noted, ...shown].join("\n");
  }
  return { noted, missing: waiting.length > 0 ? missingAmountsBlock(waiting) : null };
}

/** "Me falta saber cuánto querés de Plátano maduro, Tomate y calabacitas." A note, not a question (D-47). */
function missingAmountsBlock(lines: readonly OrderLineView[]): string {
  const names = lines.slice(0, ECHO_MAX_ITEMS).map((line) => (line.productName !== null ? catalogName(line.productName, true) : lineName(line)));
  if (lines.length > ECHO_MAX_ITEMS) names.push(`${lines.length - ECHO_MAX_ITEMS} más`);
  return `Me falta saber cuánto querés de ${spokenList(names)}.`;
}

/** "2 Arroz 1 lb", "2 libras de Pollo entero", "Piña" (no quantity yet). */
function shortLine(line: OrderLineView): string {
  return line.quantity === null ? itemName(line) : `${quantityShown(line)} ${itemName(line)}`;
}

// --- Planner path (D-46, D-47): blocks in a fixed order, echo → assumed → missing amounts → step,
// in one message.

/**
 * One question about one kind of thing, after what was understood: what this burst added or
 * changed that the question doesn't name ("Anotado ✅ • 1 Arroz 1 lb"), then what was assumed ("Te
 * puse 1 de piña."), then what still needs an amount ("Me falta saber cuánto querés de tomate."),
 * then the question, which names its own lines. Every line the burst brought is
 * accounted for exactly once: the echo's count never silently leaves out the one being asked about.
 */
function plannedAskReply(
  order: OrderView,
  questions: AskQuestions,
  assumedIds: readonly string[],
  noted: readonly OrderLineView[],
): RenderedReply {
  const claims: ClaimCheck[] = [stateIn(order, OPEN_STATES)];
  const asked = new Set(
    questions.kind === "options" ? questions.lineIds.filter((id) => (questions.options?.[id] ?? []).length > 0) : questions.lineIds,
  );
  const assumed = order.lines.filter((line) => assumedIds.includes(line.lineId) && !asked.has(line.lineId));
  const echoed = echoParts(noted.filter((line) => !asked.has(line.lineId) && !assumedIds.includes(line.lineId)));
  const body = joinBlocks(
    echoed.noted,
    assumed.length > 0 ? assumedBlock(assumed) : null,
    echoed.missing,
    plannedStepText(order, questions, claims),
  );
  return reply("ask", body, claims);
}

/** "Te puse 1 de piña y catsup. Si querés más, decime." Names only, never a price. */
export function assumedBlock(lines: readonly OrderLineView[]): string {
  const amounts = new Set(lines.map((line) => line.quantity));
  const said =
    amounts.size === 1
      ? `${formatQuantity(lines[0]!.quantity!, null)} de ${spokenList(lines.map(lineName))}`
      : spokenList(lines.map((line) => `${formatQuantity(line.quantity!, null)} de ${lineName(line)}`));
  return `Te puse ${said}. ${amounts.size === 1 && lines[0]!.quantity === "1" ? COPY.assumedMore : COPY.assumedOther}`;
}

/** "a, b y c"; after "sin", "a, b ni c". */
function spokenList(items: readonly string[], conjunction: "y" | "ni" = "y"): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

function plannedStepText(order: OrderView, questions: AskQuestions, claims: ClaimCheck[]): string {
  const lines = questions.lineIds.flatMap((id) => order.lines.filter((line) => line.lineId === id));
  const weighed = (line: OrderLineView) => (questions.byWeight ?? []).includes(line.lineId) || isWeightUnit(line.unit);
  switch (questions.kind) {
    case "quantities": {
      if (lines.length === 1) {
        const line = lines[0]!;
        return weighed(line) ? `¿Cuántas libras querés de ${lineName(line)}?` : `¿Cuánto querés de ${lineName(line)}?`;
      }
      const shown = lines.slice(0, 12).map((line) => `• ${itemName(line)}${weighed(line) ? " (¿cuántas libras?)" : ""}`);
      if (lines.length > 12) shown.push(`…y ${lines.length - 12} más`);
      const example = lines
        .slice(0, 2)
        .map((line, n) => {
          const name = itemName(line).toLocaleLowerCase("es");
          return weighed(line) ? `${n === 0 ? "2 libras" : "1 libra"} de ${name}` : `${n === 0 ? 2 : 1} ${name}`;
        })
        .join(", ");
      return [COPY.quantitiesTitle, ...shown, `Escribime todo junto, por ejemplo: «${example}».`].join("\n");
    }
    case "options": {
      const rows: string[] = [];
      let n = 0;
      for (const line of lines) {
        const options = questions.options?.[line.lineId] ?? [];
        if (options.length === 0) continue;
        rows.push(`Para ${lineName(line)} tengo:`);
        for (const option of options) {
          n += 1;
          if (option.unitPrice === null) {
            rows.push(`${n}. ${quote(option.name)}`);
          } else {
            claims.push(one({ type: "unit_price", productId: option.productId, price: option.unitPrice }));
            rows.push(`${n}. ${quote(option.name)} · ${formatLempiras(option.unitPrice)}`);
          }
        }
      }
      return [...rows, COPY.pickOptionByName].join("\n");
    }
    case "unreadable": {
      if (lines.length === 0) return askText("illegible", null, null);
      return lines.length === 1
        ? `No alcancé a leer bien ${lineName(lines[0]!)}. ¿Me lo escribís?`
        : `No alcancé a leer bien ${spokenList(lines.map(lineName))}. ¿Me los escribís?`;
    }
    case "fulfillment":
      return askText("pickup_or_delivery", null, order);
    case "delivery_place":
      return askText("delivery_place", null, order);
    case "what_to_order":
      return WHAT_TO_ORDER;
    default:
      return unreachable(questions.kind);
  }
}

/**
 * An unclear line's options, numbered, each with its confirmed price (a claim) when there is one,
 * after what else this burst added or changed.
 */
function optionsReply(
  order: OrderView,
  lineIndex: number | null,
  options: readonly ProductOption[],
  noted: readonly OrderLineView[],
): RenderedReply {
  const line = lineIndex === null ? undefined : order.lines[lineIndex];
  const claims: ClaimCheck[] = [stateIn(order, OPEN_STATES)];
  const rows = options.map((option, n) => {
    if (option.unitPrice === null) return `${n + 1}. ${catalogName(option.name)}`;
    claims.push(one({ type: "unit_price", productId: option.productId, price: option.unitPrice }));
    return `${n + 1}. ${catalogName(option.name)} · ${formatLempiras(option.unitPrice)}`;
  });
  const head = line === undefined ? "Tengo estos:" : `Para ${lineName(line)} tengo:`;
  const others = noted.filter((other) => other.lineId !== line?.lineId);
  const echo = others.length > 0 ? echoBlock(others) : null;
  return reply("ask", joinBlocks(echo, [head, ...rows, COPY.pickOption].join("\n")), claims);
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
  const waiting = (order?.lines ?? []).filter(waitsForQuantity);
  if (waiting.length === 0) return "¿Cuántos querés de cada uno?";
  const shown = waiting.slice(0, 12).map((line) => `• ${itemName(line)}`);
  if (waiting.length > 12) shown.push(`…y ${waiting.length - 12} más`);
  const example = waiting
    .slice(0, 2)
    .map((line, n) => `${n === 0 ? 2 : 1} ${itemName(line).toLocaleLowerCase("es")}`)
    .join(", ");
  return ["¿Cuántos querés de cada uno?", ...shown, `Escribime, por ejemplo: «${example}».`].join("\n");
}

/**
 * "¿Te lo llevamos al mismo lugar de siempre?" with the place echoed back and Sí / Otro lugar. The
 * place is the one the engine was given in the customer's context (our records); the outcome
 * names none yet (proposed in the contract). Without it, the question goes with the typed choices.
 */
function samePlaceReply(order: OrderView | null, place: SavedPlace | null, noted: readonly OrderLineView[]): RenderedReply {
  const claims = order === null ? [] : [stateIn(order, OPEN_STATES)];
  const lines: string[] = [COPY.samePlace];
  if (place?.placeText != null) lines.push(`La vez pasada te lo llevamos a: ${quotePlace(place.placeText)}.`);
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
  return reply("ask", joinBlocks(noted.length > 0 ? echoBlock(noted) : null, lines.join("\n")), claims, buttons);
}

// --- Readback

/**
 * The summary, in three blocks: the items (and which ones the store still has to confirm), then
 * how it's received and what it costs, then the question. With buttons, the footer says that a
 * correction can be written or spoken; the typed choices go only if it ends up as plain text.
 */
function readbackReply(template: "readback" | "order_changed" | "rejected_tap", title: string, order: OrderView): RenderedReply {
  const awaiting = order.state === "por_confirmar";
  const claims: ClaimCheck[] = [stateIn(order, [order.state]), ...order.lines.flatMap(stockLeft)];
  const items = order.lines.length === 0 ? [] : [title, ...order.lines.map(readbackLine)];
  const later = order.lines.filter(confirmedLater);
  if (later.length > 0) {
    items.push(later.length === order.lines.length ? `${COPY.confirmLater}.` : `${COPY.confirmLater}: ${spokenList(later.map(itemName))}.`);
  }
  const short = order.lines.find((line) => line.inStock !== undefined);
  const nothingLeft = nothingToPrepare(order.lines);
  // Stock's own question comes first, one at a time. Its answer is written: the order then reads back again.
  const buttons = awaiting && short === undefined && !nothingLeft ? decisionButtons(order) : [];
  // Without buttons to tap, the typed choices are the instruction itself.
  const question = !awaiting
    ? null
    : short !== undefined
      ? stockQuestion(short)
      : nothingLeft
        ? COPY.soldOutAll
        : buttons.length > 0
          ? COPY.confirmQuestion
          : `${COPY.confirmQuestion}\n${COPY.typedFallback}`;
  const receiving = nothingLeft ? null : [...fulfillmentLines(order), moneyLine(order, claims)].join("\n");
  const body = joinBlocks(items.join("\n"), receiving, question);
  const rendered = reply(template, body, claims, buttons);
  return buttons.length === 0 ? rendered : { ...rendered, footer: COPY.fixHint, textFallback: COPY.typedFallbackSoft };
}

/**
 * "• 5 Arroz 1 lb · L 90", the way a receipt reads; the amount only when the store confirmed the
 * price. A weight keeps its unit ("• 1.5 libras de Queso seco · L 105"). What isn't known says so,
 * never a guessed number.
 */
function readbackLine(line: OrderLineView): string {
  const name = itemName(line);
  if (line.restricted) return `• ${name}: eso solo lo vendemos aquí en la tienda.`;
  if (!countsTowardTotal(line)) return `• ${name}: ahorita no hay.`;
  if (line.quantity === null) return `• ${name}: falta la cantidad.`;
  if (line.inStock !== undefined) return `• ${quantityShown(line)} ${name}: me aparecen ${amountLeft(line, line.inStock)}.`;
  // A quantity nobody said is shown openly (D-46): "1 Piña (te puse 1)".
  const assumed = line.quantitySource === "suggested" || line.quantitySource === "store_usual" ? ` (te puse ${formatQuantity(line.quantity, null)})` : "";
  const item = `• ${quantityShown(line)} ${name}${assumed}`;
  const amount = countedLineAmount(line);
  return confirmedLater(line) || amount === null ? item : `${item} · ${formatLempiras(amount)}`;
}

/** "3 libras", or "3" for a line counted without a unit. */
function amountLeft(line: OrderLineView, inStock: DecimalString): string {
  return formatQuantity(inStock, line.byWeight === true ? (line.unit ?? "libra") : line.unit);
}

/**
 * "De Arroz ahorita me aparecen 3. ¿Te mando 3 o lo quitamos?" Says what the records show, never that
 * it's all the store has (PRD §3.4). No buttons: the answer is written and reads back as a new version.
 */
function stockQuestion(line: OrderLineView): string {
  const left = amountLeft(line, line.inStock!);
  return `De ${lineName(line)} ahorita me aparecen ${left}. ¿Te mando ${left} o lo quitamos?\nEscribime ${left} o quitar.`;
}

/** The claim behind the amount a line says is left: the store's verified stock is exactly that now. */
function stockLeft(line: OrderLineView): ClaimCheck[] {
  if (line.inStock === undefined || line.productId === null) return [];
  return [one({ type: "availability", productId: line.productId, availability: "hay", inStock: line.inStock })];
}

/** A line the summary lists under "De estos te confirmo…": no product, or no confirmed price. */
function confirmedLater(line: OrderLineView): boolean {
  if (line.restricted || !countsTowardTotal(line) || line.quantity === null || line.inStock !== undefined) return false;
  return line.productId === null || line.unitPrice === null || countedLineAmount(line) === null;
}

/**
 * "💵 Total: L 104. Pagás cuando lo recogés." The total only when every line's price is known (a
 * claim); a fee only when the store set one. Then how it's paid, once it says how it's received.
 */
function moneyLine(order: OrderView, claims: ClaimCheck[]): string {
  const fee = feeOf(order);
  let total: string = COPY.totalUnknown;
  if (order.total !== null) {
    total =
      fee === null
        ? `Total: ${formatLempiras(order.total)}.`
        : `Total: ${formatLempiras(order.total + fee)} (${formatLempiras(order.total)} + ${formatLempiras(fee)} de envío).`;
    claims.push(one({ type: "order_total", orderId: order.orderId, version: order.version, total: order.total }));
  }
  const pay = payLine(order);
  return `💵 ${pay === null ? total : `${total} ${pay}`}`;
}

/** "5" for whole numbers or no unit; "1.5 libras de" with its unit otherwise. Never "×". */
function quantityShown(line: OrderLineView): string {
  const quantity = line.quantity!;
  // In pounds (planner path): "2 libras de Pollo entero", never "2 Pollo entero", two chickens.
  if (line.byWeight === true) return `${formatQuantity(quantity, line.unit ?? "libra")} de`;
  if (/^\d+$/u.test(quantity) || line.unit === null) return formatQuantity(quantity, null);
  return `${formatQuantity(quantity, line.unit)} de`;
}

/** Whether quantityShown says the line's unit ("2 libras de"), so the name needn't say it again. */
function unitShown(line: OrderLineView): boolean {
  if (line.quantity === null) return false;
  return line.byWeight === true || (!/^\d+$/u.test(line.quantity) && line.unit !== null);
}

/** How the order is paid, once it says how it's received. */
function payLine(order: OrderView): string | null {
  if (order.fulfillment === null) return null;
  return order.fulfillment.mode === "pickup" ? COPY.payOnPickup : COPY.payOnDelivery;
}

/** "🏪 Lo recogés en la tienda." or "📍 Te lo llevamos a: <the place as said>". */
function fulfillmentLines(order: OrderView): string[] {
  const fulfillment = order.fulfillment;
  if (fulfillment === null) return [];
  if (fulfillment.mode === "pickup") return [`🏪 ${COPY.pickup}`];
  const place =
    fulfillment.placeText !== null
      ? `Te lo llevamos a: ${capitalize(quotePlace(fulfillment.placeText))}`
      : fulfillment.pin != null
        ? COPY.deliveryToPin
        : fulfillment.placeId !== null
          ? "Te lo llevamos al lugar que nos diste."
          : "Te lo llevamos. Falta la dirección.";
  return [`📍 ${place}`];
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
    case "preparando": {
      const claims = [stateIn(order, ["confirmado", "preparando"])];
      const waiting = order.openChangeRequest;
      if (waiting != null) {
        const change = changeLines(waiting.diff);
        const body = change.length > 0 ? [COPY.changeRequested, ...change] : [COPY.changeRequestedPlain];
        return reply(template, [...body, COPY.changeRequestedAfter].join("\n"), claims);
      }
      return reply(
        template,
        order.queuePosition === null || order.queuePosition < 1
          ? COPY.statusOnList
          : `${queuePlace(order.queuePosition)} Te aviso apenas esté listo.`,
        claims,
      );
    }
    case "listo": {
      const ready = order.code === undefined ? COPY.statusReady : `Tu pedido #${order.code} ya está listo.`;
      const body = order.fulfillment?.mode === "pickup" ? `${ready} Te esperamos 🙌` : ready;
      return reply(template, body, [stateIn(order, ["listo"])]);
    }
    case "en_camino":
      return reply(template, COPY.statusOnTheWay, [stateIn(order, ["en_camino"])]);
    case "entregado":
      return reply(template, COPY.statusDelivered, [stateIn(order, ["entregado"])]);
    case "cancelado":
      return reply(template, COPY.statusCancelled, [stateIn(order, ["cancelado"])]);
    default:
      return unreachable(order.state);
  }
}

/**
 * A waiting change, as the customer asked it: "• Agregar 3 libras de Arroz", "• Quitar …", "• 2 Coca-Cola
 * 600 ml (antes 1)". What was asked, echoed back, not what the store holds: it claims nothing.
 */
function changeLines(diff: LineDiff | undefined): string[] {
  if (diff === undefined) return [];
  const all = [
    ...diff.added.map((line) => `• Agregar ${shortLine(line)}`),
    ...diff.removed.map((line) => `• Quitar ${shortLine(line)}`),
    ...diff.changed.map(({ before, after }) => `• ${shortLine(after)} (antes ${before.quantity === null ? "sin cantidad" : quantityShown(before)})`),
  ];
  if (all.length <= ECHO_MAX_ITEMS) return all;
  return [...all.slice(0, ECHO_MAX_ITEMS), `• y ${all.length - ECHO_MAX_ITEMS} más`];
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
    const asked = catalogName(fact.asked);
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
      lines.push(`${capitalize(asked)}: ahorita no hay.`);
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
  const without = missing.length === 0 ? "" : `, sin ${spokenList(missing, "ni")}`;
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
    // Nothing to offer after all: say only what's certain. It is still about this order (C11).
    return reply("notice_substitute_offered", COPY.safeReply, [standsOrMovedOn(order)]);
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
  return reply("notice_substitute_offered", `Ahorita no hay ${lineName(line)}. ${question} ${fallback}`, claims, buttons);
}

// --- Helpers

/** A line named inside a sentence: the catalog name, or the customer's words as they came. */
function lineName(line: OrderLineView): string {
  return line.productName !== null ? catalogName(line.productName, line.byWeight === true) : quote(line.text) || "un producto";
}

const COUNT_SUFFIX = /\s*\((?:unidad|und|unid\.?|c\/u)\)\s*$/iu;
const POUND_SUFFIX = /\s+(?:(?:1|una)\s*(?:lb|libra)s?\.?|\(\s*libra\s*\)|por\s+libra|x\s*lb)\s*$/iu;

/**
 * A catalog name as the customer reads it: a trailing "(unidad)"-style tag is dropped, and, when the
 * quantity is shown in pounds, a per-pound size ("Arroz 1 lb" -> "Arroz"). Display only: a name
 * that would end up empty is kept whole, and a size anywhere else stays ("Aceite Clover 1 L").
 */
export function catalogName(name: string, inPounds = false): string {
  const whole = quote(name);
  let shown = whole.replace(COUNT_SUFFIX, "");
  if (inPounds) shown = shown.replace(POUND_SUFFIX, "");
  shown = shown.trim();
  return shown === "" ? whole : shown;
}

/** Whether the line's quantity is shown in pounds ("2 libras de", "media libra de"). */
function shownInPounds(line: OrderLineView): boolean {
  if (line.quantity === null) return false;
  if (line.byWeight === true) return true;
  return unitShown(line) && /^(?:libra|lb)/iu.test(line.unit ?? "");
}

/**
 * A line as a list shows it: a matched product's catalog name; otherwise the customer's words
 * without a leading article or the number (and unit) the list already shows, first letter up,
 * spelling as written: "un carton de huevos" → "Carton de huevos".
 */
export function itemName(line: OrderLineView): string {
  if (line.productName !== null) return catalogName(line.productName, shownInPounds(line));
  const said = saidName(line);
  return said === "" ? "Un producto" : capitalize(said);
}

const LEADING_ARTICLE = /^(?:unos|unas|una|un|los|las|el|la)\s+/iu;
/** Number words that say a quantity the list already shows as a digit. */
const NUMBER_WORDS: Readonly<Record<string, readonly string[]>> = {
  "0.5": ["media", "medio"],
  "2": ["dos"],
  "3": ["tres"],
  "4": ["cuatro"],
  "5": ["cinco"],
  "6": ["seis"],
  "7": ["siete"],
  "8": ["ocho"],
  "9": ["nueve"],
  "10": ["diez"],
};

function saidName(line: OrderLineView): string {
  let said = quote(wordsWithoutQuantity(line.text, line.quantity));
  if (line.quantity !== null) {
    const number = formatQuantity(line.quantity, null);
    const words = [number, ...(NUMBER_WORDS[number] ?? [])];
    const lead = said.split(" ")[0]!.toLocaleLowerCase("es");
    if (words.includes(lead) && said.includes(" ")) said = said.slice(said.indexOf(" ") + 1);
  }
  said = said.replace(LEADING_ARTICLE, "");
  if (unitShown(line)) said = said.replace(unitWords(line.unit ?? "libra"), "");
  return said.trim();
}

/** "libras de ", "lb ", the line's own unit and its plural, at the start of the words. */
function unitWords(unit: string): RegExp {
  const own = unit.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^(?:${own === "" ? "" : `${own}(?:e?s)?|`}libras?|lbs?\\.?)\\s+(?:de\\s+)?`, "iu");
}

/** What goes with a reply's buttons and travels with them: the footer and the text fallback. */
export interface ButtonExtras {
  readonly footer?: string;
  readonly textFallback?: string;
}

/** Only the extras that are set, so a draft or row without them carries no empty keys. */
export function buttonExtras(from: ButtonExtras): ButtonExtras {
  return {
    ...(from.footer === undefined ? {} : { footer: from.footer }),
    ...(from.textFallback === undefined ? {} : { textFallback: from.textFallback }),
  };
}

/** A body that goes as plain text, without its buttons: the typed fallback under it, if it has one. */
export function plainTextBody(body: string, textFallback: string | undefined): string {
  return textFallback === undefined || textFallback === "" ? body : `${body}\n${textFallback}`;
}

/** Customer or catalog words, flattened to one line and capped. Data, never instructions. */
export function quote(text: string): string {
  return flatCapped(text, QUOTE_MAX_CHARS);
}

/** A delivery place as the customer said it: flattened like any quote, with the larger cap. */
export function quotePlace(text: string): string {
  return flatCapped(text, PLACE_QUOTE_MAX_CHARS);
}

function flatCapped(text: string, maxChars: number): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= maxChars ? flat : `${chars.slice(0, maxChars - 1).join("").trimEnd()}…`;
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
      return `availability|${claim.productId}|${claim.availability}|${claim.inStock ?? ""}`;
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
        claims.push({
          type: "availability",
          productId: line.productId,
          availability: line.availability,
          ...(line.inStock === undefined ? {} : { inStock: line.inStock }),
        });
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
      for (const option of [...(outcome.options ?? []), ...Object.values(outcome.questions?.options ?? {}).flat()]) {
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
 * The second check's verdict from verifyClaimChecks' answers: `verified` holds one boolean per claim of
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
