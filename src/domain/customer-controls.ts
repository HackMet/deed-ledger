/**
 * Customer control words, decided by code from the typed text, whatever a model read: ALTO,
 * SEGUIR, "quiero hablar con Johan", and an explicit request to delete their data. Plus the fixed
 * Spanish lines that answer them and the first reply a new customer gets. Pure: no I/O.
 *
 * Every word is matched against the whole message (any case, accents or punctuation), never a
 * message that merely contains it: "alto" inside an order is not ALTO, and a question about data
 * ("¿borran mis datos si cancelo?") is never a deletion request.
 */

/**
 * The outbox kind of a direct answer to a control word (and the reminder): the only rows dispatch
 * still sends to a stopped customer.
 */
export const CONTROL_REPLY_KIND = "customer_control";

/** Where the public privacy notice is served (src/interfaces/http/privacy.ts). */
export const PRIVACY_PATH = "/privacidad";

export type ControlWord = "stop" | "resume" | "handoff" | "delete";

/** Lowercase, no accents, letters and digits only, single spaces. */
export function normalizeControlText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const STOP_WORDS = new Set(["alto", "stop"]);
const RESUME_WORDS = new Set(["seguir"]);

/** "quiero hablar con Johan", "hablar con una persona", "necesito hablar con el dueño"… */
const HANDOFF = /^(?:(?:yo )?(?:quiero|quisiera|necesito|ocupo|puedo|me gustaria) )?hablar con (?:\S+)(?: \S+){0,3}$/u;

/**
 * Explicit deletion requests only: an imperative or a stated wish, about "mis datos" or "mi
 * informacion", as the whole message. No question marks (a question is never a request).
 */
const DELETE =
  /^(?:(?:por favor|porfa) )?(?:(?:yo )?(?:quiero|quisiera|necesito) (?:que )?)?(?:borren|borres|borrar|borra|borrame|eliminen|elimines|eliminar|elimina)(?: todos)? (?:mis datos|mi informacion|toda mi informacion)(?: (?:por favor|porfa|gracias))?$/u;

/**
 * "No me manden más", "ya no quiero mensajes", "baja": a wish to stop in other words. It doesn't
 * stop anything by itself: the customer is asked, with a one-tap button that is the real ALTO.
 */
const STOP_IN_WORDS =
  /^(?:ya )?(?:no (?:me )?(?:manden|mandes|envien|envies|escriban|escribas)(?: mas)?(?: mensajes)?|no (?:quiero|deseo) (?:recibir )?(?:mas )?mensajes|no mas mensajes|(?:dar(?:me)? de )?baja|dej(?:en|a) de (?:escribirme|mandarme mensajes))(?: (?:por favor|porfa|gracias))?$/u;

/** True when the whole message asks to stop the messages in other words than ALTO. */
export function asksToStop(text: string | null): boolean {
  if (text === null) return false;
  const tidy = normalizeControlText(text);
  return tidy !== "" && tidy.length <= 80 && !STOP_WORDS.has(tidy) && STOP_IN_WORDS.test(tidy);
}

/** The control word a typed message is, alone; null for anything else. */
export function controlWord(text: string | null): ControlWord | null {
  if (text === null) return null;
  const tidy = normalizeControlText(text);
  if (tidy === "" || tidy.length > 120) return null;
  if (STOP_WORDS.has(tidy)) return "stop";
  if (RESUME_WORDS.has(tidy)) return "resume";
  if (!/[?¿]/u.test(text) && DELETE.test(tidy)) return "delete";
  if (HANDOFF.test(tidy)) return "handoff";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Copy. Honduran Spanish with "vos", short, never blaming the customer. The assistant never
// pretends to be the owner or a person.

export interface StoreVoice {
  readonly storeName: string;
  /** The owner's first name, as the console has it; null when unknown. */
  readonly ownerName: string | null;
  /** The public privacy notice; null when PUBLIC_BASE_URL isn't set. */
  readonly privacyUrl: string | null;
}

function reachOwner(voice: StoreVoice): string {
  return voice.ownerName === null
    ? "Si necesitás hablar con alguien de la tienda, pedímelo y le aviso."
    : `Si necesitás hablar con ${voice.ownerName}, pedímelo y le aviso.`;
}

/**
 * The first-contact buttons' IDs. Tapped, they are routed by code, never by a model: the handoff
 * one is the handoff control word (customer-gate.ts), the hours one the store-hours answer.
 */
export const INTRO_BUTTON_IDS = { hours: "intro:hours", handoff: "intro:handoff" } as const;

/** The "¿Pauso los mensajes?" button: tapped, it is ALTO (customer-gate.ts), decided by its ID. */
export const STOP_BUTTON_ID = "control:stop";

/** Asked when someone asks to stop in other words: one tap stops, ALTO typed works too. */
export const STOP_ASK = "¿Pauso los mensajes? 🙏\n_También podés escribir ALTO._";

export const STOP_BUTTONS: readonly { readonly id: string; readonly title: string }[] = [{ id: STOP_BUTTON_ID, title: "Sí, pausar" }];

/** Meta's reply-button title limit, counted the way our check counts it (UTF-16 units). */
const BUTTON_TITLE_MAX = 20;

/** The first line a new customer reads: who this is. */
export function introGreeting(voice: StoreVoice): string {
  return `¡Buenas! 👋 Soy el asistente de *${voice.storeName}* 🛒`;
}

/** The first message's last line, in WhatsApp italics: ALTO, and the privacy notice when there is one. */
export function introFooter(voice: StoreVoice): string {
  const data = voice.privacyUrl === null ? "" : ` Tus datos: ${voice.privacyUrl}`;
  return `_Si no querés recibir mensajes, escribí ALTO.${data}_`;
}

/** The question that opens a conversation that has no order yet. */
export const WELCOME_ASK = "Te tomo el pedido y te aviso cuando esté listo. ¿Qué te mando?";

/** The first reply to a new customer with nothing else to answer: greeting, what to send, ALTO. */
export function introduction(voice: StoreVoice): string {
  return [introGreeting(voice), WELCOME_ASK, introFooter(voice)].join("\n");
}

/** A new customer's first real reply, in the same message: the greeting first, ALTO last. */
export function introduceReply(voice: StoreVoice, body: string): string {
  return [introGreeting(voice), body, introFooter(voice)].join("\n");
}

/**
 * A control word as the very first message: the greeting before its answer. ALTO and deletion
 * already stop the customer, so only the privacy notice follows; a handoff gets the full footer.
 */
export function introduceControl(voice: StoreVoice, word: ControlWord, body: string): string {
  if (word === "handoff") return introduceReply(voice, body);
  const lines = [introGreeting(voice), body];
  if (voice.privacyUrl !== null) lines.push(`_Tus datos: ${voice.privacyUrl}_`);
  return lines.join("\n");
}

/** The first message's buttons: Horario, and Hablar con the owner (or with someone). */
export function introButtons(voice: StoreVoice): readonly { readonly id: string; readonly title: string }[] {
  return [
    { id: INTRO_BUTTON_IDS.hours, title: "🕘 Horario" },
    { id: INTRO_BUTTON_IDS.handoff, title: handoffTitle(voice) },
  ];
}

function handoffTitle(voice: StoreVoice): string {
  const named = voice.ownerName === null ? null : `🙋 Hablar con ${voice.ownerName}`;
  if (named !== null && named.length <= BUTTON_TITLE_MAX) return named;
  // "🙋 Hablar con alguien" is 21 UTF-16 units (the emoji counts two); ✋ counts one.
  return "✋ Hablar con alguien";
}

export function stopConfirmed(voice: StoreVoice): string {
  return `Listo, pausé los mensajes. Si querés que te atienda otra vez, escribí SEGUIR. ${reachOwner(voice)}`;
}

/** Sent once per stop, to a stopped customer who writes something other than a control word. */
export const STOPPED_REMINDER =
  "Tenés los mensajes pausados, por eso no te respondo los pedidos. Si querés que te atienda otra vez, escribí SEGUIR.";

export const RESUMED = "Listo, seguimos. ¿Qué te mando?";

/** No time promise: nobody knows when the owner gets to it. */
export function handoffLine(voice: StoreVoice): string {
  return voice.ownerName === null
    ? "Listo, se lo dejo anotado a la tienda, te escriben por aquí."
    : `Listo, se lo dejo anotado a ${voice.ownerName}, te escribe por aquí.`;
}

/**
 * QUESTION FOR ANGEL: whether "sale and fiado amounts stay, without your name" is the right
 * promise (a fiado with no name can't be collected), and whether we should say how long it takes.
 */
export const DELETION_CONFIRMED =
  "Listo, vamos a borrar tus datos de esta tienda: tu número, tu nombre, tus mensajes, fotos y notas de voz. " +
  "Los montos de tus compras y fiados quedan en las cuentas de la tienda, sin tu nombre ni tu número. " +
  "Ya no te vamos a escribir.";
