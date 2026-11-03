/**
 * Actions: deliberate taps by a person, not readings. Every action carries an operation key the
 * database keeps unique, so a double tap or a retry saves once and gets the first result back.
 * Order actions carry the version the person saw; the engine refuses a stale one.
 */
import type { Centavos, DecimalString } from "./numbers";

/** Who acted, from the session or the conversation. Never from model output or message text. */
export type Actor =
  | { readonly type: "customer"; readonly customerId: string }
  | { readonly type: "member"; readonly memberId: string; readonly role: "owner" | "staff" };

export interface OrderRef {
  readonly orderId: string;
  /** The version on the person's screen, or in the readback they answered. */
  readonly version: number;
}

// ---------------------------------------------------------------------------------------------
// Customer: the readback's buttons, or the same words typed ("confirmar", "corregir", "cancelar").

export type CustomerAction =
  | ({ readonly type: "confirm_order" } & OrderRef)
  | ({ readonly type: "correct_order" } & OrderRef)
  | ({ readonly type: "cancel_order" } & OrderRef)
  /** "¿Al mismo lugar de siempre?" answered yes. */
  | ({ readonly type: "accept_saved_place"; readonly placeId: string } & OrderRef)
  /** The answer to "No hay X. ¿Te mandamos Y o lo quitamos?". */
  | ({ readonly type: "accept_substitute"; readonly lineId: string } & OrderRef)
  | ({ readonly type: "remove_line"; readonly lineId: string } & OrderRef);

// ---------------------------------------------------------------------------------------------
// Console

export type LineMark = "listo" | "no_hay" | "ofrecer_otro";

export type ConsoleAction =
  // Preparation list (Saturday's gate)
  | ({ readonly type: "start_preparing" } & OrderRef)
  | ({
      readonly type: "mark_line";
      readonly lineId: string;
      readonly mark: LineMark;
      /** With ofrecer_otro: the product staff scanned or picked. The assistant never guesses one. */
      readonly substituteProductId: string | null;
    } & OrderRef)
  | ({ readonly type: "mark_ready" } & OrderRef)
  /**
   * Proposed (K13), pending Angel's OK: a ready delivery order leaves with a courier, an active member
   * of the same store. Pickup orders go from listo straight to mark_delivered.
   */
  | ({ readonly type: "dispatch"; readonly courierMemberId: string } & OrderRef)
  | ({ readonly type: "mark_delivered" } & OrderRef)
  /** Staff decide which catalog product a customer's words meant ("la de marca X"). */
  | ({ readonly type: "match_line"; readonly lineId: string; readonly productId: string } & OrderRef)
  /**
   * Proposed (K12), pending Angel's OK: the answer to a customer's change after confirming. The reason
   * is required, 1–200 characters after trimming, free text stored as data and never interpreted.
   */
  | {
      readonly type: "review_change";
      readonly changeRequestId: string;
      readonly decision: "approve" | "decline";
      readonly reason: string;
    }
  // Money (owner, or staff allowed to approve fiado)
  | { readonly type: "confirm_payment"; readonly paymentClaimId: string }
  | { readonly type: "reject_payment"; readonly paymentClaimId: string }
  | { readonly type: "approve_fiado"; readonly fiadoClaimId: string }
  // Catalog
  | { readonly type: "propose_price"; readonly productId: string; readonly price: Centavos }
  | { readonly type: "confirm_price"; readonly productId: string; readonly price: Centavos }
  | { readonly type: "record_count"; readonly productId: string; readonly count: DecimalString }
  /** Saves what a console observation (sale, fiado, setup card, invoice) proposed, as shown. */
  | { readonly type: "confirm_observation"; readonly observationId: string }
  // Store
  | { readonly type: "set_pause"; readonly paused: boolean }
  | { readonly type: "reply_as_store"; readonly conversationId: string; readonly body: string };

export type ConsoleActionType = ConsoleAction["type"];

/** Only the owner may take these. `approve_fiado` also allows staff with can_approve_fiado. */
export const OWNER_ACTIONS = [
  "confirm_payment",
  "reject_payment",
  "approve_fiado",
  "confirm_price",
  "set_pause",
] as const satisfies readonly ConsoleActionType[];

export interface ActionEnvelope<A> {
  readonly operationKey: string;
  readonly actor: Actor;
  readonly action: A;
}
