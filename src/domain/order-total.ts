/** Exact order totals. Integer centavos, rounded per line, half up; never a float. */
import type { Centavos } from "./contract/numbers";
import { toThousandths } from "./contract/numbers";
import type { OrderLineView } from "./contract/outcomes";

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
