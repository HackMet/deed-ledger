/**
 * The public demo's rules (no I/O). A visitor's demo store is synthetic and lives beside real stores,
 * so everything that could reach the outside world checks these first: a demo store never sends to
 * WhatsApp, never downloads from Meta, and spends from one shared daily budget.
 */

/** Every demo store's business ID starts with this. */
export const DEMO_BUSINESS_PREFIX = "demo-";
/** The one row that pools every demo store's model spend (migration 0032). */
export const DEMO_SPEND_POOL_ID = "demo-pool";
/** US$5 a day for every demo store together (Angel, Nov 5). */
export const DEMO_DAILY_CAP_MICRO_USD = 5_000_000;
/** A demo store's login lasts a day; the store is never offered again after that. */
export const DEMO_STORE_TTL_MS = 24 * 60 * 60 * 1000;
/** New demo stores per visitor (by IP) per hour, and for everyone together. */
export const DEMO_STORES_PER_VISITOR_PER_HOUR = 5;
export const DEMO_STORES_PER_HOUR = 120;
/**
 * Demo stores ever opened, after which the demo stops opening new ones. Demo stores expire but stay in
 * the shared database (memberships and deed checks can't be deleted), so this bounds its growth.
 */
export const DEMO_STORES_TOTAL = 3000;
export const HOUR_MS = 60 * 60 * 1000;

/** Meta's phone number IDs never start with 0; a demo store's always does (16 digits). */
const DEMO_PHONE_NUMBER_ID = /^0[0-9]{15}$/u;
/** The demo's synthetic phones (owner and customer): 15 digits starting with 0, never dialable. */
const DEMO_PHONE = /^0[0-9]{14}$/u;

export function isDemoBusiness(businessId: string): boolean {
  return businessId.startsWith(DEMO_BUSINESS_PREFIX);
}

export function isDemoPhoneNumberId(phoneNumberId: string): boolean {
  return DEMO_PHONE_NUMBER_ID.test(phoneNumberId);
}

export function isDemoPhone(phone: string): boolean {
  return DEMO_PHONE.test(phone);
}

/** A string of `totalLength` decimal digits whose first digit is 0. */
function zeroLed(totalLength: number, random: (n: number) => Uint8Array): string {
  const bytes = random(totalLength - 1);
  return `0${Array.from(bytes, (b) => String(b % 10)).join("")}`;
}

export function newDemoPhoneNumberId(random: (n: number) => Uint8Array): string {
  return zeroLed(16, random);
}

export function newDemoPhone(random: (n: number) => Uint8Array): string {
  return zeroLed(15, random);
}

/** Why a new demo store was refused, if it was. */
export type DemoLimit = "visitor" | "everyone" | null;

export function demoLimitReached(createdLastHourByVisitor: number, createdLastHour: number, createdEver = 0): DemoLimit {
  if (createdLastHourByVisitor >= DEMO_STORES_PER_VISITOR_PER_HOUR) return "visitor";
  if (createdLastHour >= DEMO_STORES_PER_HOUR || createdEver >= DEMO_STORES_TOTAL) return "everyone";
  return null;
}

/**
 * Who a visitor is for the hourly store limit: their IPv4 address, or the /64 network of an IPv6 one
 * (one IPv6 user usually holds a whole /64, so the full address would let them reset the limit).
 */
export function demoVisitorKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::") ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/u, "")).join(":")}::/64`;
}

/** The preset messages on the demo's phone. Photos and voice notes are synthetic files we made. */
export const DEMO_PRESETS = {
  texto: { kind: "text", body: "Buenas, me manda 2 coca de 600 y una libra de frijoles para llevar" },
  lista: { kind: "image", mediaId: "demo-preset-lista", mimeType: "image/jpeg" },
  voz: { kind: "audio", mediaId: "demo-preset-voz", mimeType: "audio/ogg; codecs=opus" },
} as const;

export type DemoPresetName = keyof typeof DEMO_PRESETS;

export function isDemoPreset(value: unknown): value is DemoPresetName {
  return typeof value === "string" && Object.hasOwn(DEMO_PRESETS, value);
}

/** The longest message a visitor can type on the demo's phone. */
export const DEMO_MAX_TEXT = 300;
/** Messages one demo store's phone can send in its life: enough for several orders, not a flood. */
export const DEMO_MAX_MESSAGES_PER_STORE = 40;
/**
 * What one demo voice note is charged against the demo's daily pool before it is transcribed. The
 * transcriber reports no cost and its price isn't recorded here (unknown), so this is a deliberately
 * high estimate for the ~9-second preset: it can only make the cap stricter.
 */
export const DEMO_VOICE_NOTE_MICRO_USD = 10_000;
