/**
 * Short messages decided by code, never by a model: a greeting, a thanks, an "ok", a typed yes, a
 * button's number. Each is matched against the whole message (any case, accents, punctuation or
 * repeated letters), never a message that merely contains one: "hola, mandame 2 libras de arroz"
 * is an order, read as usual. Pure: no I/O.
 */

export type SmallTalk = "greeting" | "thanks" | "ack";

/**
 * Lowercase, no accents, letters, digits and emoji only, single spaces, a letter or emoji repeated
 * in a row kept once ("holaaa", "graciass", "👍👍" → "hola", "gracias", "👍").
 */
export function foldShortText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}]+/gu, " ")
    .replace(/(\p{L}|\p{Extended_Pictographic})\1+/gu, "$1")
    .trim()
    .replace(/\s+/g, " ");
}

const fold = (words: readonly string[]) => new Set(words.map(foldShortText));

/** "Sí" under a readback that waits: the approved list (Oct 31). Anything else is read. */
const YES = fold(["sí", "si", "dale", "va", "ok", "okay", "listo", "confirmo", "así está bien", "👍"]);

const GREETINGS = fold([
  "hola",
  "holi",
  "buenas",
  "buen día",
  "buenos días",
  "buenas tardes",
  "buenas noches",
  "hola buenas",
  "hola buenos días",
  "hola buenas tardes",
  "hola buenas noches",
  "qué tal",
  "hola qué tal",
  "saludos",
  "👋",
]);

const THANKS = fold([
  "gracias",
  "muchas gracias",
  "mil gracias",
  "gracias a vos",
  "ok gracias",
  "va gracias",
  "dale gracias",
  "listo gracias",
  "sí gracias",
  "🙏",
]);

/** An "ok" that answers nothing in particular. The yes words count too. */
const ACKS = fold(["perfecto", "bueno", "está bien", "de acuerdo", "👌", "✅", "🙌", "😊"]);

/** The approved typed yes, alone: Confirmar for a readback the customer was last shown. */
export function isTypedYes(text: string | null): boolean {
  return text !== null && YES.has(foldShortText(text));
}

/** What a short message is, alone; null for anything else (it goes to reading). */
export function smallTalk(text: string | null): SmallTalk | null {
  if (text === null || text.length > 60) return null;
  const folded = foldShortText(text);
  if (folded === "") return null;
  if (GREETINGS.has(folded)) return "greeting";
  if (THANKS.has(folded)) return "thanks";
  if (YES.has(folded) || ACKS.has(folded)) return "ack";
  return null;
}

/**
 * "1", "2" or "3" typed alone (a dot or a bracket around it is fine): the button at that place
 * on the last message, when it had buttons. Null for anything else.
 */
export function typedButtonNumber(text: string | null): number | null {
  if (text === null) return null;
  const match = /^\s*[([]?\s*([1-3])\s*[).\]]?\s*$/u.exec(text);
  return match === null ? null : Number(match[1]);
}
