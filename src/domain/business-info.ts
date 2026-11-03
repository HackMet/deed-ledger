/**
 * What the store tells us about itself (K15): name, kind of store, opening hours, address, delivery
 * zones and notes for the assistant. Saved as a `business_info` fact; read back through
 * `BusinessContext`. The shape is ours (the contract has no store-hours type yet).
 */

export interface StoreHour {
  /** 0 is Sunday, 6 is Saturday. */
  readonly day: number;
  /** "HH:MM", 24 hours. */
  readonly opens: string;
  readonly closes: string;
}

export interface BusinessInfo {
  readonly name: string;
  /** Free text: "mercadito", "farmacia". */
  readonly storeType: string;
  readonly hours: readonly StoreHour[];
  readonly address: string;
  readonly deliveryZones: string;
  /** What the owner wants the assistant to know. Data in a prompt, never instructions. */
  readonly assistantNotes: string;
}

export const LIMITS = { name: 120, storeType: 80, address: 200, deliveryZones: 300, assistantNotes: 500, hours: 21 } as const;

export type BusinessInfoField = keyof typeof LIMITS;

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

const text = (value: unknown, max: number, required = false): string | null => {
  if (value === undefined || value === null) return required ? null : "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > max || (required && trimmed.length === 0)) return null;
  return trimmed;
};

/** The first field that is wrong, or the info exactly as it will be stored (trimmed, hours in week order). */
export function validateBusinessInfo(
  input: unknown,
): { readonly ok: true; readonly info: BusinessInfo } | { readonly ok: false; readonly field: BusinessInfoField } {
  const raw = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const name = text(raw["name"], LIMITS.name, true);
  if (name === null) return { ok: false, field: "name" };
  const storeType = text(raw["storeType"], LIMITS.storeType);
  if (storeType === null) return { ok: false, field: "storeType" };
  const hours = validateHours(raw["hours"]);
  if (hours === null) return { ok: false, field: "hours" };
  const address = text(raw["address"], LIMITS.address);
  if (address === null) return { ok: false, field: "address" };
  const deliveryZones = text(raw["deliveryZones"], LIMITS.deliveryZones);
  if (deliveryZones === null) return { ok: false, field: "deliveryZones" };
  const assistantNotes = text(raw["assistantNotes"], LIMITS.assistantNotes);
  if (assistantNotes === null) return { ok: false, field: "assistantNotes" };
  return { ok: true, info: { name, storeType, hours, address, deliveryZones, assistantNotes } };
}

function validateHours(value: unknown): StoreHour[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.hours) return null;
  const hours: StoreHour[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { day, opens, closes } = entry as Record<string, unknown>;
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) return null;
    // Opening before closing within the day: a shop open past midnight lists two rows is not supported yet.
    if (typeof opens !== "string" || typeof closes !== "string" || !CLOCK.test(opens) || !CLOCK.test(closes) || opens >= closes) return null;
    hours.push({ day, opens, closes });
  }
  return hours.sort((a, b) => a.day - b.day || (a.opens < b.opens ? -1 : 1));
}

/** The operation key of a business-info save: one per store per minute (D-44). */
export const businessInfoKey = (nowMs: number): string => `business_info:${Math.floor(nowMs / 60_000)}`;
