/**
 * Engine outcomes: what happened, as data. Replies are rendered from these by code, from fixed
 * Spanish templates; the engine never writes text a person reads.
 */
import type { LineMark } from "./actions";
import type { Centavos, DecimalString } from "./numbers";
import type { ObservationIssue } from "./observation";

/** `en_camino` is proposed (K13), pending Angel's OK: a delivery order out with a courier of the store. */
export type OrderState =
  | "armando"
  | "por_confirmar"
  | "confirmado"
  | "preparando"
  | "listo"
  | "en_camino"
  | "entregado"
  | "cancelado";

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
}

export interface OrderView {
  readonly orderId: string;
  readonly version: number;
  readonly state: OrderState;
  readonly lines: readonly OrderLineView[];
  readonly fulfillment:
    | { readonly mode: "pickup" }
    | { readonly mode: "delivery"; readonly placeId: string | null; readonly placeText: string | null; readonly fee: Centavos | null }
    | null;
  /** Null when any line's price is unknown: no partial totals. */
  readonly total: Centavos | null;
  /** Place in the preparation list, 1 is next. Null unless confirmado or preparando. */
  readonly queuePosition: number | null;
  /**
   * Proposed (K12), pending Angel's OK. The customer's change waiting for the owner or staff, with what
   * it would change; null when none. Optional so views built before K12 still type-check: absent
   * means the engine that built the view doesn't track requests.
   */
  readonly openChangeRequest?: { readonly id: string; readonly diff: LineDiff } | null;
  /** Proposed (K12). The latest answer to a change request of this order; null when none. */
  readonly lastReview?: { readonly decision: "approve" | "decline"; readonly reason: string; readonly atMs: number } | null;
}

/** Proposed (K12). What a change request would do to the current version's lines. */
export interface LineDiff {
  readonly added: readonly OrderLineView[];
  readonly removed: readonly OrderLineView[];
  readonly changed: readonly { readonly before: OrderLineView; readonly after: OrderLineView }[];
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

/** The one question to ask next. `line` points into the order's lines when it's about one. */
export type QuestionCode =
  | ObservationIssue["code"]
  | "quantity"
  | "pickup_or_delivery"
  | "delivery_place"
  | "same_place"
  | "customer_name";

export interface AnswerFact {
  /** As the customer named it. */
  readonly asked: string;
  readonly productId: string | null;
  readonly unitPrice: Centavos | null;
  readonly availability: Availability;
  readonly restricted: boolean;
}

export type EngineOutcome =
  | { readonly type: "ask"; readonly question: QuestionCode; readonly line: number | null; readonly order: OrderView | null }
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
    | { readonly type: "payment_rejected"; readonly paymentClaimId: string }
    /** Proposed (K12): "Tu cambio fue aprobado: …", with the new version. */
    | { readonly type: "change_approved"; readonly order: OrderView }
    /** Proposed (K12): "No pudimos hacer el cambio: <reason>". The order is unchanged. */
    | { readonly type: "change_declined"; readonly order: OrderView; readonly reason: string }
    /**
     * Proposed (K13): "Tu pedido va en camino con <nombre>". The courier's name as the store recorded
     * it; null when the store has none, and the copy then leaves the name out.
     */
    | { readonly type: "order_dispatched"; readonly order: OrderView; readonly courierName: string | null };
}

// ---------------------------------------------------------------------------------------------
// The claim check: before a reply goes out, every claim it makes is read back from the records.

export type Claim =
  | { readonly type: "order_state"; readonly orderId: string; readonly version: number; readonly state: OrderState }
  | { readonly type: "order_total"; readonly orderId: string; readonly version: number; readonly total: Centavos }
  | { readonly type: "unit_price"; readonly productId: string; readonly price: Centavos }
  | { readonly type: "availability"; readonly productId: string; readonly availability: "hay" | "se_acabo" }
  | { readonly type: "payment_confirmed"; readonly paymentClaimId: string; readonly amount: Centavos }
  | { readonly type: "balance"; readonly customerId: string; readonly balance: Centavos };
