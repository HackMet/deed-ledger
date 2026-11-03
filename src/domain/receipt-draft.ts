/**
 * A supplier invoice on the console (K14): the reading validated into a claim, the draft the owner
 * reviews (each line matched to a product or "nuevo"), the owner's edits, and the reasons a draft
 * can't be approved yet. Pure: no I/O.
 *
 * The reading is untrusted (non-negotiable 6): text printed on an invoice is a supplier name or a
 * line name, never an instruction. Nothing here interprets it; it is stored and shown as data.
 */

/** One line as read from the photo. Null means unknown, never 0 (non-negotiable 2). */
export interface ReadLine {
  readonly name: string;
  readonly qtyMilli: number | null;
  /** "caja", "unidad", "libra": as printed, never converted. */
  readonly unit: string | null;
  readonly unitCostCentavos: number | null;
}

/** What a reader returns once validated: `ReceiptReading` is the claim a draft starts from. */
export interface ReceiptReading {
  readonly supplier: string | null;
  /** "YYYY-MM-DD" as printed, or null. */
  readonly date: string | null;
  readonly lines: readonly ReadLine[];
}

export const RECEIPT_LIMITS = { supplier: 120, name: 120, unit: 20, lines: 50, } as const;
/** 1 000 000 units: a typo guard, not a business rule. */
const MAX_QTY_MILLI = 1_000_000_000;
const MAX_COST_CENTAVOS = 100_000_000;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const optionalText = (value: unknown, max: number): string | null | undefined => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? undefined : trimmed;
};

const optionalInteger = (value: unknown, min: number, max: number): number | null | undefined => {
  if (value === null || value === undefined) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
};

/**
 * Schema first: the reading exactly as it will be stored, or null when any field is the wrong type
 * or out of range. A line needs a name; everything else may be unknown.
 */
export function parseReceiptReading(input: unknown): ReceiptReading | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  const supplier = optionalText(raw["supplier"], RECEIPT_LIMITS.supplier);
  const date = raw["date"] === null || raw["date"] === undefined ? null : typeof raw["date"] === "string" && DATE.test(raw["date"]) ? raw["date"] : undefined;
  if (supplier === undefined || date === undefined) return null;
  const rawLines = raw["lines"];
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > RECEIPT_LIMITS.lines) return null;
  const lines: ReadLine[] = [];
  for (const entry of rawLines) {
    if (typeof entry !== "object" || entry === null) return null;
    const line = entry as Record<string, unknown>;
    const name = optionalText(line["name"], RECEIPT_LIMITS.name);
    const unit = optionalText(line["unit"], RECEIPT_LIMITS.unit);
    const qtyMilli = optionalInteger(line["qtyMilli"], 1, MAX_QTY_MILLI);
    const unitCostCentavos = optionalInteger(line["unitCostCentavos"], 0, MAX_COST_CENTAVOS);
    if (name === undefined || name === null || unit === undefined || qtyMilli === undefined || unitCostCentavos === undefined) return null;
    lines.push({ name, qtyMilli, unit, unitCostCentavos });
  }
  return { supplier, date, lines };
}

/** A catalog product as matching sees it. */
export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
}

/** How a line found its product. "owner" is the owner's choice on the review screen. */
export type MatchHow = "exact_name" | "known_alias" | "owner";

export interface DraftLine extends ReadLine {
  /** Null is "nuevo": approving creates a product with the line's name. */
  readonly match: { readonly productId: string; readonly how: MatchHow } | null;
}

/** The draft payload: one revision of what the owner is asked to approve. */
export interface ReceiptDraftBody {
  readonly supplier: string | null;
  readonly date: string | null;
  readonly lines: readonly DraftLine[];
}

/** Case and spacing don't make a different product; accents and spelling do. */
export const nameKey = (name: string): string => name.replace(/\s+/g, " ").trim().toLowerCase();

/** Exact name first, then a known alias; anything else is "nuevo". Never a fuzzy guess. */
export function matchLine(name: string, catalog: readonly CatalogEntry[]): DraftLine["match"] {
  const key = nameKey(name);
  const byName = catalog.find((product) => nameKey(product.name) === key);
  if (byName !== undefined) return { productId: byName.id, how: "exact_name" };
  const byAlias = catalog.find((product) => product.aliases.some((alias) => nameKey(alias) === key));
  return byAlias === undefined ? null : { productId: byAlias.id, how: "known_alias" };
}

/** Revision 1: the reading with each line matched. */
export function draftFromReading(reading: ReceiptReading, catalog: readonly CatalogEntry[]): ReceiptDraftBody {
  return {
    supplier: reading.supplier,
    date: reading.date,
    lines: reading.lines.map((line) => ({ ...line, match: matchLine(line.name, catalog) })),
  };
}

/** One line as the owner sent it from the review form, still text. */
export interface LineEdit {
  readonly name: string;
  /** "12", "1.5"; empty is unknown. */
  readonly qty: string;
  /** Lempiras, "15.50" or "15,50"; empty is unknown. */
  readonly cost: string;
  /** A product id of the store, "nuevo", or "auto" to match the name again. */
  readonly product: string;
  readonly remove: boolean;
}

export type EditResult =
  | { readonly ok: true; readonly body: ReceiptDraftBody }
  | { readonly ok: false; readonly field: "supplier" | "name" | "qty" | "cost" | "product" | "lines"; readonly line: number | null };

const QTY = /^(\d{1,6})(?:[.,](\d{1,3}))?$/;
const COST = /^(\d{1,6})(?:[.,](\d{1,2}))?$/;

/** "1,5" -> 1500. Null for empty; undefined for anything malformed or zero. */
export function parseQtyMilli(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const match = QTY.exec(trimmed);
  if (match === null) return undefined;
  const milli = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  return milli === 0 ? undefined : milli;
}

/** "15,50" -> 1550, "0" -> 0 (a gift line). Null for empty; undefined for anything malformed. */
export function parseCostCentavos(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const match = COST.exec(trimmed);
  if (match === null) return undefined;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/**
 * The owner's edit as the next revision's body, or the first field that is wrong. A product id must
 * be one of the store's (the catalog passed in); the form never decides what exists.
 */
export function applyEdit(
  edit: { readonly supplier: string; readonly lines: readonly LineEdit[] },
  catalog: readonly CatalogEntry[],
  previous: ReceiptDraftBody,
): EditResult {
  const supplier = optionalText(edit.supplier, RECEIPT_LIMITS.supplier);
  if (supplier === undefined) return { ok: false, field: "supplier", line: null };
  const lines: DraftLine[] = [];
  for (const [index, line] of edit.lines.entries()) {
    if (line.remove) continue;
    const n = index + 1;
    const name = optionalText(line.name, RECEIPT_LIMITS.name);
    if (name === undefined || name === null) return { ok: false, field: "name", line: n };
    const qtyMilli = parseQtyMilli(line.qty);
    if (qtyMilli === undefined) return { ok: false, field: "qty", line: n };
    const unitCostCentavos = parseCostCentavos(line.cost);
    if (unitCostCentavos === undefined) return { ok: false, field: "cost", line: n };
    let match: DraftLine["match"];
    if (line.product === "nuevo") match = null;
    else if (line.product === "auto") match = matchLine(name, catalog);
    else if (catalog.some((product) => product.id === line.product)) {
      const before = previous.lines[index]?.match;
      // Keeping the product the draft already had keeps how it was found.
      match = before?.productId === line.product ? before : { productId: line.product, how: "owner" };
    } else return { ok: false, field: "product", line: n };
    lines.push({ name, qtyMilli, unit: previous.lines[index]?.unit ?? null, unitCostCentavos, match });
  }
  if (lines.length === 0 || lines.length > RECEIPT_LIMITS.lines) return { ok: false, field: "lines", line: null };
  return { ok: true, body: { supplier, date: previous.date, lines } };
}

/** The first line approval can't post: a movement needs a known quantity (absent is not 0). */
export function missingQuantity(body: ReceiptDraftBody): number | null {
  const index = body.lines.findIndex((line) => line.qtyMilli === null);
  return index === -1 ? null : index + 1;
}

/** The operation keys (D-44): one approval or one decline per draft, one cancellation per receipt. */
export const receiptApproveKey = (draftId: string): string => `receipt:${draftId}`;
export const receiptReviewKey = (draftId: string): string => `receipt_review:${draftId}`;
export const receiptCancelKey = (receiptFactId: string): string => `receipt_cancel:${receiptFactId}`;

/** Console drafts belong to the store's console, not to a WhatsApp conversation (the ledger's G3 scope). */
export const CONSOLE_CONVERSATION = "console";
