/**
 * A pretend engine kept in memory, so the console and the replies can be built and tried before
 * the real engine lands. It follows the contract's rules for the preparation list (versions,
 * operation keys, roles) but saves straight into memory instead of returning commits, and forgets
 * everything when the Worker restarts. Wired in as is when the console runs in dev mode; the D1
 * pretend engine (`d1-pretend-engine.ts`) runs it on a snapshot kept in D1.
 *
 * Marking lines doesn't change an order's version: the version is the content the customer agreed
 * to, and only the customer's changes make a new one.
 *
 * Bursts are pretended just enough for a first order (PRD "A first order"): lines from the reading,
 * matched products priced from an optional catalog, one question at a time (an unclear line, the
 * name once, pickup or delivery), then the readback. It also answers "¿a qué hora está?", a cancel
 * and the reads perception needs (contract gaps a and b). Delivery (#29): a place in words or a
 * pin is used for a delivery order only; a saved place from the customer's context is offered as
 * "same_place" and used only after a yes (accept_saved_place, or a typed yes); no fee, since store
 * settings (#40) don't exist yet. Customer questions (#47) are answered from the catalog and the
 * hours it was given, never guessed: a product with no record is "no sé", a price only when set,
 * hours only when set. Payments and substitutes aren't pretended: they get the handoff.
 */
import type { CustomerContext, Engine, EngineResult, LineMatch, MemberContext } from "../../application/engine";
import type { OrderReadingSource } from "../../application/order-reading";
import { type CatalogProduct, normalize } from "../../application/perception/matching";
import type { Tenant } from "../../application/ports";
import { type ActionEnvelope, type ConsoleAction, type CustomerAction, OWNER_ACTIONS } from "../../domain/contract/actions";
import type { Centavos } from "../../domain/contract/numbers";
import type { BurstReading, Fulfillment, ItemLine, Observation, PerceptionContext } from "../../domain/contract/observation";
import type {
  AnswerFact,
  Availability,
  Claim,
  CustomerNotice,
  EngineOutcome,
  OrderLineView,
  OrderView,
  PreparationCard,
  QuestionCode,
  StoreHours,
} from "../../domain/contract/outcomes";
import { orderSubtotal } from "../../domain/money";
import { isYes, type SavedPlace, tidyPlaceText } from "../../domain/place";
import { storeHoursKey } from "../../domain/store-hours";

export interface StoredOrder {
  readonly customerId: string;
  readonly customerName: string | null;
  readonly confirmedAtMs: number;
  readonly changedLineIds: readonly string[];
  readonly order: OrderView;
}

/** A catalog product with the store's confirmed price, for the pretend readback. */
export interface PretendProduct extends CatalogProduct {
  /** Johan's confirmed price; null when none is confirmed. */
  readonly price: Centavos | null;
  /** From recent evidence (#37); absent means "no_se", never "hay". */
  readonly availability?: Availability;
  /** Alcohol or tobacco: never priced or offered in chat. */
  readonly restricted?: boolean;
}

export interface MemoryEngineOptions {
  readonly catalog?: readonly PretendProduct[];
  /** Store hours as settings would hold them (#40); absent or null means unset. */
  readonly storeHours?: StoreHours | null;
}

/** What the pretend engine keeps about an order while it's being put together. */
interface Draft {
  /** Questions still to ask, oldest first; `lineId` when one is about a line. */
  readonly pending: { readonly code: QuestionCode; readonly lineId: string | null }[];
  /** Each line's product words as perception read them ("aceite clover"), to settle a size answer. */
  readonly names: Map<string, string>;
  /** The current version was read back: any change makes a new version, so old taps are refused. */
  shown: boolean;
  /** The customer answered Otro lugar: the saved place isn't offered again for this order. */
  declinedSavedPlace: boolean;
}

interface StoreState {
  readonly orders: Map<string, StoredOrder>;
  /** Operation key -> the first outcome saved under it. */
  readonly operations: Map<string, EngineOutcome>;
  readonly drafts: Map<string, Draft>;
  /** Customer -> the question asked last, for perception's context. */
  readonly lastQuestion: Map<string, QuestionCode>;
}

/**
 * One store's state as plain JSON, for the D1 pretend engine (`d1-pretend-engine.ts`). Maps become
 * entry lists in insertion order, which the list's tie-breaks and "the open order" depend on.
 */
export interface PretendStoreSnapshot {
  readonly orders: readonly (readonly [string, StoredOrder])[];
  readonly operations: readonly (readonly [string, EngineOutcome])[];
  readonly drafts: readonly (readonly [string, DraftSnapshot])[];
  readonly lastQuestion: readonly (readonly [string, QuestionCode])[];
}

interface DraftSnapshot {
  readonly pending: readonly { readonly code: QuestionCode; readonly lineId: string | null }[];
  readonly names: readonly (readonly [string, string])[];
  readonly shown: boolean;
  /** Absent in snapshots saved before #29. */
  readonly declinedSavedPlace?: boolean;
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

    const burst = new BurstApplier(state, context, this.options.catalog ?? [], matches, this.options.storeHours ?? null);
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
    if (action.type === "accept_saved_place" || action.type === "decline_saved_place") {
      const outcome = this.placeAnswer(state, context, stored, action);
      if (outcome.type !== "rejected") state.operations.set(operationKey, outcome);
      if (outcome.type === "ask") state.lastQuestion.set(context.customerId, outcome.question);
      return result(outcome);
    }
    const answered = answer(stored, action, context.nowMs);
    if (answered === null) return result({ type: "rejected", reason: "invalid_state", order: stored.order });
    state.orders.set(action.orderId, answered.stored);
    state.operations.set(operationKey, answered.outcome);
    return result(answered.outcome);
  }

  /**
   * The same-place question answered by a tap: Sí uses the saved place the customer's context
   * names (only that one), Otro lugar asks where. Then the next question, or the readback.
   */
  private placeAnswer(
    state: StoreState,
    context: CustomerContext,
    stored: StoredOrder,
    action: Extract<CustomerAction, { type: "accept_saved_place" | "decline_saved_place" }>,
  ): EngineOutcome {
    if (stored.order.state !== "armando" || stored.order.fulfillment?.mode !== "delivery") {
      return { type: "rejected", reason: "invalid_state", order: stored.order };
    }
    const burst = new BurstApplier(state, context, this.options.catalog ?? [], [], this.options.storeHours ?? null);
    if (action.type === "accept_saved_place") {
      const saved = savedPlaceOf(context);
      if (saved === null || saved.placeId !== action.placeId) return { type: "rejected", reason: "not_found", order: stored.order };
      burst.useSavedPlace(saved);
    } else {
      burst.declineSavedPlace();
    }
    return burst.decide();
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
    const catalog = this.options.catalog ?? [];
    const product = (productId: string) => catalog.find((p) => p.productId === productId && p.restricted !== true);
    const hours = this.options.storeHours ?? null;
    return claims.map((claim) => {
      if (claim.type === "unit_price") return product(claim.productId)?.price === claim.price;
      if (claim.type === "availability") return (product(claim.productId)?.availability ?? "no_se") === claim.availability;
      if (claim.type === "store_hours") return hours !== null && storeHoursKey(hours) === storeHoursKey(claim.hours);
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

  /** The store's state as JSON-safe data (the store is seeded first if it hasn't been used yet). */
  exportStore(tenant: Tenant): PretendStoreSnapshot {
    const state = this.state(tenant);
    return {
      orders: [...state.orders],
      operations: [...state.operations],
      drafts: [...state.drafts].map(([orderId, draft]) => [
        orderId,
        {
          pending: draft.pending.map((p) => ({ ...p })),
          names: [...draft.names],
          shown: draft.shown,
          declinedSavedPlace: draft.declinedSavedPlace,
        },
      ]),
      lastQuestion: [...state.lastQuestion],
    };
  }

  /** Replaces the store's state with a snapshot taken by `exportStore`. The seed isn't used for it. */
  importStore(tenant: Tenant, snapshot: PretendStoreSnapshot): void {
    this.stores.set(tenant.businessId, {
      orders: new Map(snapshot.orders),
      operations: new Map(snapshot.operations),
      drafts: new Map(
        snapshot.drafts.map(([orderId, draft]) => [
          orderId,
          {
            pending: draft.pending.map((p) => ({ ...p })),
            names: new Map(draft.names),
            shown: draft.shown,
            declinedSavedPlace: draft.declinedSavedPlace ?? false,
          },
        ]),
      ),
      lastQuestion: new Map(snapshot.lastQuestion),
    });
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

/** The saved place our side put in the customer's context (proposed CustomerContext.savedPlace). */
function savedPlaceOf(context: CustomerContext): SavedPlace | null {
  return (context as { savedPlace?: SavedPlace | null }).savedPlace ?? null;
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
  /** The first question answered from records in this burst (#47). */
  private answer: EngineOutcome | null = null;
  private offTopic = false;

  constructor(
    private readonly state: StoreState,
    private readonly context: CustomerContext,
    private readonly catalog: readonly PretendProduct[],
    private readonly matches: readonly LineMatch[],
    private readonly storeHours: StoreHours | null,
  ) {
    this.stored = openOrderOf(state, context.customerId);
    this.before = this.stored?.order ?? null;
    this.draft = (this.stored && state.drafts.get(this.stored.order.orderId)) ?? {
      pending: [],
      names: new Map(),
      shown: false,
      declinedSavedPlace: false,
    };
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
        this.applyFulfillment(observation);
        return;
      case "clarification":
        if (this.answerPlaceQuestion(observation.answer)) return;
        this.settleQuestion(observation.answer);
        return;
      case "customer_name":
        this.named = observation.name;
        this.nameGiven = true;
        return;
      case "question":
        this.question(observation, index);
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
      // A question answered from records comes before asking the name: it's what they asked.
      if (this.answer !== null) return this.answer;
      if (this.offTopic) return { type: "out_of_scope" };
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
    if (order.fulfillment.mode === "delivery" && !hasPlace(order.fulfillment)) {
      // A saved place is offered as a question, once per order; never applied without a yes.
      const offer = savedPlaceOf(this.context) !== null && !this.draft.declinedSavedPlace;
      return this.ask(offer ? "same_place" : "delivery_place", null, "armando");
    }
    const onList = this.before !== null && PACKING.includes(this.before.state);
    const next: OrderView = { ...order, state: "por_confirmar", queuePosition: null };
    this.draft.shown = true;
    this.save(next);
    return onList ? { type: "order_changed", order: next } : { type: "readback", order: next };
  }

  /** "Sí" to the same-place question: the saved place, as our records gave it. */
  useSavedPlace(place: SavedPlace): void {
    this.setFulfillment({ mode: "delivery", placeId: place.placeId, placeText: place.placeText, pin: place.pin, fee: null });
  }

  /** "Otro lugar": the saved place isn't offered again for this order; the place is asked. */
  declineSavedPlace(): void {
    this.draft.declinedSavedPlace = true;
    this.setFulfillment({ mode: "delivery", placeId: null, placeText: null, pin: null, fee: null });
  }

  /**
   * How the order is received. Pickup drops any place (a place is for delivery only). A pin or a
   * place in words makes it a delivery to that place; "al mismo lugar de siempre" uses the saved
   * place only when there is one, and asks otherwise. No fee: store settings (#40) don't exist yet.
   */
  private applyFulfillment(observation: Fulfillment): void {
    if (this.stored === null) return;
    if (observation.mode === "pickup") return this.setFulfillment({ mode: "pickup" });
    const placeText = tidyPlaceText(observation.placeText);
    const pin = observation.pin;
    if (placeText !== null || pin !== null) {
      return this.setFulfillment({ mode: "delivery", placeId: null, placeText, pin, fee: null });
    }
    const saved = savedPlaceOf(this.context);
    if (observation.sameAsBefore && saved !== null) return this.useSavedPlace(saved);
    if (observation.mode === "delivery" && this.stored.order.fulfillment?.mode !== "delivery") {
      this.setFulfillment({ mode: "delivery", placeId: null, placeText: null, pin: null, fee: null });
    }
  }

  /**
   * An answer to a place question asked last: to "same_place", a clear yes uses the saved place and
   * anything else asks where; to "delivery_place", the answer is the place, kept as written.
   */
  private answerPlaceQuestion(answer: string): boolean {
    if (this.stored === null || this.stored.order.fulfillment?.mode !== "delivery") return false;
    const asked = this.state.lastQuestion.get(this.context.customerId);
    if (asked === "same_place") {
      const saved = savedPlaceOf(this.context);
      if (saved !== null && isYes(answer)) this.useSavedPlace(saved);
      else this.declineSavedPlace();
      return true;
    }
    if (asked === "delivery_place") {
      const placeText = tidyPlaceText(answer);
      if (placeText === null) return false;
      this.setFulfillment({ mode: "delivery", placeId: null, placeText, pin: null, fee: null });
      return true;
    }
    return false;
  }

  private setFulfillment(fulfillment: NonNullable<OrderView["fulfillment"]>): void {
    this.setOrder({ ...this.stored!.order, fulfillment });
  }

  private ask(question: QuestionCode, line: number | null, orderState: "armando"): EngineOutcome {
    const order: OrderView = { ...this.stored!.order, state: orderState };
    this.save(order);
    return { type: "ask", question, line, order };
  }

  /**
   * A customer question (#47). Price and stock come only from the catalog the code matched; a
   * product nobody matched is unknown. Off-topic questions get the short redirect; the balance
   * isn't pretended and goes to the store.
   */
  private question(observation: Extract<Observation, { kind: "question" }>, index: number): void {
    switch (observation.topic) {
      case "order_status":
        this.statusAsked = true;
        return;
      case "price":
      case "availability":
        this.answer ??= {
          type: "answer",
          topic: observation.topic,
          facts: observation.products.map((asked, n) => answerFact(asked, this.matchOf(index, n))),
        };
        return;
      case "store_hours":
        this.answer ??= { type: "store_hours", hours: this.storeHours };
        return;
      case "other":
        this.offTopic = true;
        return;
      case "balance":
        this.handoff = { type: "handoff" };
        return;
    }
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

/** What the records say about one product asked for: confirmed price and evidence only. */
function answerFact(asked: string, product: PretendProduct | null): AnswerFact {
  const restricted = product?.restricted === true;
  return {
    asked,
    productId: product?.productId ?? null,
    unitPrice: product === null || restricted ? null : product.price,
    availability: product === null || restricted ? "no_se" : (product.availability ?? "no_se"),
    restricted,
  };
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

function hasPlace(fulfillment: Extract<OrderView["fulfillment"], { mode: "delivery" }>): boolean {
  return fulfillment.placeText !== null || fulfillment.placeId !== null || (fulfillment.pin ?? null) !== null;
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
    case "decline_saved_place":
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
