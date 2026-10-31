/**
 * A pretend engine kept in memory, so the console and the replies can be built and tried before
 * the real engine lands. It follows the contract's rules for the preparation list (versions,
 * operation keys, roles) but saves straight into memory instead of returning commits, and forgets
 * everything when the Worker restarts. Only wired in when the console runs in dev mode.
 *
 * Marking lines doesn't change an order's version: the version is the content the customer agreed
 * to, and only the customer's changes make a new one.
 *
 * Bursts are pretended just enough for a first order (PRD "A first order"): lines from the reading,
 * matched products priced from an optional catalog, one question at a time (an unclear line, the
 * name once, pickup or delivery), then the readback. It also answers "¿a qué hora está?", a cancel
 * and the reads perception needs (contract gaps a and b). Payments, prices, places and substitutes
 * aren't pretended: they get the handoff.
 */
import type { CustomerContext, Engine, EngineResult, LineMatch, MemberContext } from "../../application/engine";
import type { OrderReadingSource } from "../../application/order-reading";
import { type CatalogProduct, normalize } from "../../application/perception/matching";
import type { Tenant } from "../../application/ports";
import { type ActionEnvelope, type ConsoleAction, type CustomerAction, OWNER_ACTIONS } from "../../domain/contract/actions";
import type { Centavos } from "../../domain/contract/numbers";
import type { BurstReading, ItemLine, Observation, PerceptionContext } from "../../domain/contract/observation";
import type {
  Claim,
  CustomerNotice,
  EngineOutcome,
  OrderLineView,
  OrderView,
  PreparationCard,
  QuestionCode,
} from "../../domain/contract/outcomes";
import { orderSubtotal } from "../../domain/money";

export interface StoredOrder {
  readonly customerId: string;
  readonly customerName: string | null;
  readonly confirmedAtMs: number;
  readonly changedLineIds: readonly string[];
  readonly order: OrderView;
}

/** A catalog product with the store's confirmed price, for the pretend readback. */
export interface PretendProduct extends CatalogProduct {
  readonly price: Centavos | null;
}

export interface MemoryEngineOptions {
  readonly catalog?: readonly PretendProduct[];
}

/** What the pretend engine keeps about an order while it's being put together. */
interface Draft {
  /** Questions still to ask, oldest first; `lineId` when one is about a line. */
  readonly pending: { readonly code: QuestionCode; readonly lineId: string | null }[];
  /** Each line's product words as perception read them ("aceite clover"), to settle a size answer. */
  readonly names: Map<string, string>;
  /** The current version was read back: any change makes a new version, so old taps are refused. */
  shown: boolean;
}

interface StoreState {
  readonly orders: Map<string, StoredOrder>;
  /** Operation key -> the first outcome saved under it. */
  readonly operations: Map<string, EngineOutcome>;
  readonly drafts: Map<string, Draft>;
  /** Customer -> the question asked last, for perception's context. */
  readonly lastQuestion: Map<string, QuestionCode>;
}

const ON_THE_LIST: readonly OrderView["state"][] = ["confirmado", "preparando", "listo"];
const PACKING: readonly OrderView["state"][] = ["confirmado", "preparando"];

const OPEN: readonly OrderView["state"][] = ["armando", "por_confirmar", "confirmado", "preparando", "listo"];

export class MemoryEngine implements Engine, OrderReadingSource {
  private readonly stores = new Map<string, StoreState>();

  /** `seed` fills a store with orders the first time it's used. */
  constructor(
    private readonly seed: (tenant: Tenant) => readonly StoredOrder[] = () => [],
    private readonly options: MemoryEngineOptions = {},
  ) {}

  /**
   * One outcome for the burst: the next thing to say. A retried job (same job ID) gets its first
   * outcome again without applying the burst twice, standing in for the real engine's operation key.
   */
  async onBurst(context: CustomerContext, reading: BurstReading, matches: readonly LineMatch[]): Promise<EngineResult> {
    const state = this.state(context);
    const key = customerOperationKey(context.customerId, `burst:${context.jobId}`);
    const first = state.operations.get(key);
    if (first !== undefined) return result(first);

    const burst = new BurstApplier(state, context, this.options.catalog ?? [], matches);
    reading.observations.forEach((observation, index) => burst.apply(observation, index));
    const outcome = burst.decide();
    state.operations.set(key, outcome);
    if (outcome.type === "ask") state.lastQuestion.set(context.customerId, outcome.question);
    else state.lastQuestion.delete(context.customerId);
    return result(outcome);
  }

  async perceptionContext(context: CustomerContext): Promise<PerceptionContext> {
    const state = this.state(context);
    const open = openOrderOf(state, context.customerId);
    return {
      openOrder:
        open === null
          ? null
          : { lines: open.order.lines.map((line, n) => ({ ref: `L${n + 1}`, text: `${line.productName ?? line.text}: ${line.quantity ?? "?"}` })) },
      pendingQuestion: state.lastQuestion.get(context.customerId) ?? null,
    };
  }

  async catalog(): Promise<readonly CatalogProduct[]> {
    return this.options.catalog ?? [];
  }

  /**
   * The readback's answers. An order is found only among the customer's own: another customer's
   * order answers not_found, as if it didn't exist. Saved places and substitutes aren't pretended.
   */
  async onCustomerAction(context: CustomerContext, envelope: ActionEnvelope<CustomerAction>): Promise<EngineResult> {
    const state = this.state(context);
    const { action } = envelope;
    // Authorize before answering a repeated key: button keys are predictable, so another customer
    // replaying one must never get the first customer's outcome back.
    if (envelope.actor.type !== "customer" || envelope.actor.customerId !== context.customerId) {
      return result({ type: "rejected", reason: "not_allowed", order: null });
    }
    const stored = state.orders.get(action.orderId);
    if (stored === undefined || stored.customerId !== context.customerId) {
      return result({ type: "rejected", reason: "not_found", order: null });
    }
    state.lastQuestion.delete(context.customerId);
    const operationKey = customerOperationKey(context.customerId, envelope.operationKey);
    const first = state.operations.get(operationKey);
    if (first !== undefined) return result({ type: "duplicate", first });

    if (action.version !== stored.order.version) {
      return result({ type: "rejected", reason: "stale_version", order: stored.order });
    }
    const answered = answer(stored, action, context.nowMs);
    if (answered === null) return result({ type: "rejected", reason: "invalid_state", order: stored.order });
    state.orders.set(action.orderId, answered.stored);
    state.operations.set(operationKey, answered.outcome);
    return result(answered.outcome);
  }

  async onConsoleAction(context: MemberContext, envelope: ActionEnvelope<ConsoleAction>): Promise<EngineResult> {
    const state = this.state(context);
    const first = state.operations.get(envelope.operationKey);
    if (first !== undefined) return result({ type: "duplicate", first });

    const { action } = envelope;
    if (!allowed(context, action)) return result({ type: "rejected", reason: "not_allowed", order: null });
    if (!("orderId" in action) || !("version" in action)) {
      return result({ type: "rejected", reason: "invalid_state", order: null });
    }
    const stored = state.orders.get(action.orderId);
    if (stored === undefined) return result({ type: "rejected", reason: "not_found", order: null });
    if (action.version !== stored.order.version) {
      return result({ type: "rejected", reason: "stale_version", order: stored.order });
    }

    const applied = apply(stored, action);
    if (applied === null) return result({ type: "rejected", reason: "invalid_state", order: stored.order });
    state.orders.set(action.orderId, applied.stored);
    const outcome: EngineOutcome = { type: "action_saved", order: applied.stored.order };
    state.operations.set(envelope.operationKey, outcome);
    return { outcome, notices: applied.notices, commits: [] };
  }

  async verifyClaims(tenant: Tenant, claims: readonly Claim[]): Promise<readonly boolean[]> {
    const { orders } = this.state(tenant);
    return claims.map((claim) => {
      if (claim.type !== "order_state" && claim.type !== "order_total") return false;
      const order = orders.get(claim.orderId)?.order;
      if (order === undefined || order.version !== claim.version) return false;
      return claim.type === "order_state" ? order.state === claim.state : order.total === claim.total;
    });
  }

  async preparationList(tenant: Tenant): Promise<readonly PreparationCard[]> {
    return [...this.state(tenant).orders.values()]
      .filter((stored) => ON_THE_LIST.includes(stored.order.state))
      .sort((a, b) => a.confirmedAtMs - b.confirmedAtMs)
      .map(({ order, customerName, confirmedAtMs, changedLineIds }) => ({ order, customerName, confirmedAtMs, changedLineIds }));
  }

  private state(tenant: Tenant): StoreState {
    let state = this.stores.get(tenant.businessId);
    if (state === undefined) {
      state = {
        orders: new Map(this.seed(tenant).map((stored) => [stored.order.orderId, stored])),
        operations: new Map(),
        drafts: new Map(),
        lastQuestion: new Map(),
      };
      this.stores.set(tenant.businessId, state);
    }
    return state;
  }
}

function openOrderOf(state: StoreState, customerId: string): StoredOrder | null {
  for (const stored of state.orders.values()) {
    if (stored.customerId === customerId && OPEN.includes(stored.order.state)) return stored;
  }
  return null;
}

/** Place in the preparation list, 1 is next, among orders being packed. */
function queuePosition(state: StoreState, orderId: string): number | null {
  const packing = [...state.orders.values()]
    .filter((stored) => PACKING.includes(stored.order.state))
    .sort((a, b) => a.confirmedAtMs - b.confirmedAtMs);
  const at = packing.findIndex((stored) => stored.order.orderId === orderId);
  return at === -1 ? null : at + 1;
}

/** Applies one burst's observations in order, then decides the one thing to say. */
class BurstApplier {
  private stored: StoredOrder | null;
  private readonly before: OrderView | null;
  private draft: Draft;
  private changed = false;
  private cancelled = false;
  private statusAsked = false;
  private named: string | null;
  private nameGiven = false;
  private handoff: EngineOutcome | null = null;
  private embedded = false;

  constructor(
    private readonly state: StoreState,
    private readonly context: CustomerContext,
    private readonly catalog: readonly PretendProduct[],
    private readonly matches: readonly LineMatch[],
  ) {
    this.stored = openOrderOf(state, context.customerId);
    this.before = this.stored?.order ?? null;
    this.draft = (this.stored && state.drafts.get(this.stored.order.orderId)) ?? { pending: [], names: new Map(), shown: false };
    this.named = (context as { customerName?: string | null }).customerName ?? this.stored?.customerName ?? null;
  }

  apply(observation: Observation, index: number): void {
    if (observation.issues.some((issue) => issue.code === "embedded_instructions")) this.embedded = true;
    switch (observation.kind) {
      case "customer_order":
        observation.lines.forEach((line, n) => this.addLine(line, this.matchOf(index, n)));
        this.queueIssues(observation, observation.lines.length);
        return;
      case "order_change":
        observation.edits.forEach((edit, n) => {
          if (edit.op === "add") return this.addLine(edit.line, this.matchOf(index, n));
          const at = edit.target.ref === null ? -1 : Number(edit.target.ref.slice(1)) - 1;
          const line = this.stored?.order.lines[at];
          if (line === undefined) return this.draft.pending.push({ code: "ambiguous_product", lineId: null });
          this.setLines(
            edit.op === "remove"
              ? this.stored!.order.lines.filter((l) => l !== line)
              : this.stored!.order.lines.map((l) => (l === line ? { ...l, quantity: edit.quantity } : l)),
          );
        });
        return;
      case "order_cancel":
        this.cancelled = this.stored !== null;
        return;
      case "fulfillment":
        if (this.stored === null || observation.mode === null) return;
        this.setOrder({
          ...this.stored.order,
          fulfillment:
            observation.mode === "pickup"
              ? { mode: "pickup" }
              : { mode: "delivery", placeId: null, placeText: observation.placeText, fee: null },
        });
        return;
      case "clarification":
        this.settleQuestion(observation.answer);
        return;
      case "customer_name":
        this.named = observation.name;
        this.nameGiven = true;
        return;
      case "question":
        if (observation.topic === "order_status") this.statusAsked = true;
        else this.handoff = { type: "handoff" };
        return;
      case "stop":
        this.handoff = { type: "stopped", deleteRequested: observation.deleteRequested };
        return;
      case "handoff":
      case "payment_receipt":
        this.handoff = { type: "handoff" };
        return;
      case "other":
      case "sale_report":
      case "fiado_report":
      case "setup_card":
      case "supplier_invoice":
        // Staff kinds are refused from a customer, whatever perception said.
        return;
    }
  }

  decide(): EngineOutcome {
    const { state, context } = this;
    if (this.cancelled && this.stored !== null) {
      const order: OrderView = { ...this.stored.order, state: "cancelado", queuePosition: null };
      this.save(order);
      return { type: "order_cancelled", order };
    }
    if (this.handoff !== null) return this.handoff;

    const nameAsked = (context as { customerNameAsked?: boolean }).customerNameAsked ?? false;
    const askName = this.named === null && !nameAsked;
    if (this.stored === null || !this.changed) {
      if (this.statusAsked) {
        const order = this.stored === null ? null : { ...this.stored.order, queuePosition: queuePosition(state, this.stored.order.orderId) };
        return { type: "order_status", order };
      }
      if (this.stored === null && askName) return { type: "ask", question: "customer_name", line: null, order: null };
      if (this.embedded) return { type: "ask", question: "embedded_instructions", line: null, order: null };
      if (this.stored === null && !this.nameGiven) return { type: "out_of_scope" };
      return { type: "nothing" };
    }

    // The order changed: one question at a time, then the readback.
    const order = this.stored.order;
    const pending = this.draft.pending[0];
    if (pending !== undefined) {
      const line = pending.lineId === null ? -1 : order.lines.findIndex((l) => l.lineId === pending.lineId);
      return this.ask(pending.code, line === -1 ? null : line, "armando");
    }
    if (askName) return this.ask("customer_name", null, "armando");
    if (order.fulfillment === null) return this.ask("pickup_or_delivery", null, "armando");
    if (order.fulfillment.mode === "delivery" && order.fulfillment.placeText === null && order.fulfillment.placeId === null) {
      return this.ask("delivery_place", null, "armando");
    }
    const onList = this.before !== null && PACKING.includes(this.before.state);
    const next: OrderView = { ...order, state: "por_confirmar", queuePosition: null };
    this.draft.shown = true;
    this.save(next);
    return onList ? { type: "order_changed", order: next } : { type: "readback", order: next };
  }

  private ask(question: QuestionCode, line: number | null, orderState: "armando"): EngineOutcome {
    const order: OrderView = { ...this.stored!.order, state: orderState };
    this.save(order);
    return { type: "ask", question, line, order };
  }

  private matchOf(observation: number, line: number): PretendProduct | null {
    const match = this.matches.find((m) => m.observation === observation && m.line === line);
    return match === undefined ? null : (this.catalog.find((product) => product.productId === match.productId) ?? null);
  }

  private addLine(line: ItemLine, product: PretendProduct | null): void {
    const order = this.stored?.order ?? this.newOrder();
    const lineId = `${order.orderId}-${order.lines.length + 1}`;
    this.draft.names.set(lineId, line.name);
    this.setLines([...order.lines, lineView(lineId, line, product)], order);
  }

  /** Issues about a line are asked one at a time; the line index is into the observation's lines. */
  private queueIssues(observation: Observation, count: number): void {
    const lines = this.stored!.order.lines;
    const first = lines.length - count;
    for (const issue of observation.issues) {
      if (issue.code === "embedded_instructions") continue;
      const line = issue.line === null ? undefined : lines[first + issue.line];
      this.draft.pending.push({ code: issue.code, lineId: line?.lineId ?? null });
    }
  }

  /**
   * An answer to the question asked last. For a line's size or product, "<line words> <answer>"
   * ("aceite clover de litro") is looked up as a product name or alias; otherwise the line stays
   * unmatched and its price unknown. Either way the question is settled: it is never asked twice.
   */
  private settleQuestion(answer: string): void {
    const pending = this.draft.pending.shift();
    if (pending === undefined || this.stored === null) return;
    this.changed = true;
    if (pending.lineId === null) return;
    const said = normalize(`${this.draft.names.get(pending.lineId) ?? ""} ${answer}`);
    const found = this.catalog.filter((p) => [...p.names, ...p.aliases].some((name) => normalize(name) === said));
    const product = found.length === 1 ? found[0]! : null;
    this.setLines(
      this.stored.order.lines.map((line) =>
        line.lineId !== pending.lineId || product === null
          ? line
          : { ...line, productId: product.productId, productName: product.names[0] ?? null, unitPrice: line.restricted ? null : product.price },
      ),
    );
  }

  private newOrder(): OrderView {
    return {
      orderId: `order-${crypto.randomUUID()}`,
      version: 1,
      state: "armando",
      lines: [],
      fulfillment: null,
      total: null,
      queuePosition: null,
    };
  }

  private setLines(lines: readonly OrderLineView[], order: OrderView = this.stored!.order): void {
    this.setOrder({ ...order, lines });
  }

  private setOrder(order: OrderView): void {
    if (this.draft.shown) {
      // The first change after a readback: a new version.
      this.draft.shown = false;
      order = { ...order, version: order.version + 1 };
    }
    const total = orderSubtotal(order);
    this.stored = {
      customerId: this.context.customerId,
      customerName: this.named,
      confirmedAtMs: this.stored?.confirmedAtMs ?? 0,
      changedLineIds: this.stored?.changedLineIds ?? [],
      order: { ...order, total },
    };
    this.changed = true;
  }

  private save(order: OrderView): void {
    const stored: StoredOrder = { ...this.stored!, customerName: this.named, order };
    this.state.orders.set(order.orderId, stored);
    this.state.drafts.set(order.orderId, this.draft);
    this.stored = stored;
  }
}

function lineView(lineId: string, line: ItemLine, product: PretendProduct | null): OrderLineView {
  return {
    lineId,
    text: line.text,
    productId: product?.productId ?? null,
    productName: product?.names[0] ?? null,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: line.restrictedCategory ? null : (product?.price ?? null),
    availability: "no_se",
    restricted: line.restrictedCategory,
    mark: null,
    substitute: null,
  };
}

/** Customer keys are kept per customer, apart from the console's. */
function customerOperationKey(customerId: string, operationKey: string): string {
  return `customer:${customerId}:${operationKey}`;
}

function result(outcome: EngineOutcome): EngineResult {
  return { outcome, notices: [], commits: [] };
}

function allowed(context: MemberContext, action: ConsoleAction): boolean {
  if (action.type === "approve_fiado") return context.role === "owner" || context.canApproveFiado;
  return context.role === "owner" || !(OWNER_ACTIONS as readonly string[]).includes(action.type);
}

/** The order after a customer's answer, and what to tell them; null when it doesn't fit its state. */
function answer(
  stored: StoredOrder,
  action: CustomerAction,
  nowMs: number,
): { stored: StoredOrder; outcome: EngineOutcome } | null {
  const { order } = stored;
  switch (action.type) {
    case "confirm_order": {
      if (order.state !== "por_confirmar") return null;
      const next: OrderView = { ...order, state: "confirmado" };
      return { stored: { ...stored, order: next, confirmedAtMs: nowMs }, outcome: { type: "order_confirmed", order: next } };
    }
    case "cancel_order": {
      if (order.state === "entregado" || order.state === "cancelado") return null;
      const next: OrderView = { ...order, state: "cancelado", queuePosition: null };
      return { stored: { ...stored, order: next }, outcome: { type: "order_cancelled", order: next } };
    }
    case "correct_order":
      // The customer says what to change next; perception reads it.
      return order.state === "por_confirmar" ? { stored, outcome: { type: "nothing" } } : null;
    case "accept_saved_place":
    case "accept_substitute":
    case "remove_line":
      return null;
  }
}

type OrderAction = Extract<ConsoleAction, { orderId: string }>;

/** The order after the action, and who hears about it; null when the action doesn't fit its state. */
function apply(stored: StoredOrder, action: OrderAction): { stored: StoredOrder; notices: CustomerNotice[] } | null {
  const { order } = stored;
  const save = (next: OrderView, notices: CustomerNotice[] = []) => ({ stored: { ...stored, order: next }, notices });

  switch (action.type) {
    case "start_preparing":
      return order.state === "confirmado" ? save({ ...order, state: "preparando" }) : null;

    case "mark_line": {
      if (!PACKING.includes(order.state)) return null;
      const line = order.lines.find((l) => l.lineId === action.lineId);
      if (line === undefined) return null;
      if (action.mark === "ofrecer_otro" && action.substituteProductId === null) return null;
      const next: OrderView = {
        ...order,
        state: "preparando",
        lines: order.lines.map((l) =>
          l.lineId !== action.lineId
            ? l
            : {
                ...l,
                mark: action.mark,
                availability: action.mark === "listo" ? l.availability : "se_acabo",
                substitute:
                  action.mark === "ofrecer_otro" && action.substituteProductId !== null
                    ? { productId: action.substituteProductId, productName: action.substituteProductId, unitPrice: null }
                    : null,
              },
        ),
      };
      const notices: CustomerNotice[] =
        action.mark === "listo"
          ? []
          : [
              {
                customerId: stored.customerId,
                notice: {
                  type: action.mark === "no_hay" ? "line_unavailable" : "substitute_offered",
                  order: next,
                  lineId: action.lineId,
                },
              },
            ];
      return save(next, notices);
    }

    case "mark_ready": {
      if (!PACKING.includes(order.state)) return null;
      const next: OrderView = { ...order, state: "listo", queuePosition: null };
      return save(next, [{ customerId: stored.customerId, notice: { type: "order_ready", order: next } }]);
    }

    case "mark_delivered":
      return order.state === "listo" ? save({ ...order, state: "entregado" }) : null;

    case "match_line":
      return null;
  }
}
