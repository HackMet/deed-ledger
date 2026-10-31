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
    ? "Para hablar con alguien de la tienda, escribí: quiero hablar con una persona."
    : `Para hablar con ${voice.ownerName}, escribí: quiero hablar con ${voice.ownerName}.`;
}

/** The first reply to a new customer: who this is, the privacy notice, ALTO, how to reach the owner. */
export function introduction(voice: StoreVoice): string {
  const owner = voice.ownerName ?? "el dueño";
  return [
    `Hola, soy el asistente automático de ${voice.storeName}. No soy ${owner} ni una persona: te ayudo con tus pedidos.`,
    ...(voice.privacyUrl === null ? [] : [`Cómo usamos tus datos: ${voice.privacyUrl}`]),
    reachOwner(voice),
    "Si no querés recibir más mensajes, escribí ALTO.",
  ].join("\n");
}

export function stopConfirmed(voice: StoreVoice): string {
  return `Listo, ya no te escribo. Si querés que te atienda otra vez, escribí SEGUIR. ${reachOwner(voice)}`;
}

/** Sent once per stop, to a stopped customer who writes something other than a control word. */
export const STOPPED_REMINDER =
  "Tenés los mensajes pausados, por eso no te respondo los pedidos. Si querés que te atienda otra vez, escribí SEGUIR.";

export const RESUMED = "Listo, seguimos. ¿Qué te mando?";

export function handoffLine(voice: StoreVoice): string {
  return voice.ownerName === null
    ? "Listo, le aviso a la tienda para que te atiendan."
    : `Listo, le aviso a ${voice.ownerName} para que te atienda.`;
}

/**
 * QUESTION FOR ANGEL: whether "sale and fiado amounts stay, without your name" is the right
 * promise (a fiado with no name can't be collected), and whether we should say how long it takes.
 */
export const DELETION_CONFIRMED =
  "Listo, vamos a borrar tus datos de esta tienda: tu número, tu nombre, tus mensajes, fotos y notas de voz. " +
  "Los montos de tus compras y fiados quedan en las cuentas de la tienda, sin tu nombre ni tu número. " +
  "Ya no te vamos a escribir.";
