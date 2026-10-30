/** Exact order totals. Integer centavos, rounded per line, half up; never a float. */
import type { Centavos } from "./contract/numbers";
import { toThousandths } from "./contract/numbers";
import type { OrderLineView } from "./contract/outcomes";

export interface OrderTotal {
  /** Null when any counted line has an unknown quantity or price: no partial totals. */
  readonly total: Centavos | null;
  /** Already part of `total`. */
  readonly delivery: Centavos;
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
  if (milli === null) return null;
  // BigInt keeps the product exact however large; the result is back to a safe integer.
  const rounded = (BigInt(line.unitPrice) * BigInt(milli) + 500n) / 1000n;
  return Number(rounded);
}

export function totalOf(lines: readonly OrderLineView[], deliveryCentavos: Centavos): OrderTotal {
  const excluded: number[] = [];
  let sum = 0;
  let known = true;
  lines.forEach((line, index) => {
    if (isExcludedFromTotal(line)) {
      excluded.push(index);
      return;
    }
    const amount = lineAmount(line);
    if (amount === null) known = false;
    else sum += amount;
  });
  return { total: known ? sum + deliveryCentavos : null, delivery: deliveryCentavos, excluded };
}
