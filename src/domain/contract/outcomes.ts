/**
 * Engine outcomes: what happened, as data. Replies are rendered from these by code, from fixed
 * Spanish templates; the engine never writes text a person reads.
 */
import type { LineMark } from "./actions";
import type { Centavos, DecimalString } from "./numbers";
import type { ObservationIssue } from "./observation";
import type { AskKind, QuantitySource } from "../planner/types";

export type OrderState = "armando" | "por_confirmar" | "confirmado" | "preparando" | "listo" | "entregado" | "cancelado";

/** From the latest evidence. Customers never hear a count. */
export type Availability = "hay" | "se_acabo" | "no_se";

export interface OrderLineView {
  readonly lineId: string;
  /** The customer's own words, always kept. */
  readonly text: string;
  /** Null until code or staff matched it to the catalog. */
  readonly productId: string | null;
  readonly productName: string | null;
  readonly quantity: DecimalString | null;
  readonly unit: string | null;
  /** The store's confirmed price only. A proposed price is never quoted to a customer. */
  readonly unitPrice: Centavos | null;
  readonly availability: Availability;
  /** Alcohol or tobacco: "solo en tienda", never priced or confirmed in chat. */
  readonly restricted: boolean;
  readonly mark: LineMark | null;
  /** Offered by staff, waiting on the customer's answer. */
  readonly substitute: { readonly productId: string; readonly productName: string; readonly unitPrice: Centavos | null } | null;
  /**
   * Proposed (Nov 2, planner, D-46): where the quantity came from. Absent means said. A suggested
   * or store-usual quantity is shown openly ("te puse 1") and becomes the agreed one on Confirmar.
   */
  readonly quantitySource?: QuantitySource;
  /**
   * Proposed (Nov 2, planner): the quantity is in pounds (or the weight unit said): the product is
   * sold by weight, or the customer said a weight. Read back as "2 libras de Pollo entero". Absent:
   * a count ("2 × …").
   */
  readonly byWeight?: true;
}

export interface OrderView {
  readonly orderId: string;
  readonly version: number;
  readonly state: OrderState;
  readonly lines: readonly OrderLineView[];
  readonly fulfillment:
    | { readonly mode: "pickup" }
    | {
        readonly mode: "delivery";
        /** The saved place used, when the customer accepted one (accept_saved_place). */
        readonly placeId: string | null;
        /** As the customer wrote it. */
        readonly placeText: string | null;
        /** From store settings only (#40); null when the store set none. Not part of the total. */
        readonly fee: Centavos | null;
        /**
         * Proposed (#29), not agreed yet: a shared WhatsApp location, coordinates from the webhook.
         * Optional until agreed; absent means none.
         */
        readonly pin?: { readonly latitude: number; readonly longitude: number } | null;
      }
    | null;
  /** Null when any line's price is unknown: no partial totals. */
  readonly total: Centavos | null;
  /** Place in the preparation list, 1 is next. Null unless confirmado or preparando. */
  readonly queuePosition: number | null;
  /**
   * Proposed (Nov 2), not agreed yet: the short number the customer and the store say out loud
   * ("101"), unique within the store. Optional until agreed; absent means none.
   */
  readonly code?: string;
}

/** One order on the staff's preparation list. */
export interface PreparationCard {
  readonly order: OrderView;
  /** As the customer gave it; null before they did. */
  readonly customerName: string | null;
  /** When the current version was confirmed: the list's order. */
  readonly confirmedAtMs: number;
  /** Lines that changed in the current version, highlighted for whoever is packing. */
  readonly changedLineIds: readonly string[];
}

/** Proposed (Nov 2): one product offered for an unclear line. Its price is a claim when shown. */
export interface ProductOption {
  readonly productId: string;
  readonly name: string;
  /** The store's confirmed price; null when none is confirmed. */
  readonly unitPrice: Centavos | null;
}

/** At most this many products are offered for one unclear line. */
export const MAX_OPTIONS = 5;

/**
 * Proposed (Nov 2, planner, D-47): one kind of question about several lines in one message: every
 * missing quantity together, or every "which one" together. Never one question per product.
 */
export interface AskQuestions {
  readonly kind: Exclude<AskKind, "none">;
  /** The lines asked about, in order. Empty for pickup or delivery, the place, what to order. */
  readonly lineIds: readonly string[];
  /** For `options`: each line's products, numbered on from one line to the next. */
  readonly options?: Readonly<Record<string, readonly ProductOption[]>>;
  /** For `quantities`: lines sold by weight ("¿cuántas libras?"). */
  readonly byWeight?: readonly string[];
}

/** The one question to ask next. `line` points into the order's lines when it's about one. */
export type QuestionCode =
  | ObservationIssue["code"]
  | "quantity"
  | "pickup_or_delivery"
  | "delivery_place"
  | "same_place"
  | "customer_name"
  // Proposed, not agreed: no order yet, so the next step is what they want.
  | "what_to_order"
  // Proposed (Nov 2): several lines with no quantity, asked together in one question.
  | "quantities";

export interface AnswerFact {
  /** As the customer named it. */
  readonly asked: string;
  readonly productId: string | null;
  readonly unitPrice: Centavos | null;
  readonly availability: Availability;
  readonly restricted: boolean;
}

/**
 * Proposed (#47), not agreed: the store's opening hours, from store settings (#40). One entry per
 * group of days with the same hours. Days are ISO weekdays, 1 is Monday and 7 is Sunday; times are
 * 24-hour "HH:MM" in the store's local time. A day in no entry is closed. Unset is null, never a
 * default schedule.
 */
export interface StoreHoursEntry {
  readonly days: readonly number[];
  readonly opens: string;
  readonly closes: string;
}

export type StoreHours = readonly StoreHoursEntry[];

export type EngineOutcome =
  | {
      readonly type: "ask";
      readonly question: QuestionCode;
      readonly line: number | null;
      readonly order: OrderView | null;
      /**
       * Proposed (Nov 2), not agreed yet: the products that fit an unclear line, at most
       * MAX_OPTIONS, from the store's catalog, so the customer picks one by number or name.
       */
      readonly options?: readonly ProductOption[];
      /** Proposed (Nov 2, planner, D-47): one kind of question about several lines. */
      readonly questions?: AskQuestions;
      /** Proposed (Nov 2, planner, D-46): lines whose quantity was assumed in this burst. */
      readonly assumed?: readonly string[];
    }
  | { readonly type: "readback"; readonly order: OrderView }
  | { readonly type: "order_confirmed"; readonly order: OrderView }
  /**
   * A change after confirming: a new version in por_confirmar, read back for the customer to
   * confirm again. Taps on the old version are refused; the order keeps its place on the list.
   */
  | { readonly type: "order_changed"; readonly order: OrderView }
  | { readonly type: "order_cancelled"; readonly order: OrderView }
  | { readonly type: "order_status"; readonly order: OrderView | null }
  | { readonly type: "answer"; readonly topic: "price" | "availability"; readonly facts: readonly AnswerFact[] }
  /** Proposed (#47): "¿a qué hora abren?". Null when the store hasn't set its hours. */
  | { readonly type: "store_hours"; readonly hours: StoreHours | null }
  | { readonly type: "balance"; readonly balance: Centavos | null }
  /** A receipt was saved as a claim. Only the owner's tap makes it a payment. */
  | { readonly type: "payment_claimed"; readonly paymentClaimId: string }
  | { readonly type: "handoff" }
  | { readonly type: "stopped"; readonly deleteRequested: boolean }
  | { readonly type: "out_of_scope" }
  /** A console action saved. */
  | { readonly type: "action_saved"; readonly order: OrderView | null }
  | {
      readonly type: "rejected";
      readonly reason: "stale_version" | "not_allowed" | "not_found" | "invalid_state";
      /** The current order, so the screen can refresh. */
      readonly order: OrderView | null;
    }
  /** The operation key was already used: nothing saved, and this is the first save's outcome. */
  | { readonly type: "duplicate"; readonly first: EngineOutcome }
  | { readonly type: "nothing" };

/**
 * A message to a customer caused by someone else's action: staff tap Listo, the owner confirms a
 * payment. Rendered by code and queued in the same save as the action.
 */
export interface CustomerNotice {
  readonly customerId: string;
  readonly notice:
    | { readonly type: "order_ready"; readonly order: OrderView }
    | { readonly type: "line_unavailable"; readonly order: OrderView; readonly lineId: string }
    | { readonly type: "substitute_offered"; readonly order: OrderView; readonly lineId: string }
    | { readonly type: "payment_confirmed"; readonly paymentClaimId: string; readonly amount: Centavos }
    | { readonly type: "payment_rejected"; readonly paymentClaimId: string };
}

// ---------------------------------------------------------------------------------------------
// The claim check: before a reply goes out, every claim it makes is read back from the records.

export type Claim =
  | { readonly type: "order_state"; readonly orderId: string; readonly version: number; readonly state: OrderState }
  | { readonly type: "order_total"; readonly orderId: string; readonly version: number; readonly total: Centavos }
  | { readonly type: "unit_price"; readonly productId: string; readonly price: Centavos }
  | { readonly type: "availability"; readonly productId: string; readonly availability: "hay" | "se_acabo" }
  | { readonly type: "payment_confirmed"; readonly paymentClaimId: string; readonly amount: Centavos }
  | { readonly type: "balance"; readonly customerId: string; readonly balance: Centavos }
  /** Proposed (#47): the store's hours are exactly these now (same entries, same order). */
  | { readonly type: "store_hours"; readonly hours: StoreHours };
