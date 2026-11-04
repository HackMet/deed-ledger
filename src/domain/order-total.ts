/** Exact order totals. Integer centavos, rounded per line, half up; never a float. */
import type { Centavos } from "./contract/numbers";
import { toThousandths } from "./contract/numbers";
import type { LineMark } from "./contract/actions";
import type { OrderLineView, OrderView } from "./contract/outcomes";
import { wordsWithoutQuantity } from "./orders";

export interface OrderTotal {
  /**
   * Null when any counted line has an unknown quantity or price, when the delivery fee is unknown or
   * not a whole number of centavos, or when no line is counted: no partial totals.
   */
  readonly total: Centavos | null;
  /** Already part of `total`. Null when the fee is unknown or invalid. */
  readonly delivery: Centavos | null;
  /** 0-based positions of lines left out of the total: restricted, or out of stock. */
  readonly excluded: readonly number[];
}

export function isExcludedFromTotal(line: Pick<OrderLineView, "restricted" | "availability">): boolean {
  return line.restricted || line.availability === "se_acabo";
}

/** A line as staff marked it. No hay means it's out, which also leaves it out of the total. */
export function withLineMark(line: OrderLineView, mark: LineMark): OrderLineView {
  return { ...line, mark, availability: mark === "no_hay" ? "se_acabo" : line.availability };
}

/**
 * The lines of an approved change. Marks belong to the version they were tapped on, but a line a live
 * No hay holds out stays out as se_acabo, whichever came first, the request or the tap. Labels renumber
 * when a line is removed, so the marked line is found by its product and words, each line matched once;
 * a marked line the change removed finds nothing.
 */
export function keepingNoHay(asked: readonly OrderLineView[], current: readonly OrderLineView[]): readonly OrderLineView[] {
  const sameLine = (line: OrderLineView) => (line.productId === null ? `|${wordsWithoutQuantity(line.text, line.quantity)}` : `${line.productId}|${line.text}`);
  const out = new Set<number>();
  for (const marked of current.filter((line) => line.mark === "no_hay")) {
    const free = (line: OrderLineView, index: number) => !out.has(index) && sameLine(line) === sameLine(marked);
    const exact = asked.findIndex((line, index) => free(line, index) && line.quantity === marked.quantity);
    const at = exact >= 0 ? exact : asked.findIndex(free);
    if (at >= 0) out.add(at);
  }
  return asked.map((line, index) => ({ ...line, mark: null, availability: out.has(index) ? "se_acabo" : line.availability }));
}

/** What receiving the order costs: nothing at the counter, the set fee for delivery, unknown until it's said. */
export function deliveryOf(fulfillment: OrderView["fulfillment"]): Centavos | null {
  if (fulfillment === null) return null;
  return fulfillment.mode === "pickup" ? 0 : fulfillment.fee;
}

/** unit price x quantity, rounded half up to the centavo; null if either is unknown. */
export function lineAmount(line: Pick<OrderLineView, "quantity" | "unitPrice">): Centavos | null {
  if (line.quantity === null || line.unitPrice === null) return null;
  const milli = toThousandths(line.quantity);
  // A fractional price is unknown, not an error: BigInt would throw RangeError on it.
  if (milli === null || !Number.isSafeInteger(line.unitPrice)) return null;
  // BigInt keeps the product exact however large; the result is back to a safe integer.
  const rounded = (BigInt(line.unitPrice) * BigInt(milli) + 500n) / 1000n;
  return Number(rounded);
}

/** `deliveryCentavos` is null when the fee is unknown: that makes the total unknown, never 0. */
export function totalOf(lines: readonly OrderLineView[], deliveryCentavos: Centavos | null): OrderTotal {
  const excluded: number[] = [];
  let sum = 0;
  let counted = 0;
  let known = true;
  lines.forEach((line, index) => {
    if (isExcludedFromTotal(line)) {
      excluded.push(index);
      return;
    }
    counted += 1;
    const amount = lineAmount(line);
    if (amount === null) known = false;
    else sum += amount;
  });
  // Number.isInteger, never a coercion: 12.5 centavos is not a fee we can charge.
  const delivery = deliveryCentavos !== null && Number.isInteger(deliveryCentavos) ? deliveryCentavos : null;
  return { total: known && counted > 0 && delivery !== null ? sum + delivery : null, delivery, excluded };
}
