/**
 * What a store's verified stock says about one order line. Exact: thousandths, never a float. A
 * balance comes only from the store's records, and absent is unknown, never zero (non-negotiable 2).
 */
import { type Thousandths, toThousandths } from "./contract/numbers";
import type { OrderLineView } from "./contract/outcomes";

/**
 * `unknown`: no record, an unmatched or restricted line, or an amount there's nothing to compare with.
 * `short`: some left, under what the customer asked for: they decide, the line stays as they said it.
 */
export type StockVerdict = "unknown" | "enough" | "sold_out" | "short";

export function stockVerdict(line: Pick<OrderLineView, "productId" | "quantity" | "restricted">, balance: Thousandths | null): StockVerdict {
  if (line.productId === null || line.restricted || balance === null) return "unknown";
  if (balance === 0) return "sold_out";
  const asked = line.quantity === null ? null : toThousandths(line.quantity);
  if (asked === null) return "unknown";
  return balance >= asked ? "enough" : "short";
}
