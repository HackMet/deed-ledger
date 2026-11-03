/**
 * Order money as customers see it, exact. Proposed answers to contract gap (j), not agreed yet:
 * - a line costs price × quantity, rounded per line, half up, to the centavo;
 * - an unknown quantity or price makes the total unknown ("te confirmo"), never a partial total;
 * - lines that are unavailable (se acabó, or marked no hay) or restricted (solo en tienda) are left out;
 * - the delivery fee is shown on its own and is not part of the order total.
 */
import { type Centavos, type DecimalString, toThousandths } from "./contract/numbers";
import type { OrderLineView, OrderView } from "./contract/outcomes";

/** price × quantity, half up to the centavo, without floats. Null when the quantity isn't exact. */
export function lineAmount(price: Centavos, quantity: DecimalString): Centavos | null {
  const thousandths = toThousandths(quantity);
  if (thousandths === null) return null;
  const exact = BigInt(price) * BigInt(thousandths);
  const rounded = (exact + 500n) / 1000n;
  return rounded > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(rounded);
}

/** Whether a line counts toward the order's total. */
export function countsTowardTotal(line: OrderLineView): boolean {
  return !line.restricted && line.availability !== "se_acabo" && line.mark !== "no_hay";
}

/** A counted line's amount, or null when its price or quantity is unknown. */
export function countedLineAmount(line: OrderLineView): Centavos | null {
  if (line.unitPrice === null || line.quantity === null) return null;
  return lineAmount(line.unitPrice, line.quantity);
}

/** The sum of the counted lines; null as soon as one of them is unknown, or when none counts. */
export function orderSubtotal(order: OrderView): Centavos | null {
  const counted = order.lines.filter(countsTowardTotal);
  if (counted.length === 0) return null;
  let sum = 0;
  for (const line of counted) {
    const amount = countedLineAmount(line);
    if (amount === null) return null;
    sum += amount;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}
