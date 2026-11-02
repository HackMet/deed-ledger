/**
 * The order slice of the engine (#11): a customer's burst becomes a versioned order read back to
 * them, and their taps confirm, cancel or change it. Nothing is saved here: every decision returns
 * `commits` that run in the job's completion batch.
 *
 * Every decision reads first (D-42): a used operation key answers `duplicate` with the stored first
 * outcome, a key that doesn't resolve inside the customer's own orders answers `not_found`, a tap on
 * an older version answers `stale_version`. The commit's guards only settle a race.
 */
import type { ActionEnvelope, ConsoleAction, CustomerAction, OrderRef } from "../../domain/contract/actions";
import { toThousandths } from "../../domain/contract/numbers";
import { type BurstReading, type ItemLine, isCustomerKind, type OrderChange } from "../../domain/contract/observation";
import type {
  Claim,
  CustomerNotice,
  EngineOutcome,
  OrderLineView,
  OrderState,
  OrderView,
  PreparationCard,
} from "../../domain/contract/outcomes";
import { totalOf } from "../../domain/order-total";
import { indexOfLabel, labelOf, nextVersion } from "../../domain/orders";
import type { CustomerContext, Engine, EngineResult, LineMatch, MemberContext } from "../engine";
import type { Commit, IdSource, Tenant } from "../ports";

export interface StoredOrder {
  /** The current version, as the customer would read it back. */
  readonly view: OrderView;
  readonly customerId: string;
  readonly firstConfirmedAtMs: number | null;
  /** For an order changed after confirming: the state confirming again returns to (D-38). */
  readonly resumeState: "confirmado" | "preparando" | null;
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
    | "order_delivered";
  /** Who acted, for the audit row: a member on the console. Defaults to the customer. */
  readonly actorId?: string;
  /** More for the audit row's detail, next to the state change. */
  readonly auditDetail?: Readonly<Record<string, unknown>>;
  readonly nowMs: number;
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

/** The console actions on an order this cut saves: staff move it along the preparation list. */
type StaffAction = Extract<ConsoleAction, { type: "start_preparing" | "mark_line" | "mark_ready" | "mark_delivered" }>;

/** Each staff action's only pre-state and the state it leaves. mark_line records a mark and keeps preparando. */
const STAFF_STEPS: Readonly<Record<StaffAction["type"], { from: OrderState; to: OrderState; audit: OrderWrite["auditKind"] }>> = {
  start_preparing: { from: "confirmado", to: "preparando", audit: "order_preparing" },
  mark_line: { from: "preparando", to: "preparando", audit: "order_line_marked" },
  mark_ready: { from: "preparando", to: "listo", audit: "order_ready" },
  mark_delivered: { from: "listo", to: "entregado", audit: "order_delivered" },
};

const isStaffAction = (action: ConsoleAction): action is StaffAction => Object.hasOwn(STAFF_STEPS, action.type);

/**
 * The operation key a staff action must carry (D-44): one action on one version of one order, and
 * for a line mark one line, so a double tap saves once.
 */
export function staffKey(action: StaffAction & OrderRef): string {
  const base = `staff:${action.orderId}:${action.version}:${action.type}`;
  return action.type === "mark_line" ? `${base}:${action.lineId}` : base;
}

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

export class OrderEngine implements Engine {
  constructor(private readonly deps: { readonly store: OrderStore; readonly ids: IdSource }) {}

  async onBurst(context: CustomerContext, reading: BurstReading, matches: readonly LineMatch[]): Promise<EngineResult> {
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

    let lines: readonly OrderLineView[] = open?.view.lines ?? [];
    let fulfillment: OrderView["fulfillment"] = open?.view.fulfillment ?? null;
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
        const index = indexOfLabel(view.lines.length, action.lineId);
        if (index === null) return result({ type: "rejected", reason: "not_found", order: view });
        const next = nextVersion(view, { op: "remove", label: action.lineId });
        if (next === null) return result({ type: "rejected", reason: "not_found", order: view });
        return this.change(context, envelope.operationKey, stored, next.lines, view.fulfillment);
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
    const { store } = this.deps;
    const refused = (reason: "not_allowed" | "not_found" | "stale_version" | "invalid_state", order: OrderView | null) =>
      result({ type: "rejected", reason, order });
    // The actor comes from the signed-in member; an envelope for anyone else is refused.
    const { actor, action } = envelope;
    if (actor.type !== "member" || actor.memberId !== member.memberId || actor.role !== member.role) {
      return refused("not_allowed", null);
    }
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
    if (view.state !== step.from) return refused("invalid_state", view);
    if (action.type === "mark_line" && indexOfLabel(view.lines.length, action.lineId) === null) return refused("not_found", view);

    const packing = step.to === "confirmado" || step.to === "preparando";
    const order: OrderView = { ...view, state: step.to, queuePosition: packing ? view.queuePosition : null };
    const outcome: EngineOutcome = { type: "action_saved", order };
    const notice = (n: CustomerNotice["notice"]): CustomerNotice => ({ customerId: stored.customerId, notice: n });
    const notices: CustomerNotice[] = [];
    if (action.type === "mark_ready") notices.push(notice({ type: "order_ready", order }));
    if (action.type === "mark_line" && action.mark === "no_hay") notices.push(notice({ type: "line_unavailable", order, lineId: action.lineId }));
    if (action.type === "mark_line" && action.mark === "ofrecer_otro") {
      notices.push(notice({ type: "substitute_offered", order, lineId: action.lineId }));
    }

    // Guarded by what was read: a race the read couldn't see fails the batch (no post guards: D-42).
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
          : undefined,
      nowMs: member.nowMs,
    });
    return { outcome, notices, commits: [commit] };
  }

  async verifyClaims(tenant: Tenant, claims: readonly Claim[]): Promise<readonly boolean[]> {
    return Promise.all(claims.map((claim) => this.verifyClaim(tenant, claim)));
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

  /** True only when the records back the claim now. Absent means unknown: anything not stored is false. */
  private async verifyClaim(tenant: Tenant, claim: Claim): Promise<boolean> {
    try {
      if (typeof claim !== "object" || claim === null) return false;
      if (claim.type !== "order_state" && claim.type !== "order_total") return false;
      if (typeof claim.orderId !== "string" || !Number.isInteger(claim.version)) return false;
      const head = await this.deps.store.orderHead(tenant, claim.orderId);
      if (head === null || head.version !== claim.version) return false;
      // unit_price, availability, payment_confirmed, balance and store hours aren't stored in this cut.
      return claim.type === "order_state" ? head.state === claim.state : head.total !== null && head.total === claim.total;
    } catch {
      // A claim the records can't back right now isn't sent.
      return false;
    }
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
    const fee = fulfillment === null ? null : fulfillment.mode === "pickup" ? 0 : fulfillment.fee;
    const order: OrderView = {
      orderId: open?.view.orderId ?? this.deps.ids.newId(),
      version: open === null ? 1 : open.view.version + 1,
      state: "por_confirmar",
      lines: labelled,
      fulfillment,
      total: totalOf(labelled, fee).total,
      queuePosition: null,
    };
    const wasConfirmed = open !== null && open.firstConfirmedAtMs !== null;
    const outcome: EngineOutcome = wasConfirmed ? { type: "order_changed", order } : { type: "readback", order };
    return this.save(context, {
      operationKey,
      outcome,
      base: open,
      order,
      newVersion: true,
      confirming: false,
      auditKind: open === null ? "order_created" : "order_changed",
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
    return this.save(context, {
      operationKey,
      outcome: { type: "order_confirmed", order },
      base: stored,
      order,
      newVersion: false,
      confirming: true,
      auditKind: "order_confirmed",
    });
  }

  private cancel(context: CustomerContext, operationKey: string, stored: StoredOrder): EngineResult {
    const { view } = stored;
    if (!CANCELLABLE.includes(view.state)) return result({ type: "rejected", reason: "invalid_state", order: view });
    const order: OrderView = { ...view, state: "cancelado", queuePosition: null };
    return this.save(context, {
      operationKey,
      outcome: { type: "order_cancelled", order },
      base: stored,
      order,
      newVersion: false,
      confirming: false,
      auditKind: "order_cancelled",
    });
  }

  private save(
    context: CustomerContext,
    write: Pick<OrderWrite, "operationKey" | "outcome" | "order" | "newVersion" | "confirming" | "auditKind"> & {
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
    return result(write.outcome, [commit]);
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
