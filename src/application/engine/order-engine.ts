/**
 * The order slice of the engine (#11): a customer's burst becomes a versioned order read back to
 * them, and their taps confirm, cancel or change it. Nothing is saved here: every decision returns
 * `commits` that run in the job's completion batch.
 *
 * Every decision reads first (D-42): a used operation key answers `duplicate` with the stored first
 * outcome, a key that doesn't resolve inside the customer's own orders answers `not_found`, a tap on
 * an older version answers `stale_version`. The commit's guards only settle a race.
 *
 * The ledger is the source and `orders` its read cache (R2): every transition saved here is also
 * exactly one fact, under the same operation key, in the same batch. The order commit goes first so
 * its guards report first; the fact commit's G4 refuses a transition resting on a dead fact.
 */
import { type ActionEnvelope, type ConsoleAction, type CustomerAction, OWNER_ACTIONS, type OrderRef } from "../../domain/contract/actions";
import { CHANGE_WINDOW, changeRequestKey, lineDiff, reviewKey, reviewReason } from "../../domain/change-request";
import { toThousandths } from "../../domain/contract/numbers";
import { type BurstReading, type ItemLine, isCustomerKind, type OrderChange } from "../../domain/contract/observation";
import type {
  Claim,
  CustomerNotice,
  EngineOutcome,
  LineDiff,
  OrderLineView,
  OrderState,
  OrderView,
  PreparationCard,
} from "../../domain/contract/outcomes";
import { deriveOrderState, type OrderFact } from "../../domain/order-state";
import { totalOf } from "../../domain/order-total";
import { indexOfLabel, labelOf, nextVersion } from "../../domain/orders";
import { isPrice, priceKey } from "../../domain/price";
import type { EvidenceRef, FactCommit } from "../../domain/facts";
import type { CustomerContext, Engine, EngineResult, LineMatch, MemberContext } from "../engine";
import { DEED_CLAIM_KINDS, type DeedCheckSource, type DeedChecks } from "./deed-checks";
import type { Clock, Commit, IdSource, Logger, Tenant } from "../ports";

export interface StoredOrder {
  /** The current version, as the customer would read it back. */
  readonly view: OrderView;
  readonly customerId: string;
  readonly firstConfirmedAtMs: number | null;
  /** For an order changed after confirming: the state confirming again returns to (D-38). */
  readonly resumeState: "confirmado" | "preparando" | null;
  /** The current version's fact; null for an order saved before order facts existed. */
  readonly versionFactId: string | null;
  /** The current version's confirm fact; null until the customer confirms this version. */
  readonly confirmFactId: string | null;
  /** The customer's change waiting for review (K12); null when none is live. */
  readonly openRequest: StoredChangeRequest | null;
}

/** A change_request fact as the review reads it: what the customer asked for, on which version. */
export interface StoredChangeRequest {
  readonly id: string;
  readonly orderId: string;
  /** The version the request was made on. */
  readonly version: number;
  /** The whole order as the customer asked for it, labelled. */
  readonly lines: readonly OrderLineView[];
  readonly fulfillment: OrderView["fulfillment"];
  readonly diff: LineDiff;
  /** The inbound job the customer asked with: the evidence an approved version rests on. */
  readonly jobId: string | null;
  /** Not answered, not replaced by a newer request, and its confirm not cancelled or superseded. */
  readonly live: boolean;
}

/** The fact ids the cache keeps after a write, so the next transition can draw its edges. */
export interface OrderFactIds {
  readonly versionFactId: string | null;
  readonly confirmFactId: string | null;
}

/** What the claim check reads of an order: its current version only. */
export interface OrderHead {
  readonly version: number;
  readonly state: OrderState;
  /** Null when unknown. */
  readonly total: number | null;
}

/** One decision to save: the order as it reads after the write, and what the decision read. */
export interface OrderWrite {
  readonly operationKey: string;
  readonly outcome: EngineOutcome;
  readonly customerId: string;
  /** The order as read before deciding; null for a new order. The commit is guarded by it. */
  readonly base: { readonly orderId: string; readonly version: number; readonly state: OrderState } | null;
  readonly order: OrderView;
  /** True when `order` is a version to write (lines and fulfillment), false for a state change. */
  readonly newVersion: boolean;
  /** Sets the first-confirmed time if it isn't set yet: the order's place in line. */
  readonly confirming: boolean;
  readonly auditId: string;
  readonly auditKind:
    | "order_created"
    | "order_changed"
    | "order_confirmed"
    | "order_cancelled"
    | "order_preparing"
    | "order_line_marked"
    | "order_ready"
    | "order_dispatched"
    | "order_delivered"
    | "change_requested"
    | "change_approved"
    | "change_declined";
  /** Who acted, for the audit row: a member on the console. Defaults to the customer. */
  readonly actorId?: string;
  /** More for the audit row's detail, next to the state change. */
  readonly auditDetail?: Readonly<Record<string, unknown>>;
  /** What `orders.version_fact_id` and `orders.confirm_fact_id` hold after this write. */
  readonly facts: OrderFactIds;
  readonly nowMs: number;
}

/** Turns an order fact into its `Commit` (D1FactLedger): guards G4/G5, statements, and P1. */
export interface OrderFactLedger {
  statementsFor(scope: Tenant, commit: FactCommit, nowMs: number): Commit;
}

/** What the records say about one product's price (K6): the live confirmed price and a proposal waiting after it. */
export interface PriceState {
  /** The newest confirmed price fact not closed; null when the product has no price. */
  readonly confirmed: { readonly factId: string; readonly price: number } | null;
  /** The newest live proposal recorded after the live confirmed price (or any, when none): what a confirm rests on. */
  readonly proposal: { readonly factId: string; readonly price: number } | null;
  /** True when a fact already used this operation key. */
  readonly keyUsed: boolean;
}

export interface OrderStore {
  /** The outcome saved first under this key, or null when the key is unused. */
  firstOutcome(tenant: Tenant, operationKey: string): Promise<EngineOutcome | null>;
  /** The customer's open order (not entregado, not cancelado), current version. */
  openOrder(tenant: Tenant, customerId: string): Promise<StoredOrder | null>;
  /** Null unless the order exists in this store. Staff aren't customers: the store is the only scope. */
  order(tenant: Tenant, orderId: string): Promise<StoredOrder | null>;
  /** Null unless the order exists in this store and belongs to this customer. */
  customerOrder(tenant: Tenant, customerId: string, orderId: string): Promise<StoredOrder | null>;
  /** Catalog names of the products that exist in this store; others are left out. */
  productNames(tenant: Tenant, productIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** The current version's number, state and total of an order in this store; null when absent. */
  orderHead(tenant: Tenant, orderId: string): Promise<OrderHead | null>;
  /** An active member of this store, with the name the store knows them by; null otherwise (K13). */
  courier(tenant: Tenant, memberId: string): Promise<{ readonly memberId: string; readonly name: string | null } | null>;
  /** A change request of this store, with its liveness; null when no such request exists here. */
  changeRequest(tenant: Tenant, changeRequestId: string): Promise<StoredChangeRequest | null>;
  /** Every order fact of an order in this store (found by body.orderId), with its liveness. */
  orderFacts(tenant: Tenant, orderId: string): Promise<readonly OrderFact[]>;
  /** Orders confirmado, preparando or listo, oldest first confirmation first (ties by id). */
  preparationOrders(tenant: Tenant): Promise<readonly StoredOrder[]>;
  /**
   * Labels of the lines of `version` that differ from the same line of the version before it
   * (product, words, quantity or unit) or have no counterpart there. Empty for version 1.
   */
  changedLineIds(tenant: Tenant, orderId: string, version: number): Promise<readonly string[]>;
  /** 1 is next, counting orders holding a place in line confirmed before `confirmedAtMs`. */
  queuePosition(tenant: Tenant, orderId: string, confirmedAtMs: number): Promise<number>;
  commitFor(tenant: Tenant, write: OrderWrite): Commit;
  /** Price facts of one product of this store, and whether `operationKey` is already used (K6). */
  priceState(tenant: Tenant, productId: string, operationKey: string): Promise<PriceState>;
}

/** A customer can change these; listo waits at the counter, and a change then needs a person. */
const EDITABLE: readonly OrderState[] = ["armando", "por_confirmar", "confirmado", "preparando"];
/** Once staff are packing, a cancel needs a person. */
const CANCELLABLE: readonly OrderState[] = ["armando", "por_confirmar", "confirmado"];

/** The operation key of a customer's burst: a retried job saves once. */
export const burstKey = (jobId: string): string => `burst:${jobId}`;

/**
 * The operation key a customer action must carry (contract: `confirm:<order>:v<version>`), so a key
 * names one action on one order. Null for actions that save nothing in this cut.
 */
export function actionKey(action: Extract<CustomerAction, { type: "confirm_order" | "cancel_order" | "remove_line" }>): string;
export function actionKey(action: CustomerAction): string | null;
export function actionKey(action: CustomerAction): string | null {
  switch (action.type) {
    case "confirm_order":
      return `confirm:${action.orderId}:v${action.version}`;
    case "cancel_order":
      return `cancel:${action.orderId}:v${action.version}`;
    case "remove_line":
      return `remove:${action.orderId}:v${action.version}:${action.lineId}`;
    default:
      return null;
  }
}

/** The console actions on an order this cut saves: staff move it along the preparation list, then out the door. */
type StaffAction = Extract<ConsoleAction, { type: "start_preparing" | "mark_line" | "mark_ready" | "dispatch" | "mark_delivered" }>;

/** The status an order_status fact records for each staff step; a line mark records the line instead. */
const STAFF_STATUS: Readonly<Record<Exclude<StaffAction["type"], "mark_line">, NonNullable<OrderFact["status"]>>> = {
  start_preparing: "preparing",
  mark_ready: "ready",
  dispatch: "dispatched",
  mark_delivered: "delivered",
};

/**
 * Each staff action's only pre-state and the state it leaves. mark_line records a mark and keeps
 * preparando. A delivery order is delivered from en_camino instead (K13): see `fromState`.
 */
const STAFF_STEPS: Readonly<Record<StaffAction["type"], { from: OrderState; to: OrderState; audit: OrderWrite["auditKind"] }>> = {
  start_preparing: { from: "confirmado", to: "preparando", audit: "order_preparing" },
  mark_line: { from: "preparando", to: "preparando", audit: "order_line_marked" },
  mark_ready: { from: "preparando", to: "listo", audit: "order_ready" },
  dispatch: { from: "listo", to: "en_camino", audit: "order_dispatched" },
  mark_delivered: { from: "listo", to: "entregado", audit: "order_delivered" },
};

/**
 * K13: the state a staff action must find, given how the order leaves the store. Dispatch is for a
 * delivery order only, and a delivery order is delivered once it is en_camino. A fulfillment nobody
 * recorded is neither: dispatch and delivery are refused (null), never guessed.
 */
function fromState(action: StaffAction, fulfillment: OrderView["fulfillment"]): OrderState | null {
  if (action.type !== "dispatch" && action.type !== "mark_delivered") return STAFF_STEPS[action.type].from;
  if (fulfillment === null) return null;
  if (action.type === "dispatch") return fulfillment.mode === "delivery" ? "listo" : null;
  return fulfillment.mode === "delivery" ? "en_camino" : "listo";
}

/** The step a dispatch or a delivery acts on (K13), whose fact it rests on; null for the other steps. */
function restsOnStatus(action: StaffAction, fulfillment: OrderView["fulfillment"]): "ready" | "dispatched" | null {
  if (action.type === "dispatch") return "ready";
  if (action.type === "mark_delivered" && fulfillment?.mode === "delivery") return "dispatched";
  return null;
}

const isStaffAction = (action: ConsoleAction): action is StaffAction => Object.hasOwn(STAFF_STEPS, action.type);

/**
 * The operation key a staff action must carry (D-44): one action on one version of one order, and
 * for a line mark one line, so a double tap saves once.
 */
export function staffKey(action: StaffAction & OrderRef): string {
  const base = `staff:${action.orderId}:${action.version}:${action.type}`;
  return action.type === "mark_line" ? `${base}:${action.lineId}` : base;
}

/** The key a console action must carry as the engine derives it; null for an action that derives none. */
const consoleKeyOf = (member: MemberContext, action: ConsoleAction): string | null => {
  if (action.type === "review_change") return typeof action.changeRequestId === "string" ? reviewKey(action.changeRequestId) : null;
  if (action.type === "propose_price" || action.type === "confirm_price") return priceKey(action.productId, member.nowMs, action.type);
  return isStaffAction(action) ? staffKey(action) : null;
};

/** 1500 -> "1.5": the canonical decimal for a quantity in thousandths. */
export function fromThousandths(milli: number): string {
  const whole = Math.floor(milli / 1000);
  const fraction = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}

/** A quantity as it is stored and read back; zero or anything that isn't a decimal is unknown. */
function canonicalQuantity(quantity: string | null): string | null {
  const milli = quantity === null ? null : toThousandths(quantity);
  return milli === null || milli === 0 ? null : fromThousandths(milli);
}

const result = (outcome: EngineOutcome, commits: readonly Commit[] = []): EngineResult => ({ outcome, notices: [], commits });

/** The Deed's row for a refusal's reason (K20): the table's `source`, and the reason the screen names. */
const DEED_SOURCE: Readonly<Record<"duplicate" | "stale_version" | "invalid_state" | "not_allowed" | "not_found", DeedCheckSource>> = {
  duplicate: "duplicate_key",
  stale_version: "stale_version",
  invalid_state: "gate",
  not_allowed: "not_allowed",
  not_found: "not_found",
};

/** The claim's type when the contract names it, `other` otherwise; never the claim's text. */
const claimKindOf = (claim: Claim): string =>
  (typeof claim === "object" && claim !== null ? DEED_CLAIM_KINDS.find((kind) => kind === claim.type) : undefined) ?? "other";

/** The order a claim names, when it names one of a sane length. Whether it resolves is checked where it is written. */
const orderIdOfClaim = (claim: Claim): string | null =>
  typeof claim === "object" && claim !== null && "orderId" in claim && typeof claim.orderId === "string" && claim.orderId.length <= 64
    ? claim.orderId
    : null;

/** A key as the caller sent it, kept only when it is the key the engine derives for that action (K20). */
const derivedOnly = (key: string, derived: string | null): string | null => (key === derived ? key : null);

/** Whether a version a key embeds is one this order has had, so a typed number never reaches a row (B2). */
const versionResolves = (version: number, current: number): boolean => Number.isSafeInteger(version) && version >= 1 && version <= current;

export class OrderEngine implements Engine {
  /**
   * `checks` is the Deed's record (K20): optional, written after each decision and never in its batch.
   * `clock` stamps the claim checks, which carry no time of their own; `log` gets a failed record's IDs.
   */
  constructor(
    private readonly deps: {
      readonly store: OrderStore;
      readonly ids: IdSource;
      readonly ledger: OrderFactLedger;
      readonly checks?: DeedChecks;
      readonly clock?: Clock;
      readonly log?: Logger;
    },
  ) {}

  async onBurst(context: CustomerContext, reading: BurstReading, matches: readonly LineMatch[]): Promise<EngineResult> {
    const decided = await this.decideBurst(context, reading, matches);
    // The burst's key holds the job's own id, set by the queue and never typed, so it resolves by construction.
    await this.recordRefusal(context, decided.outcome, {
      operationKey: burstKey(context.jobId),
      orderId: null,
      atMs: context.nowMs,
      resolved: async () => true,
    });
    return decided;
  }

  private async decideBurst(context: CustomerContext, reading: BurstReading, matches: readonly LineMatch[]): Promise<EngineResult> {
    const { store } = this.deps;
    const operationKey = burstKey(context.jobId);
    const first = await store.firstOutcome(context, operationKey);
    if (first !== null) return result({ type: "duplicate", first });

    // Console-only kinds are refused whatever perception said; the customer's own kinds go on.
    const observations = reading.observations
      .map((observation, index) => ({ observation, index }))
      .filter(({ observation }) => isCustomerKind(observation.kind));
    if (observations.length === 0) return result({ type: "rejected", reason: "not_allowed", order: null });

    const open = await store.openOrder(context, context.customerId);
    const names = await store.productNames(context, [...new Set(matches.map((m) => m.productId))]);
    const lineFrom = (item: ItemLine, observation: number, line: number): OrderLineView => {
      const match = matches.find((m) => m.observation === observation && m.line === line);
      // A match counts only for a product of this store.
      const productId = match !== undefined && names.has(match.productId) ? match.productId : null;
      return {
        lineId: "",
        text: item.text,
        productId,
        productName: productId === null ? null : (names.get(productId) ?? null),
        quantity: canonicalQuantity(item.quantity),
        unit: item.unit,
        // Only the store's confirmed price is quoted, and none is recorded yet: unknown.
        unitPrice: null,
        availability: "no_se",
        restricted: item.restrictedCategory,
        mark: null,
        substitute: null,
      };
    };

    // With a change waiting for review, a further change adds to what the customer already asked for.
    let lines: readonly OrderLineView[] = open?.openRequest?.lines ?? open?.view.lines ?? [];
    let fulfillment: OrderView["fulfillment"] = open?.openRequest?.fulfillment ?? open?.view.fulfillment ?? null;
    let changed = false;
    let cancel = false;
    let info: EngineOutcome | null = null;

    for (const { observation, index } of observations) {
      switch (observation.kind) {
        case "customer_order":
          // D-39: with an order open, a new order adds to it.
          lines = [...lines, ...observation.lines.map((item, line) => lineFrom(item, index, line))];
          changed = true;
          break;
        case "order_change": {
          const next = applyChange(lines, observation, (item, edit) => lineFrom(item, index, edit));
          if (next === null) {
            // A label that doesn't resolve is a question, never a guess; nothing of the burst is saved.
            return result({ type: "ask", question: "ambiguous_product", line: null, order: open?.view ?? null });
          }
          lines = next;
          changed = true;
          break;
        }
        case "fulfillment":
          if (observation.mode === "pickup") fulfillment = { mode: "pickup" };
          if (observation.mode === "delivery") {
            fulfillment = { mode: "delivery", placeId: null, placeText: observation.placeText, fee: null };
          }
          changed ||= observation.mode !== null;
          break;
        case "order_cancel":
          cancel = true;
          break;
        case "question":
          info ??= observation.topic === "order_status" ? { type: "order_status", order: open?.view ?? null } : { type: "nothing" };
          break;
        case "handoff":
          info ??= { type: "handoff" };
          break;
        case "other":
          // Text inside a photo or a voice note is data: nothing here changes an order.
          info ??= { type: "out_of_scope" };
          break;
        default:
          // payment_receipt, stop, clarification, customer_name: not in this cut (#11). Nothing saved.
          info ??= { type: "nothing" };
      }
    }

    if (cancel) {
      if (open === null) return result({ type: "rejected", reason: "not_found", order: null });
      return this.cancel(context, operationKey, open);
    }
    if (changed) return this.change(context, operationKey, open, lines, fulfillment);
    return result(info ?? { type: "nothing" });
  }

  async onCustomerAction(context: CustomerContext, envelope: ActionEnvelope<CustomerAction>): Promise<EngineResult> {
    const decided = await this.decideCustomerAction(context, envelope);
    await this.recordRefusal(context, decided.outcome, {
      operationKey: derivedOnly(envelope.operationKey, actionKey(envelope.action)),
      orderId: "orderId" in envelope.action ? envelope.action.orderId : null,
      atMs: context.nowMs,
      resolved: () => this.customerKeyResolves(context, envelope.action),
    });
    return decided;
  }

  /** Whether the order, the version and the line label a customer's key embeds all resolve here (B1). */
  private async customerKeyResolves(context: CustomerContext, action: CustomerAction): Promise<boolean> {
    if (action.type !== "confirm_order" && action.type !== "cancel_order" && action.type !== "remove_line") return false;
    const stored = await this.deps.store.customerOrder(context, context.customerId, action.orderId);
    if (stored === null || !versionResolves(action.version, stored.view.version)) return false;
    // A label points into the change waiting for review when there is one, as the removal does.
    return action.type !== "remove_line" || indexOfLabel((stored.openRequest ?? stored.view).lines.length, action.lineId) !== null;
  }

  private async decideCustomerAction(context: CustomerContext, envelope: ActionEnvelope<CustomerAction>): Promise<EngineResult> {
    const { store } = this.deps;
    // The actor comes from the conversation; an envelope for anyone else is refused.
    if (envelope.actor.type !== "customer" || envelope.actor.customerId !== context.customerId) {
      return result({ type: "rejected", reason: "not_allowed", order: null });
    }

    // The button's order id is untrusted: it resolves only inside this customer's own orders.
    const { action } = envelope;
    const stored = await store.customerOrder(context, context.customerId, action.orderId);
    if (stored === null) {
      const own = await store.openOrder(context, context.customerId);
      return result({ type: "rejected", reason: "not_found", order: own?.view ?? null });
    }
    // The key must be the one this action on this order derives: an unrelated string is refused, so a
    // key can only ever name an order that passed the check above.
    const expected = actionKey(action);
    // correct_order, accept_saved_place, accept_substitute: not in this cut (#11). Nothing is read or saved.
    if (expected === null) return result({ type: "nothing" });
    if (envelope.operationKey !== expected) return result({ type: "rejected", reason: "not_allowed", order: null });
    // Only now is the key this customer's own: a replay answers from the first outcome, before the version check.
    const first = await store.firstOutcome(context, envelope.operationKey);
    if (first !== null) return result({ type: "duplicate", first });

    const { view } = stored;
    if (action.version !== view.version) return result({ type: "rejected", reason: "stale_version", order: view });

    switch (action.type) {
      case "confirm_order":
        return this.confirm(context, envelope.operationKey, stored);
      case "cancel_order":
        return this.cancel(context, envelope.operationKey, stored);
      case "remove_line": {
        // With a change waiting for review, the label points into what the customer asked for.
        const base = stored.openRequest ?? view;
        const index = indexOfLabel(base.lines.length, action.lineId);
        if (index === null) return result({ type: "rejected", reason: "not_found", order: view });
        const next = nextVersion({ version: view.version, lines: base.lines }, { op: "remove", label: action.lineId });
        if (next === null) return result({ type: "rejected", reason: "not_found", order: view });
        return this.change(context, envelope.operationKey, stored, next.lines, base.fulfillment);
      }
      default:
        return result({ type: "nothing" });
    }
  }

  /**
   * Typed "confirmar" or "cancelar": the action on the last version read back to this customer,
   * under the same key the button carries, so typing and tapping save once. Null when nothing
   * waits for their answer.
   */
  async typedAction(context: CustomerContext, type: "confirm_order" | "cancel_order"): Promise<ActionEnvelope<CustomerAction> | null> {
    const open = await this.deps.store.openOrder(context, context.customerId);
    if (open === null || open.view.state !== "por_confirmar") return null;
    const { orderId, version } = open.view;
    return {
      operationKey: actionKey({ type, orderId, version }),
      actor: { type: "customer", customerId: context.customerId },
      action: { type, orderId, version },
    };
  }

  async onConsoleAction(member: MemberContext, envelope: ActionEnvelope<ConsoleAction>): Promise<EngineResult> {
    const decided = await this.decideConsoleAction(member, envelope);
    await this.recordRefusal(member, decided.outcome, {
      operationKey: derivedOnly(envelope.operationKey, consoleKeyOf(member, envelope.action)),
      orderId: "orderId" in envelope.action ? envelope.action.orderId : null,
      atMs: member.nowMs,
      resolved: () => this.consoleKeyResolves(member, envelope.action),
    });
    return decided;
  }

  /** Whether the request, product, order, version or line label a staff key embeds all resolve here (B1). */
  private async consoleKeyResolves(member: MemberContext, action: ConsoleAction): Promise<boolean> {
    const { store } = this.deps;
    if (action.type === "review_change") {
      return typeof action.changeRequestId === "string" && (await store.changeRequest(member, action.changeRequestId)) !== null;
    }
    if (action.type === "propose_price" || action.type === "confirm_price") {
      return typeof action.productId === "string" && (await store.productNames(member, [action.productId])).size > 0;
    }
    if (!isStaffAction(action)) return false;
    const stored = await store.order(member, action.orderId);
    if (stored === null || !versionResolves(action.version, stored.view.version)) return false;
    return action.type !== "mark_line" || indexOfLabel(stored.view.lines.length, action.lineId) !== null;
  }

  private async decideConsoleAction(member: MemberContext, envelope: ActionEnvelope<ConsoleAction>): Promise<EngineResult> {
    const { store } = this.deps;
    const refused = (reason: "not_allowed" | "not_found" | "stale_version" | "invalid_state", order: OrderView | null) =>
      result({ type: "rejected", reason, order });
    // The actor comes from the signed-in member; an envelope for anyone else is refused.
    const { actor, action } = envelope;
    if (actor.type !== "member" || actor.memberId !== member.memberId || actor.role !== member.role) {
      return refused("not_allowed", null);
    }
    if (action.type === "review_change") return this.review(member, envelope.operationKey, action);
    if (action.type === "propose_price" || action.type === "confirm_price") return this.price(member, envelope.operationKey, action);
    // Payments, fiado, prices, stock, observations, pause and replies: not in this cut, and never a throw.
    if (!isStaffAction(action)) return refused("not_allowed", null);

    // The order id is untrusted: it resolves only inside this store. Its customer comes from the record.
    const stored = await store.order(member, action.orderId);
    if (stored === null) return refused("not_found", null);
    // A key the engine didn't derive is refused, so a key only ever names an order that resolved above.
    if (envelope.operationKey !== staffKey(action)) return refused("not_allowed", null);
    const first = await store.firstOutcome(member, envelope.operationKey);
    if (first !== null) return result({ type: "duplicate", first });

    const { view } = stored;
    if (action.version !== view.version) return refused("stale_version", view);
    const step = STAFF_STEPS[action.type];
    if (view.state !== fromState(action, view.fulfillment)) return refused("invalid_state", view);
    if (action.type === "mark_line" && indexOfLabel(view.lines.length, action.lineId) === null) return refused("not_found", view);
    // The courier id is untrusted: it resolves only to an active member of this store (K13, Q4).
    const courier =
      action.type !== "dispatch" ? null : typeof action.courierMemberId === "string" ? await store.courier(member, action.courierMemberId) : null;
    if (action.type === "dispatch" && courier === null) return refused("not_found", view);
    // A dispatch rests on the live ready tap, a delivery's arrival on the live dispatch (K13): the
    // read finds it, and G4 refuses the fact in the batch if a cancel or a supersede killed it since.
    const restsOn = restsOnStatus(action, view.fulfillment);
    let prior: string | null = null;
    if (restsOn !== null) {
      const facts = await store.orderFacts(member, view.orderId);
      const found = facts.find(
        (fact) =>
          fact.live &&
          fact.kind === "order_status" &&
          fact.status === restsOn &&
          fact.version === view.version &&
          (stored.confirmFactId === null || fact.dependsOn.includes(stored.confirmFactId)),
      );
      if (found === undefined) return refused("invalid_state", view);
      prior = found.id;
    }

    const packing = step.to === "confirmado" || step.to === "preparando";
    const order: OrderView = { ...view, state: step.to, queuePosition: packing ? view.queuePosition : null };
    const outcome: EngineOutcome = { type: "action_saved", order };
    const notice = (n: CustomerNotice["notice"]): CustomerNotice => ({ customerId: stored.customerId, notice: n });
    const notices: CustomerNotice[] = [];
    if (action.type === "mark_ready") notices.push(notice({ type: "order_ready", order }));
    if (courier !== null) notices.push(notice({ type: "order_dispatched", order, courierName: courier.name }));
    if (action.type === "mark_line" && action.mark === "no_hay") notices.push(notice({ type: "line_unavailable", order, lineId: action.lineId }));
    if (action.type === "mark_line" && action.mark === "ofrecer_otro") {
      notices.push(notice({ type: "substitute_offered", order, lineId: action.lineId }));
    }

    // Guarded by what was read: a race the read couldn't see fails the order commit's guards (D-42).
    const commit = store.commitFor(member, {
      operationKey: envelope.operationKey,
      outcome,
      customerId: stored.customerId,
      base: { orderId: view.orderId, version: view.version, state: view.state },
      order,
      newVersion: false,
      confirming: false,
      auditId: this.deps.ids.newId(),
      auditKind: step.audit,
      actorId: member.memberId,
      auditDetail:
        action.type === "mark_line"
          ? { lineId: action.lineId, mark: action.mark, substituteProductId: action.substituteProductId }
          : courier !== null
            ? { courierMemberId: courier.memberId }
            : undefined,
      facts: { versionFactId: stored.versionFactId, confirmFactId: stored.confirmFactId },
      nowMs: member.nowMs,
    });
    // The tap rests on the live confirm: after a cancel or a supersede, G4 refuses it inside the batch
    // (R3). The member who tapped is its evidence. PENDING: the console session, once MemberContext
    // carries one. P1 is a post guard: saveConsoleAction must run post guards for staff taps.
    const fact: FactCommit = {
      factId: this.deps.ids.newId(),
      kind: "order_status",
      operationKey: envelope.operationKey,
      draft: null,
      actorUserId: member.memberId,
      validFromMs: member.nowMs,
      body: {
        orderId: view.orderId,
        version: view.version,
        ...(action.type === "mark_line"
          ? { line: action.lineId, mark: action.mark, substituteProductId: action.substituteProductId }
          : { status: STAFF_STATUS[action.type] }),
        // The courier is recorded on the fact: whoever tapped, this member took the order out (Q4).
        ...(courier === null ? {} : { courierMemberId: courier.memberId }),
      },
      evidence: [{ kind: "member", refId: member.memberId, contentSha256: null }],
      dependsOn: [...(stored.confirmFactId === null ? [] : [stored.confirmFactId]), ...(prior === null ? [] : [prior])],
      closes: null,
      movements: [],
    };
    return { outcome, notices, commits: [commit, this.deps.ledger.statementsFor(member, fact, member.nowMs)] };
  }

  async verifyClaims(tenant: Tenant, claims: readonly Claim[]): Promise<readonly boolean[]> {
    const answers = await Promise.all(claims.map((claim) => this.verifyClaim(tenant, claim)));
    await this.recordClaims(tenant, claims, answers);
    return answers;
  }

  /**
   * The Deed's record of a refusal or a duplicate (K20), best effort: after the decision, never in its
   * batch, and a failed write is logged by IDs and changes nothing. The cancel that decided a refusal
   * on a cancelled order is read only here, and only for that case.
   */
  private async recordRefusal(
    tenant: Tenant,
    outcome: EngineOutcome,
    meta: {
      readonly operationKey: string | null;
      readonly orderId: string | null;
      readonly atMs: number;
      /** Whether every id and version the key embeds resolved in this store (B1). */
      readonly resolved: () => Promise<boolean>;
    },
  ): Promise<void> {
    const { checks, ids, log } = this.deps;
    if (checks === undefined || (outcome.type !== "rejected" && outcome.type !== "duplicate")) return;
    const reason = outcome.type === "rejected" ? outcome.reason : "duplicate";
    // A refusal names the order it read, and none when the id didn't resolve (not_found: the order shown
    // there is the customer's own open one, not the id they sent). A duplicate's order was resolved first.
    const orderId =
      outcome.type === "duplicate" ? meta.orderId : outcome.reason === "not_found" ? null : (outcome.order?.orderId ?? null);
    try {
      // A key is written only with the order it names when that order resolved here, and only when every id
      // it embeds (a request, a product, a line label, the order) and its version resolve too. Otherwise a
      // typed name would reach the append-only row (B1). A duplicate's key was saved, so its ids did resolve.
      const operationKey =
        meta.operationKey !== null &&
        (meta.orderId === null || orderId !== null) &&
        (outcome.type === "duplicate" || (await meta.resolved()))
          ? meta.operationKey
          : null;
      const decidingFactId =
        outcome.type === "rejected" && outcome.reason === "invalid_state" && outcome.order?.state === "cancelado" && orderId !== null
          ? await this.cancelFactOf(tenant, orderId)
          : null;
      await checks.record(tenant, [
        {
          id: ids.newId(),
          atMs: meta.atMs,
          source: DEED_SOURCE[reason],
          subjectFactId: null,
          orderId,
          claimKind: null,
          result: "fail",
          reasonCode: reason,
          decidingFactId,
          operationKey,
        },
      ]);
    } catch {
      log?.warn("deed_check_not_recorded", { businessId: tenant.businessId, reason, count: 1 });
    }
  }

  /** The order id when it names an order of this store; null otherwise (K20). */
  private async resolvedOrderId(tenant: Tenant, orderId: string | null): Promise<string | null> {
    if (orderId === null) return null;
    return (await this.deps.store.order(tenant, orderId)) === null ? null : orderId;
  }

  /** The live cancel of an order, the fact that closed its confirm; null when the order has none. */
  private async cancelFactOf(tenant: Tenant, orderId: string): Promise<string | null> {
    const facts = await this.deps.store.orderFacts(tenant, orderId);
    return facts.find((fact) => fact.kind === "order_cancel" && fact.live)?.id ?? null;
  }

  /** One row per claim, pass or fail, recorded after the answers are known (K20); best effort like the refusals. */
  private async recordClaims(tenant: Tenant, claims: readonly Claim[], answers: readonly boolean[]): Promise<void> {
    const { checks, ids, clock, log } = this.deps;
    if (checks === undefined || claims.length === 0) return;
    try {
      const atMs = clock?.now() ?? Date.now();
      // A claim's order is written only when it resolves in this store; its text never reaches the row as an id.
      const orderIds = await Promise.all(claims.map((claim) => this.resolvedOrderId(tenant, orderIdOfClaim(claim))));
      await checks.record(
        tenant,
        claims.map((claim, index) => ({
          id: ids.newId(),
          atMs,
          source: "verify_claims",
          subjectFactId: null,
          orderId: orderIds[index] ?? null,
          claimKind: claimKindOf(claim),
          result: answers[index] === true ? "pass" : "fail",
          reasonCode: answers[index] === true ? null : "not_backed",
          decidingFactId: null,
          operationKey: null,
        })),
      );
    } catch {
      log?.warn("deed_check_not_recorded", { businessId: tenant.businessId, reason: "verify_claims", count: claims.length });
    }
  }

  async preparationList(tenant: Tenant): Promise<readonly PreparationCard[]> {
    const { store } = this.deps;
    const orders = await store.preparationOrders(tenant);
    return Promise.all(
      orders.map(async ({ view, firstConfirmedAtMs }) => ({
        order: view,
        // PENDING: the customer's name, once the customers table is on main.
        customerName: null,
        confirmedAtMs: firstConfirmedAtMs ?? 0,
        changedLineIds: await store.changedLineIds(tenant, view.orderId, view.version),
      })),
    );
  }

  /**
   * True only when the records back the claim now. Absent means unknown: anything not stored is false.
   * The ledger answers (R5): the claim's version fact must be live (not superseded, not cancelled),
   * a live cancel backs only `cancelado`, and a state must be the one the facts derive, not just the cache's.
   */
  private async verifyClaim(tenant: Tenant, claim: Claim): Promise<boolean> {
    try {
      if (typeof claim !== "object" || claim === null) return false;
      if (claim.type === "unit_price") return await this.verifyPrice(tenant, claim);
      if (claim.type !== "order_state" && claim.type !== "order_total") return false;
      if (typeof claim.orderId !== "string" || !Number.isInteger(claim.version)) return false;
      const { store } = this.deps;
      const head = await store.orderHead(tenant, claim.orderId);
      if (head === null || head.version !== claim.version) return false;
      const facts = await store.orderFacts(tenant, claim.orderId);
      // A live cancel takes the whole order back, whichever fact it closed (the confirm, or the version
      // when it was never confirmed): on either path, only "it is cancelled" is backed, never a total.
      if (facts.some((fact) => fact.kind === "order_cancel" && fact.live)) {
        return claim.type === "order_state" && claim.state === "cancelado" && deriveOrderState(facts, claim.version, head.state) === "cancelado";
      }
      if (!facts.some((fact) => fact.kind === "order_version" && fact.version === claim.version && fact.live)) return false;
      // availability, payment_confirmed, balance and store hours aren't stored in this cut.
      if (claim.type === "order_state") return deriveOrderState(facts, claim.version, head.state) === claim.state;
      return head.total !== null && head.total === claim.total;
    } catch {
      // A claim the records can't back right now isn't sent.
      return false;
    }
  }

  /** A unit price is backed only by the live confirmed price fact of that product: a proposal backs nothing. */
  private async verifyPrice(tenant: Tenant, claim: Extract<Claim, { type: "unit_price" }>): Promise<boolean> {
    if (typeof claim.productId !== "string" || !isPrice(claim.price)) return false;
    const { confirmed } = await this.deps.store.priceState(tenant, claim.productId, "");
    return confirmed !== null && confirmed.price === claim.price;
  }

  /**
   * K6: a staff proposal or the owner's confirmation of a product's price, one `price` fact resting on
   * the member. Reads first (D-42): who may, the key the engine derives, the product, a used key.
   * A confirmation rests on the newest live proposal when there is one and closes the confirmed price it
   * replaces `superseded`; an owner confirming with no proposal confirms directly. The product's order
   * versions keep the totals they were confirmed with: a price is read when a line is priced, never later.
   */
  private async price(
    member: MemberContext,
    operationKey: string,
    action: Extract<ConsoleAction, { type: "propose_price" | "confirm_price" }>,
  ): Promise<EngineResult> {
    const { store, ids, ledger } = this.deps;
    const refused = (reason: "not_allowed" | "not_found") => result({ type: "rejected", reason, order: null });
    const confirming = action.type === "confirm_price";
    if (member.role !== "owner" && (OWNER_ACTIONS as readonly string[]).includes(action.type)) return refused("not_allowed");
    if (typeof action.productId !== "string" || action.productId.length === 0 || action.productId.length > 64) return refused("not_found");
    if (!isPrice(action.price)) return refused("not_allowed");
    if (operationKey !== priceKey(action.productId, member.nowMs, action.type)) return refused("not_allowed");
    if ((await store.productNames(member, [action.productId])).size === 0) return refused("not_found");
    const state = await store.priceState(member, action.productId, operationKey);
    // The first save's outcome is the same for everyone: the price was saved.
    if (state.keyUsed) return result({ type: "duplicate", first: { type: "action_saved", order: null } });

    const fact: FactCommit = {
      factId: ids.newId(),
      kind: "price",
      operationKey,
      draft: null,
      actorUserId: member.memberId,
      validFromMs: member.nowMs,
      body: { productId: action.productId, price: action.price, status: confirming ? "confirmed" : "proposed" },
      evidence: [{ kind: "member", refId: member.memberId, contentSha256: null }],
      dependsOn: confirming && state.proposal !== null ? [state.proposal.factId] : [],
      closes: confirming && state.confirmed !== null ? { factId: state.confirmed.factId, reason: "superseded" } : null,
      movements: [],
    };
    return result({ type: "action_saved", order: null }, [ledger.statementsFor(member, fact, member.nowMs)]);
  }

  /** New content: the next version in por_confirmar, read back. After confirming, D-38. */
  private change(
    context: CustomerContext,
    operationKey: string,
    open: StoredOrder | null,
    lines: readonly OrderLineView[],
    fulfillment: OrderView["fulfillment"],
  ): EngineResult {
    if (open !== null && !EDITABLE.includes(open.view.state)) {
      return result({ type: "rejected", reason: "invalid_state", order: open.view });
    }
    const labelled = lines.map((line, index) => ({ ...line, lineId: labelOf(index) }));
    // After confirming, a change waits for the owner or staff (K12); before, the customer reconfirms (D-43).
    if (open !== null && CHANGE_WINDOW.includes(open.view.state)) return this.request(context, operationKey, open, labelled, fulfillment);
    const fee = fulfillment === null ? null : fulfillment.mode === "pickup" ? 0 : fulfillment.fee;
    const order: OrderView = {
      orderId: open?.view.orderId ?? this.deps.ids.newId(),
      version: open === null ? 1 : open.view.version + 1,
      state: "por_confirmar",
      lines: labelled,
      fulfillment,
      total: totalOf(labelled, fee).total,
      queuePosition: null,
      openChangeRequest: null,
      lastReview: open?.view.lastReview ?? null,
    };
    const wasConfirmed = open !== null && open.firstConfirmedAtMs !== null;
    const outcome: EngineOutcome = wasConfirmed ? { type: "order_changed", order } : { type: "readback", order };
    // v(n+1) rests on v(n) and supersedes it: v(n)'s confirm and status taps die with it.
    const previous = open?.versionFactId ?? null;
    const fact = this.customerFact(context, operationKey, order, {
      kind: "order_version",
      body: { total: order.total },
      dependsOn: previous === null ? [] : [previous],
      closes: previous === null ? null : { factId: previous, reason: "superseded" },
    });
    return this.save(context, fact, {
      operationKey,
      outcome,
      base: open,
      order,
      newVersion: true,
      confirming: false,
      auditKind: open === null ? "order_created" : "order_changed",
      facts: { versionFactId: fact.factId, confirmFactId: null },
    });
  }

  private async confirm(context: CustomerContext, operationKey: string, stored: StoredOrder): Promise<EngineResult> {
    const { view } = stored;
    if (view.state !== "por_confirmar") return result({ type: "rejected", reason: "invalid_state", order: view });
    // Confirmed again after a change, the order goes back where it was and keeps its place (D-38).
    const state = stored.firstConfirmedAtMs === null ? "confirmado" : (stored.resumeState ?? "confirmado");
    const confirmedAtMs = stored.firstConfirmedAtMs ?? context.nowMs;
    const queuePosition = await this.deps.store.queuePosition(context, view.orderId, confirmedAtMs);
    const order: OrderView = { ...view, state, queuePosition };
    // resumeState keeps the derived state equal to the cache: a status tap on an older version rested
    // on that version's confirm, which died when the version was superseded (D-38, D-43).
    const fact = this.customerFact(context, operationKey, order, {
      kind: "order_confirm",
      body: { resumeState: state },
      dependsOn: stored.versionFactId === null ? [] : [stored.versionFactId],
      closes: null,
    });
    return this.save(context, fact, {
      operationKey,
      outcome: { type: "order_confirmed", order },
      base: stored,
      order,
      newVersion: false,
      confirming: true,
      auditKind: "order_confirmed",
      facts: { versionFactId: stored.versionFactId, confirmFactId: fact.factId },
    });
  }

  private cancel(context: CustomerContext, operationKey: string, stored: StoredOrder): EngineResult {
    const { view } = stored;
    if (!CANCELLABLE.includes(view.state)) return result({ type: "rejected", reason: "invalid_state", order: view });
    // A change waiting for review rests on the confirm the cancel closes: it dies with it.
    const order: OrderView = { ...view, state: "cancelado", queuePosition: null, openChangeRequest: null };
    // A confirmed order's confirm is what a cancel takes back; otherwise the version itself.
    const closed = view.state === "confirmado" && stored.confirmFactId !== null ? stored.confirmFactId : stored.versionFactId;
    const fact = this.customerFact(context, operationKey, order, {
      kind: "order_cancel",
      body: {},
      dependsOn: [],
      closes: closed === null ? null : { factId: closed, reason: "cancelled" },
    });
    return this.save(context, fact, {
      operationKey,
      outcome: { type: "order_cancelled", order },
      base: stored,
      order,
      newVersion: false,
      confirming: false,
      auditKind: "order_cancelled",
      facts: { versionFactId: stored.versionFactId, confirmFactId: stored.confirmFactId },
    });
  }

  /**
   * A change after confirming (K12): a change_request fact on the live confirm; the order stays as it
   * is. A newer request replaces the one still waiting (it closes it `superseded` and rests on it).
   * The customer hears their order with the request open; the reply says it waits for the store.
   */
  private request(
    context: CustomerContext,
    operationKey: string,
    open: StoredOrder,
    lines: readonly OrderLineView[],
    fulfillment: OrderView["fulfillment"],
  ): EngineResult {
    const { view } = open;
    const diff = lineDiff(view.lines, lines);
    const previous = open.openRequest;
    const fact = this.customerFact(context, changeRequestKey(view.orderId, context.jobId), view, {
      kind: "change_request",
      body: { lines, fulfillment, diff },
      dependsOn: [...(open.confirmFactId === null ? [] : [open.confirmFactId]), ...(previous === null ? [] : [previous.id])],
      closes: previous === null ? null : { factId: previous.id, reason: "superseded" },
    });
    const order: OrderView = { ...view, openChangeRequest: { id: fact.factId, diff } };
    return this.save(context, fact, {
      operationKey,
      outcome: { type: "order_status", order },
      base: open,
      order,
      newVersion: false,
      confirming: false,
      auditKind: "change_requested",
      facts: { versionFactId: open.versionFactId, confirmFactId: open.confirmFactId },
    });
  }

  /**
   * The owner's or staff's answer to a change request, with a reason (K12). Reads first (D-42): the
   * request resolves only inside this store, a second answer is the first one's duplicate, and a
   * request no longer live (the order was cancelled, a newer request replaced it) is refused with the
   * order. The review rests on the request, so a cancel landing after the read fails G4 in the batch.
   *
   * Approve: the review, the new version (resting on the review, superseding the old one) and its
   * confirm (resting on the new version; the customer's request is the confirmation, D-38's
   * resumeState keeps the order where it was). Decline: the review only; the order stays as it is.
   */
  private async review(
    member: MemberContext,
    operationKey: string,
    action: Extract<ConsoleAction, { type: "review_change" }>,
  ): Promise<EngineResult> {
    const { store, ids, ledger } = this.deps;
    const refused = (reason: "not_allowed" | "not_found" | "stale_version" | "invalid_state", order: OrderView | null) =>
      result({ type: "rejected", reason, order });
    const request = typeof action.changeRequestId === "string" ? await store.changeRequest(member, action.changeRequestId) : null;
    if (request === null) return refused("not_found", null);
    if (operationKey !== reviewKey(request.id)) return refused("not_allowed", null);
    const first = await store.firstOutcome(member, operationKey);
    if (first !== null) return result({ type: "duplicate", first });
    const stored = await store.order(member, request.orderId);
    if (stored === null) return refused("not_found", null);
    const { view } = stored;
    const reason = reviewReason(action.reason);
    if (reason === null || (action.decision !== "approve" && action.decision !== "decline")) return refused("not_allowed", view);
    if (!request.live) return refused("invalid_state", view);
    if (request.version !== view.version) return refused("stale_version", view);
    const approve = action.decision === "approve";
    if (approve && !CHANGE_WINDOW.includes(view.state)) return refused("invalid_state", view);

    const lastReview = { decision: action.decision, reason, atMs: member.nowMs };
    const memberEvidence: EvidenceRef = { kind: "member", refId: member.memberId, contentSha256: null };
    const reviewFact: FactCommit = {
      factId: ids.newId(),
      kind: "change_review",
      operationKey,
      draft: null,
      actorUserId: member.memberId,
      validFromMs: member.nowMs,
      body: { orderId: view.orderId, version: view.version, changeRequestId: request.id, decision: action.decision, reason },
      evidence: [memberEvidence],
      dependsOn: [request.id],
      // Answered: the review takes the request's place, so the review itself stays live.
      closes: { factId: request.id, reason: "superseded" },
      movements: [],
    };
    const facts: FactCommit[] = [reviewFact];
    let order: OrderView = { ...view, openChangeRequest: null, lastReview };
    let cacheFacts: OrderWrite["facts"] = { versionFactId: stored.versionFactId, confirmFactId: stored.confirmFactId };

    if (approve) {
      const fee = request.fulfillment === null ? null : request.fulfillment.mode === "pickup" ? 0 : request.fulfillment.fee;
      order = { ...order, version: view.version + 1, lines: request.lines, fulfillment: request.fulfillment, total: totalOf(request.lines, fee).total };
      // The customer's message asking for the change is what the new version and its confirm rest on.
      const asked: EvidenceRef[] = request.jobId === null ? [] : [{ kind: "inbound_message", refId: request.jobId, contentSha256: null }];
      const previous = stored.versionFactId;
      const versionFact: FactCommit = {
        factId: ids.newId(),
        kind: "order_version",
        operationKey: `${operationKey}:version`,
        draft: null,
        actorUserId: member.memberId,
        validFromMs: member.nowMs,
        body: { orderId: view.orderId, version: order.version, total: order.total, changeRequestId: request.id },
        evidence: [...asked, memberEvidence],
        dependsOn: [...(previous === null ? [] : [previous]), reviewFact.factId],
        sameBatch: [reviewFact.factId],
        closes: previous === null ? null : { factId: previous, reason: "superseded" },
        movements: [],
      };
      const confirmFact: FactCommit = {
        factId: ids.newId(),
        kind: "order_confirm",
        operationKey: `${operationKey}:confirm`,
        draft: null,
        actorUserId: stored.customerId,
        validFromMs: member.nowMs,
        body: { orderId: view.orderId, version: order.version, resumeState: view.state, changeRequestId: request.id },
        evidence: asked,
        dependsOn: [versionFact.factId],
        sameBatch: [versionFact.factId],
        closes: null,
        movements: [],
      };
      facts.push(versionFact, confirmFact);
      cacheFacts = { versionFactId: versionFact.factId, confirmFactId: confirmFact.factId };
    }

    const outcome: EngineOutcome = { type: "action_saved", order };
    const notice: CustomerNotice["notice"] = approve ? { type: "change_approved", order } : { type: "change_declined", order, reason };
    const commit = store.commitFor(member, {
      operationKey,
      outcome,
      customerId: stored.customerId,
      base: { orderId: view.orderId, version: view.version, state: view.state },
      order,
      newVersion: approve,
      confirming: false,
      auditId: ids.newId(),
      auditKind: approve ? "change_approved" : "change_declined",
      actorId: member.memberId,
      auditDetail: { changeRequestId: request.id, decision: action.decision },
      facts: cacheFacts,
      nowMs: member.nowMs,
    });
    return {
      outcome,
      notices: [{ customerId: stored.customerId, notice }],
      commits: [commit, ...facts.map((fact) => ledger.statementsFor(member, fact, member.nowMs))],
    };
  }

  /**
   * A customer's order fact: the customer acted, and the message (or tap) they acted with is its
   * evidence. Its body names the order and version, so the order's fact trail can find it.
   */
  private customerFact(
    context: CustomerContext,
    operationKey: string,
    order: OrderView,
    fact: Pick<FactCommit, "dependsOn" | "closes"> & {
      readonly kind: "order_version" | "order_confirm" | "order_cancel" | "change_request";
      readonly body: Readonly<Record<string, unknown>>;
    },
  ): FactCommit {
    const evidence: EvidenceRef[] = [{ kind: "inbound_message", refId: context.jobId, contentSha256: null }];
    return {
      factId: this.deps.ids.newId(),
      kind: fact.kind,
      operationKey,
      draft: null,
      actorUserId: context.customerId,
      validFromMs: context.nowMs,
      body: { orderId: order.orderId, version: order.version, ...fact.body },
      evidence,
      dependsOn: fact.dependsOn,
      closes: fact.closes,
      movements: [],
    };
  }

  /** The order commit first, so its guards report first, then the fact under the same key. */
  private save(
    context: CustomerContext,
    fact: FactCommit,
    write: Pick<OrderWrite, "operationKey" | "outcome" | "order" | "newVersion" | "confirming" | "auditKind" | "facts"> & {
      readonly base: StoredOrder | null;
    },
  ): EngineResult {
    const { base } = write;
    const commit = this.deps.store.commitFor(context, {
      ...write,
      customerId: context.customerId,
      base: base === null ? null : { orderId: base.view.orderId, version: base.view.version, state: base.view.state },
      auditId: this.deps.ids.newId(),
      nowMs: context.nowMs,
    });
    return result(write.outcome, [commit, this.deps.ledger.statementsFor(context, fact, context.nowMs)]);
  }
}

/**
 * The lines after an order_change, or null when an edit points at a label that doesn't resolve.
 * Every label refers to the version the customer saw, so quantities are set first, removals go
 * from the last line back, and additions come at the end.
 */
function applyChange(
  lines: readonly OrderLineView[],
  change: OrderChange,
  lineFrom: (item: ItemLine, edit: number) => OrderLineView,
): readonly OrderLineView[] | null {
  let current: Pick<OrderView, "version" | "lines"> = { version: 0, lines };
  const removals: { readonly index: number; readonly label: string }[] = [];
  const additions: OrderLineView[] = [];

  for (const [edit, change_] of change.edits.entries()) {
    if (change_.op === "add") {
      additions.push(lineFrom(change_.line, edit));
      continue;
    }
    const label = change_.target.ref;
    const index = label === null ? null : indexOfLabel(lines.length, label);
    if (label === null || index === null) return null;
    const quantity = change_.op === "set_quantity" ? canonicalQuantity(change_.quantity) : null;
    if (change_.op === "remove" || quantity === null) {
      // "que sean cero" is a removal; an unreadable quantity is a question.
      if (change_.op === "set_quantity" && toThousandths(change_.quantity) !== 0) return null;
      if (!removals.some((r) => r.index === index)) removals.push({ index, label });
      continue;
    }
    const next = nextVersion(current, { op: "set_quantity", label, quantity });
    if (next === null) return null;
    current = next;
  }

  for (const { label } of [...removals].sort((a, b) => b.index - a.index)) {
    const next = nextVersion(current, { op: "remove", label });
    if (next === null) return null;
    current = next;
  }
  return [...current.lines, ...additions];
}
