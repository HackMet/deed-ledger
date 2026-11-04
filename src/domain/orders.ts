/** Order versions and line labels. Pure: a version is immutable, a change produces the next one. */
import type { DecimalString } from "./contract/numbers";
import { isDecimalString, toThousandths } from "./contract/numbers";
import type { OrderLineView, OrderView } from "./contract/outcomes";

const LABEL = /^L([1-9]\d{0,8})$/;

/** Line N of a version is "LN", 1-based. `index` is the 0-based position in the line list. */
export function labelOf(index: number): string {
  return `L${index + 1}`;
}

/** The 0-based position a label points at, or null when it isn't a label or is out of range. */
export function indexOfLabel(lineCount: number, label: string): number | null {
  const match = LABEL.exec(label);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index < lineCount ? index : null;
}

/** Never throws and never picks a neighbour: a label that doesn't resolve is null. */
export function lineByLabel(version: Pick<OrderView, "lines">, label: string): OrderLineView | null {
  const index = indexOfLabel(version.lines.length, label);
  return index === null ? null : (version.lines[index] ?? null);
}

export type OrderChangeEdit =
  | { readonly op: "add"; readonly line: OrderLineView }
  | { readonly op: "remove"; readonly label: string }
  | { readonly op: "set_quantity"; readonly label: string; readonly quantity: DecimalString };

export interface NextVersion {
  readonly version: number;
  readonly lines: readonly OrderLineView[];
}

const UNITS = ["uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"];
const TEENS = ["diez", "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve", "veinte"];
const TWENTIES = ["veintiuno", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve"];
const TENS = ["treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];

/** The Spanish whole numbers a customer writes for a quantity, up to cien, in thousandths. */
const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ["un", 1000],
  ["una", 1000],
  ["veintiun", 21000],
  ["cien", 100000],
  ...UNITS.map((word, i) => [word, (i + 1) * 1000] as const),
  ...TEENS.map((word, i) => [word, (i + 10) * 1000] as const),
  ...TWENTIES.map((word, i) => [word, (i + 21) * 1000] as const),
  ...TENS.map((word, i) => [word, (i + 3) * 10000] as const),
]);
const HALF: ReadonlyMap<string, number> = new Map([["media", 500], ["medio", 500]]);

const plain = (word: string): string => word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const LEADING_NUMBER = /^(?:x\s*)?(?:(\d+)\s+)?(\d+\/\d+|\d+(?:[.,]\d+)?)(?:\s+|(?=\p{L}))(?=\S)/iu;
const LEADING_WORDS = /^(\p{L}+)(?:\s+y\s+(\p{L}+))?\s+(?=\S)/u;
const LEADING_WORD = /^(\p{L}+)\s+(?=\S)/u;

function digitsToThousandths(number: string): number | null {
  const [top, bottom] = number.split("/");
  if (bottom !== undefined) return Number(bottom) === 0 ? null : Math.round((Number(top) * 1000) / Number(bottom));
  return toThousandths(number.replace(",", ".").replace(/^0+(?=\d)/, ""));
}

/** The number a line's words start with, in thousandths, and how long it is. Null when they don't start with one. */
function leadingNumber(text: string): { readonly value: number; readonly length: number } | null {
  const digits = LEADING_NUMBER.exec(text);
  if (digits !== null) {
    const part = digitsToThousandths(digits[2]!);
    if (part === null) return null;
    const whole = digits[1] === undefined ? 0 : (toThousandths(digits[1]) ?? 0);
    // "2 1/2" is a mixed number, but "2 3 huevos" is not.
    if (digits[1] !== undefined && !digits[2]!.includes("/")) return null;
    return { value: whole + part, length: digits[0].length };
  }
  const pair = LEADING_WORDS.exec(text);
  if (pair?.[2] !== undefined) {
    const first = NUMBER_WORDS.get(plain(pair[1]!));
    const half = HALF.get(plain(pair[2]));
    const unit = UNITS.includes(plain(pair[2])) ? NUMBER_WORDS.get(plain(pair[2])) : undefined;
    if (first !== undefined && half !== undefined) return { value: first + half, length: pair[0].length };
    if (first !== undefined && first >= 30000 && unit !== undefined) return { value: first + unit, length: pair[0].length };
  }
  const word = LEADING_WORD.exec(text);
  if (word === null) return null;
  const value = NUMBER_WORDS.get(plain(word[1]!)) ?? HALF.get(plain(word[1]!));
  return value === undefined ? null : { value, length: word[0].length };
}

/**
 * The customer's words without a leading number that says the line's own quantity: "2lb azucar" × 2 is "lb azucar".
 * A number that says something else stays, because it is part of the words: "Tres Rosas" × 1, "2 litros de coca" × 3.
 * Only for the customer's words, never a catalog name. The words can't tell a brand from a quantity when the two agree:
 * "Dos Pinos" × 2 reads "Pinos".
 */
export function wordsWithoutQuantity(text: string, quantity: DecimalString | null): string {
  const wanted = quantity === null ? null : toThousandths(quantity);
  const words = text.trim();
  if (wanted === null) return words;
  const lead = leadingNumber(words);
  return lead !== null && lead.value === wanted ? words.slice(lead.length) : words;
}

/**
 * The version after `current` with `change` applied, or null when the change points at a label
 * or quantity that doesn't resolve. `current` is never modified; labels are renumbered by position.
 */
export function nextVersion(
  current: Pick<OrderView, "version" | "lines">,
  change: OrderChangeEdit,
): NextVersion | null {
  const version = current.version + 1;
  if (change.op === "add") {
    // A known quantity must be a non-negative decimal; null stays unknown.
    if (change.line.quantity !== null && !isDecimalString(change.line.quantity)) return null;
    return { version, lines: [...current.lines, change.line] };
  }

  const index = indexOfLabel(current.lines.length, change.label);
  if (index === null) return null;

  if (change.op === "remove") {
    return { version, lines: current.lines.filter((_, i) => i !== index) };
  }
  if (!isDecimalString(change.quantity)) return null;
  return {
    version,
    // An unmatched line's words carry the old quantity; kept, the line would show two numbers.
    lines: current.lines.map((line, i) =>
      i === index
        ? { ...line, quantity: change.quantity, text: line.productId === null ? wordsWithoutQuantity(line.text, line.quantity) : line.text }
        : line,
    ),
  };
}
