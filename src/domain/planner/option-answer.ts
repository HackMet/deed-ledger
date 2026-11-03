/**
 * The customer's answer to a "which one" question, read by code (eval E19, E09b, Nov 3): by the
 * number shown ("2", "la segunda"), by the price shown ("esa de 34", "la de L 34"), or by words only
 * one option holds ("mazola", "el clover de litro", "la de 500"). Pure. Null unless the answer
 * points at exactly one option, so it never guesses between two.
 *
 * It runs whatever the model made of the answer: a reading that missed it ("other") or a plan that
 * asked the same list again must not keep the customer in a loop.
 *
 * Only a choice counts (Codex final pass, finding 3, Nov 3): a burst with a "no" anywhere ("no
 * quiero Mazola", "sin la Mazola", "la Mazola no") picks nothing, and a question ("¿cuánto trae la
 * Mazola?", "hay mazola") is not an answer. Then the model's reading stands.
 */
import { optionNumber } from "../answer-words";
import { productWords, searchCatalog } from "../catalog-search";
import type { Centavos } from "../contract/numbers";

/** One option as the customer saw it: its number, its line, and its price as shown. */
export interface ShownOption {
  readonly number: number;
  readonly lineId: string;
  readonly productId: string;
  readonly name: string;
  readonly price: Centavos | null;
}

export function chosenOption(texts: readonly string[], shown: readonly ShownOption[]): ShownOption | null {
  // A word of an option's own name ("Coca Cola sin azúcar") isn't a "no".
  const named = new Set(shown.flatMap((option) => wordsOf(option.name)));
  if (texts.some((text) => wordsOf(text).some((word) => NEGATIONS.has(word) && !named.has(word)))) return null;
  const found = new Set<ShownOption>();
  for (const text of texts) {
    if (asks(text)) continue;
    for (const option of fromText(text, shown)) found.add(option);
  }
  return found.size === 1 ? [...found][0]! : null;
}

const NEGATIONS = new Set(["no", "sin", "ni", "tampoco", "nunca", "ninguno", "ninguna", "ningun"]);
/** Words a question starts with ("cuánto trae…", "hay…"), after an optional "y" or "a" ("y a cómo…"). */
const QUESTION_STARTS = new Set(["que", "cual", "cuales", "cuanto", "cuanta", "cuantos", "cuantas", "como", "donde", "hay", "tiene", "tienen"]);

function wordsOf(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

function asks(text: string): boolean {
  if (/[?¿]/u.test(text)) return true;
  const words = wordsOf(text);
  const first = words.findIndex((word) => word !== "y" && word !== "a" && word !== "en" && word !== "pero");
  return first !== -1 && QUESTION_STARTS.has(words[first]!);
}

function fromText(text: string, shown: readonly ShownOption[]): ShownOption[] {
  const byNumber = optionNumber(text);
  if (byNumber !== null) return shown.filter((option) => option.number === byNumber);
  const out: ShownOption[] = [];
  // A price as shown: "34", "la de 34", "L 34.50".
  for (const said of text.match(/\d+(?:[.,]\d{1,2})?/gu) ?? []) {
    const centavos = Math.round(Number(said.replace(",", ".")) * 100);
    const priced = shown.filter((option) => option.price === centavos);
    if (priced.length === 1) out.push(priced[0]!);
  }
  // Words: every word fits one option, or one word only one option holds.
  const asProducts = shown.map((option) => ({ productId: String(option.number), names: [option.name], aliases: [] }));
  const optionOf = (found: { productId: string }) => shown.find((option) => String(option.number) === found.productId)!;
  const all = searchCatalog(text, asProducts);
  if (all.length === 1) {
    out.push(optionOf(all[0]!));
  } else {
    for (const word of productWords(text)) {
      const holding = searchCatalog(word, asProducts);
      if (holding.length === 1) out.push(optionOf(holding[0]!));
    }
  }
  return out;
}
