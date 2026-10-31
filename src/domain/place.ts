/**
 * Delivery places (#29). A place is a WhatsApp location pin (coordinates from the webhook, never
 * from the model), a place in the customer's own words, or both. It is saved for a customer only
 * when a delivery order that used it is confirmed, and offered back as a question, never applied.
 */

export interface Pin {
  readonly latitude: number;
  readonly longitude: number;
}

/** A customer's saved place, from our records. The engine gets it in the customer's context. */
export interface SavedPlace {
  readonly placeId: string;
  /** As the customer wrote it. */
  readonly placeText: string | null;
  readonly pin: Pin | null;
}

/** A place in words is kept as written, up to this many characters (the column's limit). */
export const PLACE_TEXT_MAX_CHARS = 300;

/**
 * Coordinates as Meta sends them: numbers (a numeric string is accepted too). Null for anything
 * else or out of range: an unusable pin is dropped, never guessed.
 */
export function parsePin(latitude: unknown, longitude: unknown): Pin | null {
  const lat = coordinate(latitude);
  const lng = coordinate(longitude);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // Rounded to what is stored, so a pin reads back the same from the message and from the place.
  return { latitude: fromE6(toE6(lat)), longitude: fromE6(toE6(lng)) };
}

function coordinate(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d{1,3}(\.\d{1,15})?$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** The place in words, trimmed and capped; null when nothing is left. Kept as written otherwise. */
export function tidyPlaceText(text: string | null): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return null;
  const chars = [...trimmed];
  return chars.length <= PLACE_TEXT_MAX_CHARS ? trimmed : chars.slice(0, PLACE_TEXT_MAX_CHARS).join("");
}

/** Degrees to the stored millionths of a degree (columns *_e6), and back. */
export function toE6(degrees: number): number {
  return Math.round(degrees * 1_000_000);
}

export function fromE6(e6: number): number {
  return e6 / 1_000_000;
}

/** A pin as stored, or null when the columns are empty. */
export function pinFromE6(latitudeE6: number | null, longitudeE6: number | null): Pin | null {
  return latitudeE6 === null || longitudeE6 === null ? null : { latitude: fromE6(latitudeE6), longitude: fromE6(longitudeE6) };
}

/** A map link for whoever delivers. Built from numbers only. */
export function mapLink(pin: Pin): string {
  return `https://www.google.com/maps?q=${pin.latitude},${pin.longitude}`;
}

/** "Sí", "si", "sí, ahí mismo", "dale", "simón": a clear yes to the same-place question. */
export function isYes(answer: string): boolean {
  const folded = answer
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .trim();
  const first = folded.split(/\s+/u)[0] ?? "";
  return ["si", "dale", "simon", "va", "ok", "okay", "claro", "correcto", "ahi", "alli"].includes(first) && !/\bno\b|\botro\b/u.test(folded);
}
