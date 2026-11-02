/**
 * A receipt claim as the engine holds it in a draft, and the owner-facing copy rendered from it.
 * Pure: no I/O. Copy is Honduran Spanish, short, one decision per message (PRD §6.1).
 */

export interface ReceiptLine {
  readonly name: string;
  readonly qtyMilli: number;
  /** Null means unknown cost, never 0. */
  readonly unitCostCentavos: number | null;
}

/** The validated claim stored in `drafts.payload_json`. */
export interface ReceiptClaim {
  readonly supplier: string;
  readonly lines: readonly ReceiptLine[];
}

/** Stands in for perception until Muse Spark lands: the same claim for every invoice photo. */
export const FIXTURE_CLAIM: ReceiptClaim = {
  supplier: "Distribuidora La Ceiba",
  lines: [
    { name: "Coca-Cola 600 ml", qtyMilli: 12_000, unitCostCentavos: 1500 },
    { name: "Agua Cristal 600 ml", qtyMilli: 24_000, unitCostCentavos: 600 },
  ],
};

/** The owner's "confirmar", ignoring case, accents, spacing and trailing punctuation. */
export function isConfirmation(text: string | null): boolean {
  if (text === null) return false;
  const plain = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return plain === "confirmar";
}

function quantity(qtyMilli: number): string {
  const whole = Math.trunc(qtyMilli / 1000);
  const fraction = String(qtyMilli % 1000).padStart(3, "0").replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}

function lempiras(centavos: number): string {
  return `L ${Math.trunc(centavos / 100)}.${String(centavos % 100).padStart(2, "0")}`;
}

function lineText(line: ReceiptLine): string {
  const cost = line.unitCostCentavos === null ? "" : ` (${lempiras(line.unitCostCentavos)} c/u)`;
  return `- ${quantity(line.qtyMilli)} × ${line.name}${cost}`;
}

export function draftReply(claim: ReceiptClaim): string {
  return [
    `Encontré una factura de ${claim.supplier} con ${claim.lines.length} productos:`,
    ...claim.lines.map(lineText),
    "¿La registro? Confirmar / Corregir / Cancelar",
  ].join("\n");
}

export function savedReply(claim: ReceiptClaim): string {
  return [`Guardado: factura de ${claim.supplier}.`, ...claim.lines.map(lineText)].join("\n");
}

export const ALREADY_SAVED = "Esa factura ya quedó registrada. No la repetí.";
export const NOTHING_PENDING = "No tengo ninguna factura por confirmar. Mandame la foto y la reviso.";

/**
 * The tap arrived for an older version of the draft: say what changed and ask once. Never blames
 * the owner, never shows a revision number (PRD §6.1).
 */
export const DRAFT_CHANGED = "Esa factura cambió después de que la mandé. Te paso la versión nueva para que la revises.";

/** A repeated cancellation, e.g. a redelivered message: say so, change nothing. */
export const ALREADY_CANCELLED = "Esa factura ya estaba cancelada. No hice ningún cambio.";
/** The invoice to cancel isn't one of this store's. */
export const NOTHING_TO_CANCEL = "No encuentro esa factura para cancelarla. Mandame la foto de nuevo y la reviso.";

/** Something the fact depends on was cancelled: one concrete question, not a failure. */
export const DEPENDENCY_CANCELLED = "No puedo registrarla porque algo que necesita quedó cancelado. ¿La volvemos a armar?";
