/**
 * What an order still needs before it can be read back (contract §6 item 5, D-47). Pure, so both
 * engines can share it. Unmatched products and unknown prices are not missing: they read back as
 * "te confirmo". A quantity asked MAX_QUANTITY_ASKS times stops blocking: the readback says "falta
 * la cantidad", and nothing is guessed.
 */
import type { OrderView } from "./contract/outcomes";
import { countsTowardTotal } from "./money";

export const MAX_QUANTITY_ASKS = 2;

/** In order of need: what to order, how many, pickup or delivery, where. */
export type Missing =
  | { readonly kind: "what_to_order" }
  | { readonly kind: "quantities"; readonly lineIds: readonly string[] }
  | { readonly kind: "fulfillment" }
  | { readonly kind: "delivery_place" };

/** `quantityAsks`: how many times each line (by ID) was asked for its quantity. */
export function missingFor(order: OrderView, quantityAsks: Readonly<Record<string, number>> = {}): Missing[] {
  if (order.lines.length === 0) return [{ kind: "what_to_order" }];
  const missing: Missing[] = [];
  const waiting = order.lines
    .filter((line) => line.quantity === null && countsTowardTotal(line) && (quantityAsks[line.lineId] ?? 0) < MAX_QUANTITY_ASKS)
    .map((line) => line.lineId);
  if (waiting.length > 0) missing.push({ kind: "quantities", lineIds: waiting });
  const fulfillment = order.fulfillment;
  if (fulfillment === null) missing.push({ kind: "fulfillment" });
  else if (fulfillment.mode === "delivery" && fulfillment.placeText === null && fulfillment.placeId === null && (fulfillment.pin ?? null) === null) {
    missing.push({ kind: "delivery_place" });
  }
  return missing;
}
