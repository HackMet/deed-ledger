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

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  media: 500, medio: 500, un: 1000, una: 1000, uno: 1000, dos: 2000, tres: 3000, cuatro: 4000, cinco: 5000, seis: 6000,
  siete: 7000, ocho: 8000, nueve: 9000, diez: 10000, once: 11000, doce: 12000, quince: 15000, veinte: 20000,
};
const LEADING_NUMBER = /^x?(\d+\/\d+|\d+(?:[.,]\d+)?)(?:\s+|(?=\p{L}))(?=\S)/iu;
const LEADING_WORD = /^(\p{L}+)\s+(?=\S)/u;

function thousandthsOf(number: string): number | null {
  const [top, bottom] = number.split("/");
  if (bottom === undefined) return toThousandths(number.replace(",", "."));
  const value = (Number(top) * 1000) / Number(bottom);
  return Number.isInteger(value) ? value : null;
}

/**
 * The customer's words without a leading number that says the line's own quantity: "2lb azucar" × 2 is "lb azucar".
 * A number that says something else stays, because it is part of the words: "Tres Rosas" × 1, "2 litros de coca" × 3.
 */
export function wordsWithoutQuantity(text: string, quantity: DecimalString | null): string {
  const wanted = quantity === null ? null : toThousandths(quantity);
  if (wanted === null) return text;
  const number = LEADING_NUMBER.exec(text);
  if (number !== null) return thousandthsOf(number[1]!) === wanted ? text.slice(number[0].length) : text;
  const word = LEADING_WORD.exec(text);
  return word !== null && NUMBER_WORDS[word[1]!.toLocaleLowerCase("es")] === wanted ? text.slice(word[0].length) : text;
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
