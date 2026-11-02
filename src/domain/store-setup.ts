/**
 * Store setup (#40): the store's own products, prices, "No hay" marks, hours and delivery fee, as
 * the owner types them in the console. Pure rules, no I/O.
 *
 * Money is parsed from text exactly, never through a float. An absent price stays absent: nothing
 * here defaults a price, a fee or a stock state to zero.
 */
import type { Centavos } from "./contract/numbers";
import type { StoreHours } from "./contract/outcomes";
import { isUsableStoreHours } from "./store-hours";

export const MAX_PRODUCT_NAME = 80;
export const MAX_OTHER_NAMES = 10;
export const MAX_PASTE_LINES = 300;
/** L 999,999.99: more than any mercadito price, well inside a safe integer. */
const MAX_LEMPIRAS_DIGITS = 6;

/** A product as the store keeps it. */
export interface StoreProduct {
  readonly productId: string;
  /** What the store calls it; the first name shown to the model and in the readback. */
  readonly name: string;
  /** Other names customers use, matched by code like the name. */
  readonly otherNames: readonly string[];
  /** Null when the owner hasn't set a price: the bot says "el precio te lo confirmo". */
  readonly price: Centavos | null;
  /** The owner marked it "No hay": the bot says it's out. Unmarked is unknown, never "hay". */
  readonly noHay: boolean;
}

/** Everything the store set up, read per store. */
export interface StoreSetup {
  readonly products: readonly StoreProduct[];
  /** Null until the owner saves hours with at least one open day. */
  readonly hours: StoreHours | null;
  /** Null until the owner sets it. */
  readonly deliveryFee: Centavos | null;
}

/** How names are compared: case, accents and extra spaces don't count ("Azúcar" = "azucar"). */
export function productNameKey(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A name as typed, tidied: spaces collapsed; null when empty or too long. */
export function cleanProductName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  return name === "" || name.length > MAX_PRODUCT_NAME ? null : name;
}

/**
 * Other names, one per line or separated by commas. Blank entries, repeats and the product's own
 * name are dropped; null when one is too long or there are too many.
 */
export function parseOtherNames(raw: string, ownName: string): string[] | null {
  const seen = new Set([productNameKey(ownName)]);
  const out: string[] = [];
  for (const part of raw.split(/[\n,;]/)) {
    const name = part.replace(/\s+/g, " ").trim();
    if (name === "") continue;
    if (name.length > MAX_PRODUCT_NAME) return null;
    const key = productNameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.length > MAX_OTHER_NAMES ? null : out;
}

export type PriceProblem = "no_price" | "comma" | "unreadable" | "zero" | "too_big";

/**
 * Lempiras as text to centavos, exactly: "18", "18.50", "L 18", "L.18", "Lps 18.5". A comma is
 * refused rather than guessed ("18,50" could be 18.50 or 1850), and so is zero: a price is only
 * set when the owner typed one.
 */
export function parseLempiras(raw: string): { readonly price: Centavos } | { readonly problem: PriceProblem } {
  const text = raw.trim().replace(/^(?:lps|lempiras|l)\.?\s*/i, "").replace(/\s*(?:lps|lempiras)\.?$/i, "");
  if (text === "") return { problem: "no_price" };
  if (text.includes(",")) return { problem: "comma" };
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) return { problem: "unreadable" };
  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  if (whole.length > MAX_LEMPIRAS_DIGITS) return { problem: "too_big" };
  const price = Number(whole) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (price === 0) return { problem: "zero" };
  return { price };
}

/** A fee may be zero (free delivery); blank means not set. Same exact parsing as a price. */
export function parseFee(raw: string): { readonly fee: Centavos | null } | { readonly problem: PriceProblem } {
  if (raw.trim() === "") return { fee: null };
  const parsed = parseLempiras(raw);
  if ("price" in parsed) return { fee: parsed.price };
  if (parsed.problem === "zero") return { fee: 0 };
  return parsed;
}

export type PasteProblem = PriceProblem | "no_name" | "name_too_long" | "repeated";

export interface PastedProduct {
  /** 1-based line number in the box. */
  readonly line: number;
  readonly name: string;
  readonly price: Centavos;
}

export interface PastedProblem {
  readonly line: number;
  readonly text: string;
  readonly problem: PasteProblem;
}

export interface PasteResult {
  readonly products: readonly PastedProduct[];
  readonly problems: readonly PastedProblem[];
  /** More lines than one paste takes; the rest were ignored. */
  readonly truncated: boolean;
}

// The name, a separator, then a price that runs to the end of the line. The name is the shortest
// that still leaves a readable price, so "Coca-Cola 2 L - 45" keeps "Coca-Cola 2 L".
const WITH_SEPARATOR = /^(.+?)\s*[-–—,:=|;\t]\s*((?:lps|lempiras|l)\.?\s*[\d.,]+|[\d.,]+)\s*(?:lps\.?|lempiras)?\s*$/i;
// Without a separator, only an explicit "L" marks the price: "Arroz L 18". "Huevos 30" is refused,
// since 30 could be the size.
const WITH_MARKER = /^(.+?)\s+((?:lps|lempiras|l)\.?\s*[\d.,]+)\s*$/i;

/**
 * The paste box: one product per line, "Arroz 1 lb - 18" or "Aceite 1 L, 58". Blank lines are
 * skipped. A line with no readable price is reported, never saved with a guessed one.
 */
export function parsePasteBox(text: string): PasteResult {
  const products: PastedProduct[] = [];
  const problems: PastedProblem[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  let counted = 0;
  let truncated = false;
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim().replace(/^[-*•]\s+/, "");
    if (line === "") return;
    if (counted >= MAX_PASTE_LINES) {
      truncated = true;
      return;
    }
    counted += 1;
    const n = index + 1;
    const parsed = pasteLine(line);
    if ("problem" in parsed) return problems.push({ line: n, text: line, problem: parsed.problem });
    const key = productNameKey(parsed.name);
    if (seen.has(key)) return problems.push({ line: n, text: line, problem: "repeated" });
    seen.add(key);
    products.push({ line: n, name: parsed.name, price: parsed.price });
  });
  return { products, problems, truncated };
}

function pasteLine(line: string): { readonly name: string; readonly price: Centavos } | { readonly problem: PasteProblem } {
  const separated = WITH_SEPARATOR.exec(line);
  const match = separated ?? WITH_MARKER.exec(line);
  if (match === null) return { problem: /\d/.test(line) ? "unreadable" : "no_price" };
  // "Aceite 1 L 58": the L could be the litre or the lempiras. Asked for a separator instead.
  if (separated === null && /\d$/.test(match[1]!.trim())) return { problem: "unreadable" };
  const rawName = match[1]!.replace(/[-–—,:=|;\s]+$/, "");
  if (rawName.replace(/\s+/g, "") === "") return { problem: "no_name" };
  const name = cleanProductName(rawName);
  if (name === null) return { problem: "name_too_long" };
  const price = parseLempiras(match[2]!);
  if ("problem" in price) return price;
  return { name, price: price.price };
}

// --- Hours

/** One day of the week as the hours form shows it. Days are ISO: 1 is Monday, 7 is Sunday. */
export interface DayHours {
  readonly day: number;
  /** Null when closed. */
  readonly opens: string | null;
  readonly closes: string | null;
}

export const DAY_LABELS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"] as const;

/** The seven days of a schedule; a day in no entry is closed. Unset hours show every day closed. */
export function daysOf(hours: StoreHours | null): DayHours[] {
  return [1, 2, 3, 4, 5, 6, 7].map((day) => {
    const entry = hours?.find((e) => e.days.includes(day));
    return { day, opens: entry?.opens ?? null, closes: entry?.closes ?? null };
  });
}

/**
 * The form's seven days as a schedule: days with the same hours share an entry. Null when no day
 * is open (hours unset: the bot says "te confirmo"). Throws nothing: a day that doesn't make a
 * valid schedule makes the whole thing invalid, and the caller shows which.
 */
export function hoursFromDays(days: readonly DayHours[]): { readonly hours: StoreHours | null } | { readonly badDays: number[] } {
  const open = days.filter((d) => d.opens !== null || d.closes !== null);
  const bad = open.filter((d) => d.opens === null || d.closes === null || !isUsableStoreHours([{ days: [d.day], opens: d.opens, closes: d.closes }]));
  if (bad.length > 0) return { badDays: bad.map((d) => d.day) };
  if (open.length === 0) return { hours: null };
  const groups = new Map<string, { days: number[]; opens: string; closes: string }>();
  for (const d of [...open].sort((a, b) => a.day - b.day)) {
    const key = `${d.opens}-${d.closes}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { days: [d.day], opens: d.opens!, closes: d.closes! });
    else group.days.push(d.day);
  }
  const hours: StoreHours = [...groups.values()];
  return isUsableStoreHours(hours) ? { hours } : { badDays: open.map((d) => d.day) };
}
