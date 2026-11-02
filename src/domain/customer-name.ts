/**
 * Whether what a customer wrote can be their name, decided by code before it's saved: "Carla",
 * "a nombre de Carla", "soy Doña Marta". Never "sí", "ok", "dale", a number, an emoji, a product
 * or a sentence. Pure: no I/O. The name is customer data: kept as written, quoted back capped.
 */
import { typedReadbackWord } from "./burst";
import { foldShortText, smallTalk } from "./small-talk";

/** The longest name kept, in characters, and the most words. */
export const NAME_MAX_CHARS = 40;
export const NAME_MAX_WORDS = 4;

/** Lead-ins dropped from a name answer. */
const LEAD_IN = /^(?:(?:es |va )?a nombre de|mi nombre es|me llamo|me dicen|soy)\s+/iu;

/** An agreement before the name, followed by a comma or a pause: dropped, the name stays. */
const AGREEMENT = /^(?:(?:ok(?:ey)?|okay|va|vaya|dale|bueno|bien|si|sí|ta bien|está bien|esta bien|listo|claro|perdón|perdon|ah)[\s,.!]+)+/iu;

/** Words that answer something else, never a name. */
const NOT_NAMES = new Set(
  ["no", "nada", "nadie", "ninguno", "yo", "mio", "jaja", "jeje", "ja", "ah", "eh", "mmm", "que", "como", "ya", "aja", "ahorita", "luego"].map(
    foldShortText,
  ),
);

/** A name never starts with these: they open a question, an order or a sentence. */
const NOT_FIRST_WORDS = new Set(
  ["cuanto", "cuando", "donde", "que", "como", "hay", "quiero", "mandame", "tienen", "tenes", "dame", "un", "una", "el", "los", "las", "me", "te", "y", "pero", "con", "sin", "otro", "otra"].map(
    foldShortText,
  ),
);

/**
 * The name in a customer's answer, tidied; null when it isn't one. `products` holds folded catalog
 * names and aliases: an answer that names a product isn't a name.
 */
export function nameFrom(text: string | null, products: ReadonlySet<string> = new Set()): string | null {
  if (text === null || /[?¿]/u.test(text)) return null;
  let name = text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  // "Ta bien, Luis", "ok, a nombre de Luis": the agreement in front isn't part of the name.
  name = name.replace(AGREEMENT, "");
  name = name.replace(LEAD_IN, "");
  name = name.replace(/^[\s"'“”«¡¿.,;:!-]+|[\s"'“”».,;:!?-]+$/gu, "").trim();
  if (name === "" || [...name].length > NAME_MAX_CHARS) return null;
  if (name.split(" ").length > NAME_MAX_WORDS) return null;
  // Letters, spaces, an apostrophe, a dot or a hyphen ("Ma. José", "O'Neil"): no digits, emoji or "?".
  if (!/^[\p{L}][\p{L}\p{M}' .-]*$/u.test(name)) return null;
  const folded = foldShortText(name);
  if (folded === "" || NOT_NAMES.has(folded) || NOT_FIRST_WORDS.has(folded.split(" ")[0]!)) return null;
  if (smallTalk(name) !== null || typedReadbackWord(name) !== null) return null;
  if (products.has(folded)) return null;
  return name;
}
