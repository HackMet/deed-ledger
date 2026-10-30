/** Exact numbers at the contract boundary. No floats cross it. */

/** A non-negative exact decimal as text, at most three decimals: "2", "0.5", "1.250". */
export type DecimalString = string;

/** Integer centavos: L 25.50 is 2550. */
export type Centavos = number;

/** A quantity in integer thousandths, as stored: "1.5" is 1500. */
export type Thousandths = number;

const DECIMAL = /^(0|[1-9]\d{0,8})(\.\d{1,3})?$/;

export function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === "string" && DECIMAL.test(value);
}

export function isCentavos(value: unknown): value is Centavos {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** "L 315" for whole lempiras, "L 25.50" otherwise. */
export function formatLempiras(amount: Centavos): string {
  const lempiras = Math.floor(amount / 100);
  const cents = amount % 100;
  return cents === 0 ? `L ${lempiras}` : `L ${lempiras}.${String(cents).padStart(2, "0")}`;
}

/** Exact conversion, without going through a float. Null for anything that isn't a DecimalString. */
export function toThousandths(value: string): Thousandths | null {
  if (!isDecimalString(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  return Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
}
