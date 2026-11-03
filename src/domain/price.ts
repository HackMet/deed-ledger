/**
 * Prices the owner types, and the operation key a price change carries.
 * Money is integer centavos (non-negotiable 4): the conversion is string arithmetic, never a float.
 */
import type { Centavos } from "./contract/numbers";

/** Shown whenever a typed price is refused, so the owner learns the format, not just that it failed. */
export const PRICE_FORMAT_HELP = "Escribí el precio en lempiras, por ejemplo 12.50 o 12,50 (hasta 2 decimales).";

const LEMPIRAS = /^(\d{1,7})(?:[.,](\d{1,2}))?$/;

/**
 * "12.50" or "12,50" -> 1250. Null for anything else: a sign, a third decimal, text, empty, or a
 * price of zero (absent means unknown, and a free product is not something a typo should create).
 */
export function parseLempiras(text: string): Centavos | null {
  const match = LEMPIRAS.exec(text.trim());
  if (match === null) return null;
  const [, whole = "", fraction = ""] = match;
  const centavos = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return centavos === 0 ? null : centavos;
}

/** A price the engine accepts: positive integer centavos. */
export const isPrice = (value: unknown): value is Centavos => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * The key a price action must carry (D-44): one product, one minute, one kind of action. A second
 * change inside the same minute reads as a duplicate of the first.
 */
export function priceKey(productId: string, nowMs: number, type: "propose_price" | "confirm_price"): string {
  return `price:${productId}:${Math.floor(nowMs / 60_000)}:${type}`;
}
