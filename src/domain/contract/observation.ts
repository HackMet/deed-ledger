/**
 * Observations: what perception read from one burst, in the order the customer said things. A burst
 * can hold several ("agregale un jabón y lo paso a traer"). Untrusted. They carry no store,
 * product, customer or order IDs, decide nothing, and hold no text a person will read. A missing
 * value is null, meaning unknown: never zero, never a guess.
 */
import type { Centavos, DecimalString } from "./numbers";
import type { QuestionCode } from "./outcomes";

// ---------------------------------------------------------------------------------------------
// Evidence: where in the burst a value came from. `message` is the position in the burst (0 is the
// oldest), never a provider or database ID; code maps it back to the stored message.

export type Evidence =
  /** A box on a photo, corners as fractions of its width and height: [left, top, right, bottom]. */
  | { readonly source: "image"; readonly message: number; readonly box: readonly [number, number, number, number] }
  /** A span of a voice note's transcript, in UTF-16 code units. */
  | { readonly source: "transcript"; readonly message: number; readonly start: number; readonly end: number }
  /** A span of a text message. */
  | { readonly source: "text"; readonly message: number; readonly start: number; readonly end: number };

/** Something perception couldn't settle. The engine turns each into one question. */
export interface ObservationIssue {
  readonly code: "illegible" | "ambiguous_size" | "ambiguous_product" | "embedded_instructions";
  /** The line it's about, by index, when it's about one. */
  readonly line: number | null;
  readonly evidence: Evidence | null;
}

/** A product as the person named it: their words, never a catalog ID. */
export interface ItemLine {
  /** As written or said: "2 coca de 2 litros". */
  readonly text: string;
  /** The product part only: "coca de 2 litros". */
  readonly name: string;
  readonly quantity: DecimalString | null;
  /** As said: "litro", "caja", "libra". Null when none was said. */
  readonly unit: string | null;
  /** Alcohol or tobacco, even for a product the store doesn't list. Code decides what to do. */
  readonly restrictedCategory: boolean;
  readonly evidence: Evidence;
  /**
   * Proposed (Nov 2, planner mode only): up to three other common names the reader proposes for
   * the item ("catsup" → "ketchup", "salsa de tomate"). Only to widen the product search, ranked
   * below the customer's own words; never a match by itself, never shown. Absent: none.
   */
  readonly otherNames?: readonly string[];
}

export interface PricedLine extends ItemLine {
  /** Per unit, when the person said or wrote one. */
  readonly unitPrice: Centavos | null;
}

// ---------------------------------------------------------------------------------------------
// Kinds. Customer kinds come from WhatsApp; console kinds come from the console's mic and camera.

export interface CustomerOrder {
  readonly kind: "customer_order";
  readonly lines: readonly ItemLine[];
}

/**
 * A line of the open order the customer meant: `ref` is one of the context's labels ("L2"), or
 * null when no line clearly fits; `said` is how they named it.
 */
export interface LineTarget {
  readonly ref: string | null;
  readonly said: string;
}

/**
 * Edits against the open order. "agregale dos" is add (+2); "que sean dos" is set (= 2).
 */
export interface OrderChange {
  readonly kind: "order_change";
  readonly edits: readonly (
    | { readonly op: "add"; readonly line: ItemLine }
    | { readonly op: "remove"; readonly target: LineTarget; readonly evidence: Evidence }
    | { readonly op: "set_quantity"; readonly target: LineTarget; readonly quantity: DecimalString; readonly evidence: Evidence }
  )[];
}

export interface OrderCancel {
  readonly kind: "order_cancel";
}

export interface Fulfillment {
  readonly kind: "fulfillment";
  readonly mode: "pickup" | "delivery" | null;
  /** A shared WhatsApp location. Coordinates come from the webhook, not from the model. */
  readonly pin: { readonly latitude: number; readonly longitude: number } | null;
  /** A place in words: "donde la iglesia, casa verde". */
  readonly placeText: string | null;
  /** "al mismo lugar de siempre". */
  readonly sameAsBefore: boolean;
}

export interface PaymentReceipt {
  readonly kind: "payment_receipt";
  readonly amount: Centavos | null;
  readonly bank: string | null;
  /** As printed: perception doesn't reformat it. */
  readonly dateText: string | null;
  readonly reference: string | null;
  readonly evidence: {
    readonly amount: Evidence | null;
    readonly bank: Evidence | null;
    readonly date: Evidence | null;
    readonly reference: Evidence | null;
  };
}

export interface Question {
  readonly kind: "question";
  readonly topic: "order_status" | "price" | "availability" | "balance" | "store_hours" | "other";
  /** Products named in the question, in the customer's words. */
  readonly products: readonly string[];
}

export interface Handoff {
  readonly kind: "handoff";
}

/** ALTO, or a request to delete the customer's data. */
export interface Stop {
  readonly kind: "stop";
  readonly deleteRequested: boolean;
}

export interface SaleReport {
  readonly kind: "sale_report";
  readonly lines: readonly PricedLine[];
}

export interface FiadoReport {
  readonly kind: "fiado_report";
  /** The customer as said: "doña Marta la de la esquina". Code matches it. */
  readonly customer: string;
  readonly lines: readonly PricedLine[];
}

export interface SetupCard {
  readonly kind: "setup_card";
  readonly name: string;
  readonly unit: string | null;
  readonly count: DecimalString | null;
  readonly price: Centavos | null;
  /** From the console's scanner, not from the model. */
  readonly barcode: string | null;
}

export interface SupplierInvoice {
  readonly kind: "supplier_invoice";
  readonly supplier: string | null;
  readonly number: string | null;
  readonly dateText: string | null;
  readonly total: Centavos | null;
  readonly lines: readonly (ItemLine & {
    /** Billed quantity is `quantity`; received, only when the invoice says so. */
    readonly receivedQuantity: DecimalString | null;
    readonly unitCost: Centavos | null;
  })[];
}

/** The customer's answer to the question the engine asked last: "de litro", "sí", "Carla". */
export interface Clarification {
  readonly kind: "clarification";
  /** As written or said. */
  readonly answer: string;
  /**
   * Proposed (Nov 2): when the question offered options (`PerceptionContext.pendingOptions`), the
   * label of the one the customer chose ("mazola porfavor" -> "O3"); null when it isn't clear. Only
   * a label code offered survives validation; code maps it to the product.
   */
  readonly pick?: string | null;
  /**
   * Proposed (Nov 2): when the pending question is `quantity`, the amount the customer gave as an
   * exact decimal ("el paquete" -> "1", "media docena" -> "6"); null when they gave none.
   */
  readonly quantity?: DecimalString | null;
  readonly evidence: Evidence;
}

/** The customer told us their name, asked for or not. */
export interface CustomerName {
  readonly kind: "customer_name";
  readonly name: string;
  readonly evidence: Evidence;
}

export interface Other {
  readonly kind: "other";
}

export type ObservationBody =
  | CustomerOrder
  | OrderChange
  | OrderCancel
  | Fulfillment
  | PaymentReceipt
  | Question
  | Handoff
  | Stop
  | SaleReport
  | FiadoReport
  | SetupCard
  | SupplierInvoice
  | Clarification
  | CustomerName
  | Other;

export type ObservationKind = ObservationBody["kind"];

/** Kinds a customer's WhatsApp burst can produce. */
export const CUSTOMER_KINDS = [
  "customer_order",
  "order_change",
  "order_cancel",
  "fulfillment",
  "payment_receipt",
  "question",
  "handoff",
  "stop",
  "clarification",
  "customer_name",
  "other",
] as const satisfies readonly ObservationKind[];

/** Kinds only the console can produce. */
export const CONSOLE_KINDS = ["sale_report", "fiado_report", "setup_card", "supplier_invoice"] as const satisfies readonly ObservationKind[];

/** One model call, for cost and audit. Never the prompt or the output. */
export interface ModelCall {
  readonly model: string;
  readonly promptVersion: string;
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export type Observation = ObservationBody & {
  readonly issues: readonly ObservationIssue[];
};

/** Everything read from one burst. `observations` is never empty: a burst with nothing is `other`. */
export interface BurstReading {
  readonly observations: readonly Observation[];
  readonly calls: readonly ModelCall[];
}

/**
 * What perception is told about the conversation, by code: the open order's lines under labels the
 * engine maps back (never IDs), and the question the engine asked last. Labels are stable within one
 * order version.
 */
export interface PerceptionContext {
  readonly openOrder: { readonly lines: readonly { readonly ref: string; readonly text: string }[] } | null;
  readonly pendingQuestion: QuestionCode | null;
  /**
   * Proposed (Nov 2): the options the pending question offered, labelled "O1", "O2"… in the order
   * the customer saw them, so perception can say which one an answer chose. Absent means none.
   */
  readonly pendingOptions?: readonly { readonly label: string; readonly text: string }[];
  /**
   * Proposed (Nov 3, planner mode): the products the last answer was about, as named in it, so "me
   * manda una" right after "¿tiene miel?" can be read as that product. Absent means none.
   */
  readonly lastAnswered?: readonly string[];
}

export function isCustomerKind(kind: ObservationKind): boolean {
  return (CUSTOMER_KINDS as readonly ObservationKind[]).includes(kind);
}
