/**
 * Short answers to the assistant's own questions, read by code: which option ("2", "el segundo"),
 * how many ("dos", "media docena"), and pickup or delivery ("lo recojo", "a domicilio"). Pure. Only
 * clear words count: anything else is null, and the caller leaves the question as it was.
 */
import type { DecimalString } from "./contract/numbers";

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.,\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ORDINALS: Readonly<Record<string, number>> = {
  primero: 1, primera: 1, segundo: 2, segunda: 2, tercero: 3, tercera: 3, cuarto: 4, cuarta: 4, quinto: 5, quinta: 5,
};

/** "2", "el 2", "opción 2", "la segunda": the option's number (1-based), or null. */
export function optionNumber(answer: string): number | null {
  const words = fold(answer).replace(/^(?:el|la|los|las|opcion|numero|no\.?|#)\s+/u, "").trim();
  const digit = /^(\d)(?:\s*(?:porfa|por favor|gracias))?$/u.exec(words);
  if (digit !== null) return Number(digit[1]);
  const ordinal = /^(\p{L}+)(?:\s+(?:opcion|porfa|por favor))?$/u.exec(words);
  return ordinal !== null && Object.hasOwn(ORDINALS, ordinal[1]!) ? ORDINALS[ordinal[1]!]! : null;
}

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  un: "1", uno: "1", una: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8",
  nueve: "9", diez: "10", once: "11", doce: "12", quince: "15", veinte: "20", medio: "0.5", media: "0.5",
};

/**
 * The quantity in a short answer to "¿Cuántos querés?": "3", "2.5", "1,5", "dos", "media docena",
 * "una docena", "3 paquetes". Null when there isn't exactly one clear number.
 */
export function quantityFrom(answer: string): DecimalString | null {
  const words = fold(answer);
  if (/\bmedia docena\b/u.test(words)) return "6";
  if (/\b(?:una )?docena\b/u.test(words)) return "12";
  const numbers = words.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  if (numbers.length === 1) {
    const value = numbers[0]!.replace(",", ".");
    return /^0+(?:\.0+)?$/u.test(value) ? null : value;
  }
  if (numbers.length > 1) return null;
  const said = words.split(" ").filter((word) => Object.hasOwn(NUMBER_WORDS, word));
  return said.length === 1 ? NUMBER_WORDS[said[0]!]! : null;
}

const PICKUP = /\b(?:recog\w*|recoj\w*|traer\w*|traigo|paso|pasare|voy|vengo|busco|buscar\w*|retir\w*|en la tienda|ahi)\b/u;
const DELIVERY = /\b(?:domicilio|llev\w*|mand\w*|envi\w*|entreg\w*|a mi casa|a la casa|delivery)\b/u;

/** "Lo recojo", "paso por el" → pickup; "a domicilio", "me lo lleva" → delivery; both or neither → null. */
export function fulfillmentWords(answer: string): "pickup" | "delivery" | null {
  const words = fold(answer);
  const pickup = PICKUP.test(words);
  const delivery = DELIVERY.test(words);
  if (pickup === delivery) return null;
  return pickup ? "pickup" : "delivery";
}
