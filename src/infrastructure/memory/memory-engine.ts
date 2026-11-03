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
 * "same_place" and used only after a yes (accept_saved_place, or a typed yes); a delivery carries
 * the store's fee when one was given (store setup, #40), none otherwise. Customer questions (#47)
 * are answered from the catalog and the hours it was given, never guessed: a product with no record
 * is "no sé", a price only when set, hours only when set. An ordered product marked "se_acabo"
 * keeps that mark on its line, so the readback says it's out and leaves it out of the total.
 * Payments and substitutes aren't pretended: they get the handoff.
 *
 * Conversation rules (Oct 31, proposed in docs/contract.md): a burst always gets something to say
 * (the current step again, never `nothing`); a question answered from records in a burst that also
 * moves the order comes back as `answered` beside the next step; the name is never asked while the
 * order is built: Confirmar with no name on file asks it and holds the confirmation, which the
 * name completes under the same operation key.
 *
 * The planner path (Nov 2, proposed in docs/contract.md "Proposed (Nov 2): planner"): with a
 * validated `TurnPlan`, a burst skips the question queue and the engine's own catalog search. New
 * lines take only code's exact matches and the planner's picks; the plan's changes and assumed
 * quantities are applied; then the plan's question is asked, or the order is read back, after the
 * readiness gate (`missingFor`, `settleStep`) has the last word. A draft the planner shaped stays
 * on that path: a later burst with no plan (small talk, a planner failure) asks what the readiness
 * gate says is missing, so the two kinds of questions never mix. Without a plan, a draft that never
 * had one behaves exactly as before.
 */
import type { AnsweredQuestion, CustomerContext, Engine, EngineResult, LineMatch, MemberContext } from "../../application/engine";
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
import { formatLempiras } from "../../domain/contract/numbers";
import { isYes, type SavedPlace, tidyPlaceText } from "../../domain/place";
import { storeHoursKey } from "../../domain/store-hours";
import { productWords, searchCatalog } from "../../domain/catalog-search";
import { fulfillmentWords, optionNumber, quantityFrom } from "../../domain/answer-words";
import { MAX_OPTIONS, type ProductOption } from "../../domain/contract/outcomes";
import type { DecimalString } from "../../domain/contract/numbers";
import type { AskKind, SoldBy, TurnPlan } from "../../domain/planner/types";
import { orderBasis } from "../../domain/planner/frame";
import type { ShownOption } from "../../domain/planner/option-answer";
import { isWeightUnit, MAX_WHICH_ASKS, settleStep } from "../../domain/planner/validate";
import { missingFor } from "../../domain/readiness";
import type { LastAsk, PlannerContext, PlannerSource } from "../../application/planner/source";

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
  /** How the store sells it (planner path); absent or null: the store hasn't said. */
  readonly soldBy?: SoldBy | null;
  /** The store's usual amount (planner path, D-46); absent or null: none. */
  readonly usualQuantity?: DecimalString | null;
}

export interface MemoryEngineOptions {
  readonly catalog?: readonly PretendProduct[];
  /** Store hours as settings would hold them (#40); absent or null means unset. */
  readonly storeHours?: StoreHours | null;
  /** The store's delivery fee (#40); absent or null means unset, and deliveries carry no fee. */
  readonly deliveryFee?: Centavos | null;
}

/** What the pretend engine keeps about an order while it's being put together. */
interface Draft {
  /**
   * Questions still to ask, oldest first; `lineId` when one is about a line; `options` (product
   * IDs) when the line fits a few of the store's products and the customer picks one.
   */
  readonly pending: PendingQuestion[];
  /** Each line's product words as perception read them ("aceite clover"), to settle a size answer. */
  readonly names: Map<string, string>;
  /** The current version was read back: any change makes a new version, so old taps are refused. */
  shown: boolean;
  /** The customer answered Otro lugar: the saved place isn't offered again for this order. */
  declinedSavedPlace: boolean;
  /** Set once the planner shaped this draft: the question last shown, and quantity asks per line. */
  planned?: PlannedDraft;
}

/** What the planner path keeps about a draft between bursts. */
interface PlannedDraft {
  last: StoredAsk | null;
  /** Line ID → how many times its quantity was asked (readiness stops after MAX_QUANTITY_ASKS). */
  readonly quantityAsks: Record<string, number>;
  /** Lines whose product the planner picked: after Confirmar, their words may become an alias. */
  picked?: string[];
  /** Line ID → other names the reader proposed for the item, for retrieval only. */
  otherNames?: Record<string, readonly string[]>;
  /** Line ID → how many times its "which one" (or unreadable) question was asked. */
  whichAsks?: Record<string, number>;
}

/** The question last shown, as kept: for options, also the list exactly as the customer saw it. */
interface StoredAsk extends LastAsk {
  /**
   * Numbered, with each name and price as shown (Codex final pass, finding 4, Nov 3). Absent for
   * other questions, and in snapshots saved before it.
   */
  readonly shown?: readonly ShownOption[];
}

/**
 * A confirmation held for the customer's name: Confirmar was tapped (or a yes typed) with no name
 * on file. The name completes it under the same operation key, so it's saved once.
 */
export interface HeldConfirmation {
  readonly orderId: string;
  readonly version: number;
  /** The customer-scoped operation key of the Confirmar that was held. */
  readonly operationKey: string;
  /** How many times the name was asked for this order. */
  readonly asks: number;
}

/** The name is asked at most this many times for one order; then the order is confirmed without it. */
export const MAX_NAME_ASKS = 2;

interface StoreState {
  readonly orders: Map<string, StoredOrder>;
  /** Operation key -> the first outcome saved under it. */
  readonly operations: Map<string, EngineOutcome>;
  readonly drafts: Map<string, Draft>;
  /** Customer -> the question asked last, for perception's context. */
  readonly lastQuestion: Map<string, QuestionCode>;
  /** Customer -> the confirmation waiting for their name. */
  readonly held: Map<string, HeldConfirmation>;
  /** The next order's number in this store (its code). */
  readonly counter: { next: number };
  /** Customer -> the products the last answer was about, until their next burst ("me manda una"). */
  readonly lastAnswer: Map<string, readonly string[]>;
}

/** A store's first order number: three digits read well out loud. */
export const FIRST_ORDER_NUMBER = 101;

/**
 * One store's state as plain JSON, for the D1 pretend engine (`d1-pretend-engine.ts`). Maps become
 * entry lists in insertion order, which the list's tie-breaks and "the open order" depend on.
 */
export interface PretendStoreSnapshot {
  readonly orders: readonly (readonly [string, StoredOrder])[];
  readonly operations: readonly (readonly [string, EngineOutcome])[];
  readonly drafts: readonly (readonly [string, DraftSnapshot])[];
  readonly lastQuestion: readonly (readonly [string, QuestionCode])[];
  /** Absent in snapshots saved before the conversation rules (Oct 31). */
  readonly held?: readonly (readonly [string, HeldConfirmation])[];
  /** Absent in snapshots saved before order numbers (Nov 2). */
  readonly nextOrderNumber?: number;
  /** Absent unless a customer's last burst got an answer (Nov 3). */
  readonly lastAnswer?: readonly (readonly [string, readonly string[]])[];
}

interface PendingQuestion {
  readonly code: QuestionCode;
  readonly lineId: string | null;
  readonly options?: readonly string[];
  /** Asked a second time because the first answer didn't settle it; never a third. */
  readonly again?: boolean;
  /** For `quantities`: the lines still waiting for one. */
  readonly lines?: readonly string[];
  /** How many times it was asked. */
  readonly asks?: number;
}

/** A question about several quantities is asked at most this many times, then the order moves on. */
export const MAX_QUANTITIES_ASKS = 2;

interface DraftSnapshot {
  readonly pending: readonly PendingQuestion[];
  readonly names: readonly (readonly [string, string])[];
  readonly shown: boolean;
  /** Absent in snapshots saved before #29. */
  readonly declinedSavedPlace?: boolean;
  /** Absent unless the planner shaped the draft (Nov 2). */
  readonly planned?: PlannedDraft;
}

const ON_THE_LIST: readonly OrderView["state"][] = ["confirmado", "preparando", "listo"];
const PACKING: readonly OrderView["state"][] = ["confirmado", "preparando"];

const OPEN: readonly OrderView["state"][] = ["armando", "por_confirmar", "confirmado", "preparando", "listo"];

export class MemoryEngine implements Engine, OrderReadingSource, PlannerSource {
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
  async onBurst(context: CustomerContext, reading: BurstReading, matches: readonly LineMatch[], plan?: TurnPlan): Promise<EngineResult> {
    const state = this.state(context);
    const key = customerOperationKey(context.customerId, `burst:${context.jobId}`);
    const first = state.operations.get(key);
    if (first !== undefined) return result(first);

    // A plan checked against another version of the order is refused whole, its picks too: its labels
    // and checks hold only for the order it saw. The burst then asks what the readiness gate says.
    const stale = plan !== undefined && plan.basis !== orderBasis(openOrderOf(state, context.customerId)?.order ?? null);
    const burst = new BurstApplier(
      state,
      context,
      this.options.catalog ?? [],
      stale ? matches.filter((match) => match.how !== "planner_pick") : matches,
      this.options.storeHours ?? null,
      this.options.deliveryFee ?? null,
      stale ? null : (plan ?? null),
      stale,
    );
    reading.observations.forEach((observation, index) => burst.apply(observation, index));
    burst.applyPlan();
    const { outcome, answered } = burst.decide();
    state.operations.set(key, outcome);
    if (outcome.type === "ask") state.lastQuestion.set(context.customerId, outcome.question);
    else state.lastQuestion.delete(context.customerId);
    // What this burst's answer was about, so "me manda una" next can point at it (eval E11).
    const asked = [outcome, answered].flatMap((said) => (said?.type === "answer" ? said.facts.map((fact) => fact.asked) : []));
    if (asked.length > 0) state.lastAnswer.set(context.customerId, asked);
    else state.lastAnswer.delete(context.customerId);
    return answered === null ? result(outcome) : { ...result(outcome), answered };
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
      ...this.pendingOptionsOf(state, open),
      ...(state.lastAnswer.has(context.customerId) ? { lastAnswered: state.lastAnswer.get(context.customerId)! } : {}),
    };
  }

  /** The options the open order's next question offers, labelled as the customer saw them. */
  private pendingOptionsOf(state: StoreState, open: StoredOrder | null): { pendingOptions?: { label: string; text: string }[] } {
    const pending = open === null ? undefined : state.drafts.get(open.order.orderId)?.pending[0];
    const ids = pending?.options ?? [];
    const catalog = this.options.catalog ?? [];
    const options = ids.flatMap((id, n) => {
      const product = catalog.find((p) => p.productId === id);
      // As the customer saw it, price included: "la de 34" names the price.
      if (product === undefined) return [];
      const name = product.names[0] ?? id;
      const price = product.restricted === true || product.price === null ? "" : ` · ${formatLempiras(product.price)}`;
      return [{ label: `O${n + 1}`, text: `${name}${price}` }];
    });
    return options.length > 1 ? { pendingOptions: options } : {};
  }

  /**
   * The options last shown, as the customer saw them: numbered on from line to line, with the name
   * and price each had then (Codex final pass, finding 4, Nov 3). When a shown price is no longer
   * the store's, prices name nothing in that list ("la de 34" is left to the model), and the
   * readback shows today's price. A snapshot from before the list was kept has no shown prices.
   */
  private shownOptions(last: StoredAsk | null): ShownOption[] {
    if (last?.kind !== "options") return [];
    const catalog = this.options.catalog ?? [];
    const priceNow = (productId: string) => {
      const product = catalog.find((p) => p.productId === productId);
      return product === undefined ? undefined : product.restricted === true ? null : product.price;
    };
    if (last.shown !== undefined) {
      const changed = last.shown.some((option) => priceNow(option.productId) !== option.price);
      return changed ? last.shown.map((option) => ({ ...option, price: null })) : [...last.shown];
    }
    let number = 0;
    return last.lineIds.flatMap((lineId) =>
      (last.options?.[lineId] ?? []).flatMap((productId): ShownOption[] => {
        const product = catalog.find((p) => p.productId === productId);
        if (product === undefined) return [];
        number += 1;
        return [{ number, lineId, productId, name: product.names[0] ?? productId, price: null }];
      }),
    );
  }

  async catalog(): Promise<readonly CatalogProduct[]> {
    return this.options.catalog ?? [];
  }

  /** What the planner may know: the open order, each line's words, the question last shown, the store. */
  async plannerContext(context: CustomerContext): Promise<PlannerContext> {
    const state = this.state(context);
    const open = openOrderOf(state, context.customerId);
    const draft = open === null ? undefined : state.drafts.get(open.order.orderId);
    return {
      order: open?.order ?? null,
      said: Object.fromEntries((open?.order.lines ?? []).map((line) => [line.lineId, draft?.names.get(line.lineId) ?? line.text])),
      otherNames: { ...(draft?.planned?.otherNames ?? {}) },
      picked: [...(draft?.planned?.picked ?? [])],
      lastAsk: lastAskOf(draft?.planned?.last ?? null),
      shownOptions: this.shownOptions(draft?.planned?.last ?? null),
      lastAnswered: state.lastAnswer.get(context.customerId) ?? [],
      store: { hoursSet: (this.options.storeHours ?? null) !== null, delivery: (this.options.deliveryFee ?? null) !== null ? "yes" : "unknown" },
    };
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
    if (action.type === "confirm_order" && stored.order.state === "por_confirmar") {
      const held = holdForName(state, context, stored, action.version, operationKey);
      if (held !== null) return result(held);
    }
    const answered = answer(stored, action, context.nowMs);
    if (answered === null) return result({ type: "rejected", reason: "invalid_state", order: stored.order });
    if (answered.outcome.type === "order_confirmed") state.held.delete(context.customerId);
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
    const burst = new BurstApplier(state, context, this.options.catalog ?? [], [], this.options.storeHours ?? null, this.options.deliveryFee ?? null, null);
    if (action.type === "accept_saved_place") {
      const saved = savedPlaceOf(context);
      if (saved === null || saved.placeId !== action.placeId) return { type: "rejected", reason: "not_found", order: stored.order };
      burst.useSavedPlace(saved);
    } else {
      burst.declineSavedPlace();
    }
    return burst.decide().outcome;
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
          ...(draft.planned === undefined ? {} : { planned: structuredClone(draft.planned) }),
        },
      ]),
      lastQuestion: [...state.lastQuestion],
      held: [...state.held],
      ...(state.lastAnswer.size === 0 ? {} : { lastAnswer: [...state.lastAnswer] }),
      nextOrderNumber: state.counter.next,
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
            ...(draft.planned === undefined ? {} : { planned: structuredClone(draft.planned) }),
          },
        ]),
      ),
      lastQuestion: new Map(snapshot.lastQuestion),
      held: new Map(snapshot.held ?? []),
      counter: { next: snapshot.nextOrderNumber ?? FIRST_ORDER_NUMBER },
      lastAnswer: new Map(snapshot.lastAnswer ?? []),
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
        held: new Map(),
        counter: { next: FIRST_ORDER_NUMBER },
        lastAnswer: new Map(),
      };
      this.stores.set(tenant.businessId, state);
    }
    return state;
  }
}

/** The customer's name our side put in the context (local CustomerContextWithName), if any. */
function nameOf(context: CustomerContext): string | null {
  return (context as { customerName?: string | null }).customerName ?? null;
}

/**
 * Confirmar with no name on file: the name is asked and the confirmation held, unless the name was
 * asked before for another order (asked once) or was asked MAX_NAME_ASKS times for this one (then
 * the order is confirmed without it). Null when the confirmation goes ahead now.
 */
function holdForName(
  state: StoreState,
  context: CustomerContext,
  stored: StoredOrder,
  version: number,
  operationKey: string,
): EngineOutcome | null {
  const held = state.held.get(context.customerId);
  if ((nameOf(context) ?? stored.customerName) !== null) return null;
  const sameOrder = held?.orderId === stored.order.orderId;
  const askedBefore = (context as { customerNameAsked?: boolean }).customerNameAsked ?? false;
  if (!sameOrder && askedBefore) return null;
  const asks = (sameOrder ? held!.asks : 0) + 1;
  if (asks > MAX_NAME_ASKS) return null;
  state.held.set(context.customerId, { orderId: stored.order.orderId, version, operationKey, asks });
  state.lastQuestion.set(context.customerId, "customer_name");
  return { type: "ask", question: "customer_name", line: null, order: stored.order };
}

/** An options question's list as the reply numbers it: on from line to line, each name and price as shown. */
function shownList(lineIds: readonly string[], options: ReadonlyMap<string, readonly ProductOption[]>): ShownOption[] {
  let number = 0;
  return lineIds.flatMap((lineId) =>
    (options.get(lineId) ?? []).map((option) => ({ number: ++number, lineId, productId: option.productId, name: option.name, price: option.unitPrice })),
  );
}

/** The question last shown as the planner reads it (`LastAsk`), without the list kept beside it. */
function lastAskOf(stored: StoredAsk | null): LastAsk | null {
  if (stored === null) return null;
  const { shown: _shown, ...last } = stored;
  return last;
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
  private handoff: EngineOutcome | null = null;
  private embedded = false;
  /** The first question answered from records in this burst (#47). */
  private answer: AnsweredQuestion | null = null;
  private offTopic = false;
  /** Lines added by this burst, in order, with the products that fit them when a few do. */
  private readonly added: { readonly lineId: string; readonly options: readonly string[]; readonly quantity: boolean }[] = [];
  /** Planner path: the lines this burst added, in order (N1 is the first). */
  private readonly newLines: string[] = [];
  /** Planner path: lines whose quantity this burst assumed. */
  private readonly assumedNow: string[] = [];
  /** The reading flagged something it couldn't read. */
  private illegible = false;
  /** On the planner path: a plan came with this burst, or the planner shaped the draft before. */
  private readonly planning: boolean;

  constructor(
    private readonly state: StoreState,
    private readonly context: CustomerContext,
    private readonly catalog: readonly PretendProduct[],
    private readonly matches: readonly LineMatch[],
    private readonly storeHours: StoreHours | null,
    private readonly deliveryFee: Centavos | null,
    private readonly plan: TurnPlan | null,
    stalePlan = false,
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
    this.planning = plan !== null || stalePlan || this.draft.planned !== undefined;
  }

  apply(observation: Observation, index: number): void {
    if (observation.issues.some((issue) => issue.code === "embedded_instructions")) this.embedded = true;
    if (observation.issues.some((issue) => issue.code === "illegible")) this.illegible = true;
    switch (observation.kind) {
      case "customer_order":
        observation.lines.forEach((line, n) => this.addLine(line, this.matchOf(index, n), this.matchAt(index, n)?.how));
        if (this.planning) return;
        this.queueIssues(observation, observation.lines.length);
        this.queueLineQuestions();
        return;
      case "order_change":
        observation.edits.forEach((edit, n) => {
          if (edit.op === "add") return this.addLine(edit.line, this.matchOf(index, n), this.matchAt(index, n)?.how);
          const at = edit.target.ref === null ? -1 : Number(edit.target.ref.slice(1)) - 1;
          const line = this.stored?.order.lines[at];
          if (line === undefined) return this.planning ? undefined : this.draft.pending.push({ code: "ambiguous_product", lineId: null });
          // "Entonces solo los frijoles" after a No hay: that line is already out; nothing changes.
          if (edit.op === "remove" && line.mark === "no_hay") return;
          this.setLines(
            edit.op === "remove"
              ? this.stored!.order.lines.filter((l) => l !== line)
              : this.stored!.order.lines.map((l) => (l === line ? withQuantity(l, edit.quantity) : l)),
          );
        });
        if (!this.planning) this.queueLineQuestions();
        return;
      case "order_cancel":
        this.cancelled = this.stored !== null;
        return;
      case "fulfillment":
        this.applyFulfillment(observation);
        return;
      case "clarification":
        if (this.answerPlaceQuestion(observation.answer)) return;
        if (this.answerFulfillmentQuestion(observation.answer)) return;
        // On the planner path the plan says what an answer changed (its `changes`).
        if (!this.planning) this.settleQuestion(observation.answer, observation.pick ?? null, observation.quantity ?? null);
        return;
      case "customer_name":
        this.named = observation.name;
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

  /**
   * The one thing to say for the burst, and a question answered from records to say before it.
   * Never `nothing`: a burst that changes nothing hears the current step again.
   */
  decide(): { outcome: EngineOutcome; answered: AnsweredQuestion | null } {
    const only = (outcome: EngineOutcome) => ({ outcome, answered: null });
    const { state, context } = this;
    const held = this.heldConfirmation();
    if (this.cancelled && this.stored !== null) {
      const order: OrderView = { ...this.stored.order, state: "cancelado", queuePosition: null };
      this.save(order);
      state.held.delete(context.customerId);
      return only({ type: "order_cancelled", order });
    }
    if (this.handoff !== null) return only(this.handoff);
    if (this.plan?.move === "handoff") {
      // Only the owner can answer it. What the burst added is kept, being built, for after.
      if (this.changed && this.stored !== null) this.save({ ...this.stored.order, state: "armando" });
      return only({ type: "handoff" });
    }

    if (this.stored === null || !this.changed) {
      if (this.statusAsked) {
        // "¿Ya anotaste…?" while it's being built: what's noted and the open question, not a status.
        if (this.stored !== null && this.stored.order.state === "armando") return only(this.restate());
        const order = this.stored === null ? null : { ...this.stored.order, queuePosition: queuePosition(state, this.stored.order.orderId) };
        return only({ type: "order_status", order });
      }
      // The name arrived for a held Confirmar: the confirmation completes, under its own key.
      if (held !== null && this.named !== null) return only(this.completeHeld(held));
      // A question answered from records comes first: it's what they asked. A question still
      // waiting on them goes after it, so the order keeps moving.
      if (this.answer !== null) {
        const waiting = held !== null ? this.askName(held, false) : this.waitingQuestion();
        return waiting === null ? only(this.answer) : { outcome: waiting, answered: this.answer };
      }
      // Waiting for the name, anything else ("¿para qué mi nombre?") gets the name question again,
      // gently: it counts toward MAX_NAME_ASKS, so the order is never stuck on it.
      if (held !== null) return only(this.askName(held, true));
      if (this.offTopic) return only({ type: "out_of_scope" });
      if (this.embedded) return only({ type: "ask", question: "embedded_instructions", line: null, order: null });
      // No order yet ("Hola, quiero hacer un pedido"): ask what they want.
      if (this.stored === null) return only({ type: "ask", question: "what_to_order", line: null, order: null });
      return only(this.restate());
    }

    // The order changed: one question at a time, then the readback. The name isn't asked here.
    return { outcome: this.nextStep(), answered: this.answer };
  }

  /** The next step for an order being built: an open question, pickup or delivery, the place, the readback. */
  private nextStep(): EngineOutcome {
    if (this.planning) return this.plannedStep();
    const order = this.stored!.order;
    this.dropSettledQuestions(order);
    // Asked enough: the order moves on with those lines' quantities unknown, never made up.
    if (this.draft.pending[0]?.code === "quantities" && (this.draft.pending[0].asks ?? 0) >= MAX_QUANTITIES_ASKS) this.draft.pending.shift();
    const pending = this.draft.pending[0];
    if (pending?.code === "quantities") this.draft.pending[0] = { ...pending, asks: (pending.asks ?? 0) + 1 };
    if (pending !== undefined) {
      const line = pending.lineId === null ? -1 : order.lines.findIndex((l) => l.lineId === pending.lineId);
      return this.ask(pending.code, line === -1 ? null : line, "armando", pending.options);
    }
    if (order.fulfillment === null) return this.ask("pickup_or_delivery", null, "armando");
    if (order.fulfillment.mode === "delivery" && !hasPlace(order.fulfillment)) {
      // A saved place is offered as a question, once per order; never applied without a yes.
      const offer = savedPlaceOf(this.context) !== null && !this.draft.declinedSavedPlace;
      return this.ask(offer ? "same_place" : "delivery_place", null, "armando");
    }
    return this.readbackStep();
  }

  /** The order is complete: read back (or, already on the list, read back as changed). */
  private readbackStep(): EngineOutcome {
    const order = this.stored!.order;
    const onList = this.before !== null && PACKING.includes(this.before.state);
    const next: OrderView = { ...order, state: "por_confirmar", queuePosition: null };
    this.draft.shown = true;
    if (this.draft.planned !== undefined) this.draft.planned.last = null;
    this.save(next);
    return onList ? { type: "order_changed", order: next } : { type: "readback", order: next };
  }

  /**
   * The plan's changes and assumed quantities, after the observations. Labels resolve against this
   * turn: "N3" is the third line this burst added, "L2" the second line of the order as it was.
   */
  applyPlan(): void {
    if (this.plan === null) return;
    for (const change of this.plan.changes ?? []) {
      const lineId = this.lineIdOf(change.lineRef);
      const line = this.stored?.order.lines.find((l) => l.lineId === lineId);
      if (line === undefined) continue;
      if (change.remove === true) {
        this.setLines(this.stored!.order.lines.filter((l) => l.lineId !== lineId));
        continue;
      }
      let next = line;
      const product = change.productId === undefined ? undefined : this.catalog.find((p) => p.productId === change.productId);
      if (product !== undefined && product.productId !== line.productId) {
        const restricted = line.restricted || product.restricted === true;
        next = { ...next, productId: product.productId, productName: product.names[0] ?? null, unitPrice: restricted ? null : product.price, availability: soldOutOrUnknown(product), restricted };
        const planned = this.plannedDraft();
        planned.picked = [...(planned.picked ?? []).filter((id) => id !== line.lineId), line.lineId];
      }
      if (change.quantity !== undefined && (change.quantity !== line.quantity || line.quantitySource !== undefined)) next = withQuantity(next, change.quantity);
      if (next !== line) this.setLines(this.stored!.order.lines.map((l) => (l.lineId === lineId ? next : l)));
    }
    for (const assumed of this.plan.assumed) {
      const lineId = this.lineIdOf(assumed.lineRef);
      const line = this.stored?.order.lines.find((l) => l.lineId === lineId);
      if (line === undefined || line.quantity !== null) continue;
      // Checked again against the product as it is now: never 1 of something sold by the pound or
      // restricted, and a usual amount only while the store still says it.
      const product = line.productId === null ? undefined : this.catalog.find((p) => p.productId === line.productId);
      if (line.restricted || product?.restricted === true) continue;
      if (assumed.source === "suggested" && (assumed.quantity !== "1" || weighed(line.unit, product))) continue;
      if (assumed.source === "store_usual" && (product?.usualQuantity ?? null) !== assumed.quantity) continue;
      this.setLines(this.stored!.order.lines.map((l) => (l.lineId === lineId ? { ...l, quantity: assumed.quantity, quantitySource: assumed.source } : l)));
      this.assumedNow.push(line.lineId);
    }
  }

  /** A label of this turn as a line ID: N from this burst's new lines, L from the order before it. */
  private lineIdOf(ref: string): string | null {
    const label = /^([NL])([1-9]\d{0,8})$/u.exec(ref);
    if (label === null) return null;
    const at = Number(label[2]) - 1;
    return (label[1] === "N" ? this.newLines[at] : this.before?.lines[at]?.lineId) ?? null;
  }

  /**
   * The planner path's next step: the plan's question or readback, or, with no plan (or a plan that
   * only restates), the question last shown; the readiness gate has the last word (settleStep).
   */
  private plannedStep(): EngineOutcome {
    const order = this.stored!.order;
    const planned = this.plannedDraft();
    const plan = this.plan;
    const options = this.optionsByLine();
    let proposed: Parameters<typeof settleStep>[0]["proposed"] = null;
    if (plan?.move === "ask" && plan.ask !== null) {
      proposed = { kind: plan.ask.kind, lineIds: plan.ask.lineRefs.flatMap((ref) => this.lineIdOf(ref) ?? []) };
    } else if (plan?.move === "readback") {
      proposed = "readback";
    } else if (!this.changed && planned.last !== null) {
      proposed = { kind: planned.last.kind, lineIds: planned.last.lineIds };
    }
    const step = settleStep({
      order,
      missing: missingFor(order, planned.quantityAsks),
      proposed,
      withOptions: new Set([...options].filter(([, found]) => found.length > 1).map(([lineId]) => lineId)),
      illegible: this.illegible,
      exhausted: new Set(Object.entries(planned.whichAsks ?? {}).filter(([, asks]) => asks >= MAX_WHICH_ASKS).map(([lineId]) => lineId)),
    });
    return step.type === "readback" ? this.readbackStep() : this.plannedAsk(step.kind, step.lineIds, options);
  }

  /** Each line's products to choose from: this plan's, or those shown with the question last asked. */
  private optionsByLine(): Map<string, ProductOption[]> {
    const ids = new Map<string, readonly string[]>();
    if (this.plan !== null) {
      for (const offer of this.plan.options ?? []) {
        const lineId = this.lineIdOf(offer.lineRef);
        if (lineId !== null) ids.set(lineId, offer.productIds);
      }
    } else {
      for (const [lineId, productIds] of Object.entries(this.draft.planned?.last?.options ?? {})) ids.set(lineId, productIds);
    }
    return new Map(
      [...ids].map(([lineId, productIds]) => [
        lineId,
        productIds.slice(0, MAX_OPTIONS).flatMap((id): ProductOption[] => {
          const product = this.catalog.find((p) => p.productId === id);
          // "No hay" is never offered as a choice (the planner may still know it's out).
          if (product === undefined || product.availability === "se_acabo") return [];
          return [{ productId: id, name: product.names[0] ?? id, unitPrice: product.restricted === true ? null : product.price }];
        }),
      ]),
    );
  }

  /** One kind of question about its lines (D-47), remembered for the next turn and counted. */
  private plannedAsk(kind: Exclude<AskKind, "none">, lineIds: readonly string[], options: ReadonlyMap<string, readonly ProductOption[]>): EngineOutcome {
    const planned = this.draft.planned!;
    const same = planned.last?.kind === kind && planned.last.lineIds.join() === lineIds.join();
    const shown = kind === "options" ? Object.fromEntries(lineIds.map((id) => [id, (options.get(id) ?? []).map((o) => o.productId)])) : undefined;
    planned.last = {
      kind,
      lineIds: [...lineIds],
      ...(shown === undefined ? {} : { options: shown, shown: shownList(lineIds, options) }),
      times: same ? planned.last!.times + 1 : 1,
    };
    if (kind === "quantities") for (const id of lineIds) planned.quantityAsks[id] = (planned.quantityAsks[id] ?? 0) + 1;
    if (kind === "options" || kind === "unreadable") {
      const asks = (planned.whichAsks ??= {});
      for (const id of lineIds) asks[id] = (asks[id] ?? 0) + 1;
    }
    if (kind === "delivery_place" && savedPlaceOf(this.context) !== null && !this.draft.declinedSavedPlace) {
      // A saved place is offered as a question, once per order; never applied without a yes.
      return this.ask("same_place", null, "armando");
    }
    const order: OrderView = { ...this.stored!.order, state: "armando" };
    this.save(order);
    const line = lineIds.length === 0 ? -1 : order.lines.findIndex((l) => l.lineId === lineIds[0]);
    const byWeight = kind === "quantities" ? lineIds.filter((id) => this.soldByWeight(order.lines.find((l) => l.lineId === id))) : [];
    const assumed = this.assumedNow.filter((id) => order.lines.some((l) => l.lineId === id));
    return {
      type: "ask",
      question: questionCodeOf(kind, lineIds.length),
      line: line === -1 ? null : line,
      order,
      questions: {
        kind,
        lineIds: [...lineIds],
        ...(shown === undefined ? {} : { options: Object.fromEntries(lineIds.map((id) => [id, [...(options.get(id) ?? [])]])) }),
        ...(byWeight.length === 0 ? {} : { byWeight }),
      },
      ...(assumed.length === 0 ? {} : { assumed }),
      noted: this.notedNow(order),
    };
  }

  /**
   * The lines this burst added or changed (a new quantity, product or unit), which the reply echoes
   * back. Nothing new (an answer about how it's received, an "ok"): none, and no echo. "¿Ya
   * anotaste…?" asks exactly that: every line.
   */
  private notedNow(order: OrderView): string[] {
    if (this.statusAsked) return order.lines.map((line) => line.lineId);
    const before = new Map((this.before?.lines ?? []).map((line) => [line.lineId, line]));
    return order.lines
      .filter((line) => {
        const was = before.get(line.lineId);
        return was === undefined || was.quantity !== line.quantity || was.productId !== line.productId || was.unit !== line.unit;
      })
      .map((line) => line.lineId);
  }

  private soldByWeight(line: OrderLineView | undefined): boolean {
    if (line === undefined) return false;
    const product = line.productId === null ? undefined : this.catalog.find((p) => p.productId === line.productId);
    return weighed(line.unit, product);
  }

  /** The planner path's state for this draft, made on first use. */
  private plannedDraft(): PlannedDraft {
    return (this.draft.planned ??= { last: null, quantityAsks: {} });
  }

  /**
   * A line in pounds (D-46 readback): its product is sold by weight, or the customer said a weight
   * for a product the store doesn't sell by unit. The unit is the one said, or "libra".
   */
  private withWeight(line: OrderLineView): OrderLineView {
    const product = line.productId === null ? undefined : this.catalog.find((p) => p.productId === line.productId);
    if (weighed(line.unit, product)) {
      return line.byWeight === true && isWeightUnit(line.unit) ? line : { ...line, byWeight: true, unit: isWeightUnit(line.unit) ? line.unit : "libra" };
    }
    if (line.byWeight === undefined) return line;
    const { byWeight: _weighed, ...counted } = line;
    return counted;
  }

  /**
   * Questions the order no longer needs: about a line that's gone, a quantity given some other way
   * ("que sean tres"), or a line matched since.
   */
  private dropSettledQuestions(order: OrderView): void {
    const kept = this.draft.pending.filter((p) => {
      if (p.lineId === null) return true;
      const line = order.lines.find((l) => l.lineId === p.lineId);
      if (line === undefined) return false;
      if (p.code === "quantity") return line.quantity === null;
      if (p.options !== undefined) return line.productId === null;
      return true;
    }).flatMap((p): PendingQuestion[] => {
      if (p.code !== "quantities") return [p];
      const waiting = (p.lines ?? []).filter((id) => order.lines.some((l) => l.lineId === id && l.quantity === null));
      return waiting.length === 0 ? [] : [{ ...p, lines: waiting }];
    });
    this.draft.pending.splice(0, this.draft.pending.length, ...kept);
  }

  /**
   * Nothing changed: where the order stands, said again. Being built: the open question again. Read
   * back and waiting: the same readback, same version. On the list: its status.
   */
  private restate(): EngineOutcome {
    const order = this.stored!.order;
    if (order.state === "armando") return this.nextStep();
    if (order.state === "por_confirmar") return { type: "readback", order };
    return { type: "order_status", order: { ...order, queuePosition: queuePosition(this.state, order.orderId) } };
  }

  /** The question an order being built still waits on, if any; null once it's read back or later. */
  private waitingQuestion(): EngineOutcome | null {
    if (this.stored === null || this.stored.order.state !== "armando") return null;
    return this.nextStep();
  }

  /** The held confirmation for the open order, if any; a hold for another order is dropped. */
  private heldConfirmation(): HeldConfirmation | null {
    const held = this.state.held.get(this.context.customerId) ?? null;
    if (held === null) return null;
    if (this.stored === null || held.orderId !== this.stored.order.orderId) {
      this.state.held.delete(this.context.customerId);
      return null;
    }
    return held;
  }

  /**
   * The name question again for a held confirmation. `counted`: this burst answered with no name
   * (it counts toward MAX_NAME_ASKS; past it, the order is confirmed without the name).
   */
  private askName(held: HeldConfirmation, counted: boolean): EngineOutcome {
    const order = this.stored!.order;
    if (order.state !== "por_confirmar" || order.version !== held.version) {
      this.state.held.delete(this.context.customerId);
      return this.restate();
    }
    const asks = held.asks + (counted ? 1 : 0);
    if (asks > MAX_NAME_ASKS) return this.completeHeld(held);
    this.state.held.set(this.context.customerId, { ...held, asks });
    return { type: "ask", question: "customer_name", line: null, order };
  }

  /** Confirms the held version under the held key, once; a version that moved on is read back instead. */
  private completeHeld(held: HeldConfirmation): EngineOutcome {
    this.state.held.delete(this.context.customerId);
    const stored = this.stored!;
    if (stored.order.state !== "por_confirmar" || stored.order.version !== held.version) return this.restate();
    const order: OrderView = { ...agreed(stored.order), state: "confirmado" };
    const outcome: EngineOutcome = { type: "order_confirmed", order };
    this.stored = { ...stored, customerName: this.named, confirmedAtMs: this.context.nowMs, order };
    this.state.orders.set(order.orderId, this.stored);
    this.state.operations.set(held.operationKey, outcome);
    return outcome;
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
   * place only when there is one, and asks otherwise. The fee is added in `setFulfillment`.
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

  /** A delivery always carries the store's fee as set up (#40), or none when unset. */
  private setFulfillment(fulfillment: NonNullable<OrderView["fulfillment"]>): void {
    if (fulfillment.mode === "delivery") fulfillment = { ...fulfillment, fee: this.deliveryFee };
    // "Ya voy" to an order that's already for pickup changes nothing: it must not reopen it.
    if (sameFulfillment(this.stored!.order.fulfillment, fulfillment)) return;
    this.setOrder({ ...this.stored!.order, fulfillment });
  }

  /**
   * An answer to "¿Lo recogés en la tienda o te lo llevamos?" that perception read as a plain
   * answer ("a domicilio", "lo recojo"). Only clear words count; anything else is left alone.
   */
  private answerFulfillmentQuestion(answer: string): boolean {
    if (this.stored === null) return false;
    if (this.state.lastQuestion.get(this.context.customerId) !== "pickup_or_delivery") return false;
    const mode = fulfillmentWords(answer);
    if (mode === null) return false;
    if (mode === "pickup") this.setFulfillment({ mode: "pickup" });
    else this.setFulfillment({ mode: "delivery", placeId: null, placeText: null, pin: null, fee: null });
    return true;
  }

  private ask(question: QuestionCode, line: number | null, orderState: "armando", optionIds?: readonly string[]): EngineOutcome {
    const order: OrderView = { ...this.stored!.order, state: orderState };
    this.save(order);
    const options = (optionIds ?? []).flatMap((id): ProductOption[] => {
      const product = this.catalog.find((p) => p.productId === id);
      return product === undefined ? [] : [{ productId: id, name: product.names[0] ?? id, unitPrice: product.restricted ? null : product.price }];
    });
    const noted = this.notedNow(order);
    return options.length > 1 ? { type: "ask", question, line, order, options, noted } : { type: "ask", question, line, order, noted };
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
          facts: observation.products.flatMap((asked, n) => this.factsFor(asked, this.matchOf(index, n))),
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

  /**
   * What the records say about a product asked for. Not matched: the store's products that fit the
   * words, when a few do ("¿a cómo el aceite?" → each aceite and its price); otherwise unknown.
   */
  private factsFor(asked: string, matched: PretendProduct | null): AnswerFact[] {
    if (matched !== null) return [answerFact(asked, matched)];
    const found = searchCatalog(asked, this.catalog);
    if (found.length === 0 || found.length > MAX_OPTIONS) return [answerFact(asked, null)];
    return found.map((product) => answerFact(product.names[0] ?? asked, product));
  }

  private matchOf(observation: number, line: number): PretendProduct | null {
    const match = this.matchAt(observation, line);
    return match === undefined ? null : (this.catalog.find((product) => product.productId === match.productId) ?? null);
  }

  private matchAt(observation: number, line: number): LineMatch | undefined {
    return this.matches.find((m) => m.observation === observation && m.line === line);
  }

  /**
   * A new line. Not matched by perception: the store's products that fit its words. One is that
   * product; a few (up to MAX_OPTIONS) are offered to pick from; none or too many leave it unmatched.
   * A line with no quantity gets the quantity question: absent is never one.
   */
  private addLine(line: ItemLine, product: PretendProduct | null, how?: LineMatch["how"]): void {
    const order = this.stored?.order ?? this.newOrder();
    const lineId = `${order.orderId}-${order.lines.length + 1}`;
    this.draft.names.set(lineId, line.name);
    if (this.planning) {
      // Only code's exact matches and the planner's picks: never a guess by words or a typo.
      this.setLines([...order.lines, lineView(lineId, line, product)], order);
      this.newLines.push(lineId);
      const planned = this.plannedDraft();
      if (product !== null && how === "planner_pick") planned.picked = [...(planned.picked ?? []), lineId];
      if ((line.otherNames ?? []).length > 0) planned.otherNames = { ...planned.otherNames, [lineId]: [...line.otherNames!] };
      return;
    }
    let options: string[] = [];
    if (product === null && !line.restrictedCategory) {
      const found = searchCatalog(line.name, this.catalog);
      if (found.length === 1) product = found[0]!;
      else if (found.length > 1 && found.length <= MAX_OPTIONS) options = found.map((p) => p.productId);
    }
    this.setLines([...order.lines, lineView(lineId, line, product)], order);
    this.added.push({ lineId, options, quantity: line.quantity === null && !line.restrictedCategory });
  }

  /**
   * After perception's own questions about the new lines: which product, for a line that fits a few
   * and wasn't asked about yet, then how many, for a line that said no quantity.
   */
  private queueLineQuestions(): void {
    for (const { lineId, options } of this.added) {
      if (options.length > 0 && !this.draft.pending.some((p) => p.lineId === lineId)) {
        this.draft.pending.push({ code: "ambiguous_product", lineId, options });
      }
    }
    // Several lines with no quantity (a list from a photo): one question for all of them.
    const missing = this.added.filter((a) => a.quantity).map((a) => a.lineId);
    if (missing.length > 1) this.draft.pending.push({ code: "quantities", lineId: null, lines: missing });
    else if (missing.length === 1) this.draft.pending.push({ code: "quantity", lineId: missing[0]! });
    this.added.splice(0);
  }

  /** Issues about a line are asked one at a time; the line index is into the observation's lines. */
  private queueIssues(observation: Observation, count: number): void {
    const lines = this.stored!.order.lines;
    const first = lines.length - count;
    for (const issue of observation.issues) {
      if (issue.code === "embedded_instructions") continue;
      const line = issue.line === null ? undefined : lines[first + issue.line];
      const lineId = line?.lineId ?? null;
      // Perception's question, with the products that fit the line to pick from when a few do.
      const unclear = issue.code === "ambiguous_size" || issue.code === "ambiguous_product";
      const fit = this.added.find((a) => a.lineId === lineId)?.options;
      const found = !unclear || lineId === null ? [] : fit !== undefined && fit.length > 0 ? fit : searchCatalog(this.draft.names.get(lineId) ?? "", this.catalog).map((p) => p.productId);
      const options = found.length > 1 && found.length <= MAX_OPTIONS ? found : undefined;
      this.draft.pending.push(options === undefined ? { code: issue.code, lineId } : { code: issue.code, lineId, options });
    }
  }

  /**
   * An answer to the question asked last. A quantity is read from the answer ("dos", "3"). For a
   * line's size or product: the option's number or words among the options offered ("2", "el
   * clover de litro"), then "<line words> <answer>" as a product name, alias or words that fit one
   * product only; otherwise the line stays unmatched and its price unknown. Either way the question
   * is settled: it is never asked twice.
   */
  private settleQuestion(answer: string, pick: string | null = null, saidQuantity: string | null = null): void {
    if (this.stored !== null) this.dropSettledQuestions(this.stored.order);
    const pending = this.draft.pending.shift();
    if (pending === undefined || this.stored === null) return;
    this.changed = true;
    if (pending.code === "quantities") {
      this.settleQuantities(pending, answer);
      return;
    }
    if (pending.lineId === null) return;
    if (pending.code === "quantity") {
      // Perception's reading first; then code's, leaving out numbers that are the product's own name.
      const line = this.stored.order.lines.find((l) => l.lineId === pending.lineId);
      const quantity = saidQuantity ?? quantityFrom(withoutNameNumbers(answer, line?.productName ?? null));
      if (quantity !== null) {
        this.setLines(this.stored.order.lines.map((line) => (line.lineId === pending.lineId ? { ...line, quantity } : line)));
      } else if (pending.again !== true) {
        // No quantity in the answer: asked once more, then never again (absent is never one).
        this.draft.pending.unshift({ ...pending, again: true });
      }
      return;
    }
    const product = this.productForAnswer(pending, answer, pick);
    this.setLines(
      this.stored.order.lines.map((line) =>
        line.lineId !== pending.lineId || product === null
          ? line
          : {
              ...line,
              productId: product.productId,
              productName: product.names[0] ?? null,
              unitPrice: line.restricted ? null : product.price,
              availability: soldOutOrUnknown(product),
            },
      ),
    );
  }

  /**
   * "6 plátanos, 1 piña y una sandía" answering the question about several quantities, read by
   * code when perception gave it as one answer (it usually sets them line by line). Each part is
   * matched to one waiting line by its words; what doesn't match stays waiting, and the question
   * stays for the rest (at most MAX_QUANTITIES_ASKS times).
   */
  private settleQuantities(pending: PendingQuestion, answer: string): void {
    const waiting = (pending.lines ?? []).flatMap((id) => this.stored!.order.lines.filter((l) => l.lineId === id && l.quantity === null));
    const asLines = waiting.map((l) => ({ productId: l.lineId, names: [l.productName ?? l.text], aliases: [this.draft.names.get(l.lineId) ?? l.text] }));
    const set = new Map<string, string>();
    for (const part of answer.split(/,|;|\n|\s+y\s+/u)) {
      const found = searchCatalog(part.replace(/\d+(?:[.,]\d+)?/gu, " "), asLines);
      const line = found.length === 1 ? waiting.find((l) => l.lineId === found[0]!.productId) : undefined;
      const quantity = line === undefined ? null : quantityFrom(withoutNameNumbers(part, line.productName));
      if (line !== undefined && quantity !== null && !set.has(line.lineId)) set.set(line.lineId, quantity);
    }
    if (set.size > 0) {
      this.setLines(this.stored!.order.lines.map((l) => (set.has(l.lineId) ? { ...l, quantity: set.get(l.lineId)! } : l)));
    }
    const left = (pending.lines ?? []).filter((id) => !set.has(id));
    if (left.length > 0) this.draft.pending.unshift({ ...pending, lines: left });
  }

  /** The product an answer about an unclear line points at, or null when it isn't clear. */
  private productForAnswer(pending: PendingQuestion, answer: string, pick: string | null): PretendProduct | null {
    const options = (pending.options ?? []).flatMap((id) => this.catalog.filter((p) => p.productId === id));
    // Perception's pick among the labels offered ("O3"), then code's own reading of the words.
    const picked = pick === null ? null : /^O([1-9])$/u.exec(pick);
    if (picked !== null && options[Number(picked[1]) - 1] !== undefined) return options[Number(picked[1]) - 1]!;
    const n = optionNumber(answer);
    if (n !== null && options[n - 1] !== undefined) return options[n - 1]!;
    if (options.length > 0) {
      const among = searchCatalog(answer, options);
      if (among.length === 1) return among[0]!;
      // "Mazola porfavor", "la de clover grande": a word said that only one option holds picks it.
      const byWord = productWords(answer).map((word) => searchCatalog(word, options));
      const singled = [...new Set(byWord.filter((found) => found.length === 1).map((found) => found[0]!))];
      if (singled.length === 1) return singled[0]!;
    }
    const lineWords = `${this.draft.names.get(pending.lineId ?? "") ?? ""} ${answer}`;
    const said = normalize(lineWords);
    const exact = this.catalog.filter((p) => [...p.names, ...p.aliases].some((name) => normalize(name) === said));
    if (exact.length === 1) return exact[0]!;
    const fitting = searchCatalog(lineWords, this.catalog);
    return fitting.length === 1 ? fitting[0]! : null;
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
      code: String(this.state.counter.next++),
    };
  }

  private setLines(lines: readonly OrderLineView[], order: OrderView = this.stored!.order): void {
    this.setOrder({ ...order, lines });
  }

  private setOrder(order: OrderView): void {
    // Planner path: lines in pounds say so (readback "2 libras de Pollo entero").
    if (this.planning) order = { ...order, lines: order.lines.map((line) => this.withWeight(line)) };
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
    availability: product === null ? "no_se" : soldOutOrUnknown(product),
    restricted: line.restrictedCategory,
    mark: null,
    substitute: null,
  };
}

/**
 * A line's availability from its product: "se_acabo" when the store says it's out, so the readback
 * says so; otherwise "no_se". "hay" isn't copied onto a line: the readback claims nothing about it.
 */
function soldOutOrUnknown(product: PretendProduct): OrderLineView["availability"] {
  return product.availability === "se_acabo" ? "se_acabo" : "no_se";
}

/** A quantity the customer said: any assumed mark goes. */
function withQuantity(line: OrderLineView, quantity: DecimalString): OrderLineView {
  if (line.quantitySource === undefined) return { ...line, quantity };
  const { quantitySource: _assumed, ...said } = line;
  return { ...said, quantity };
}

/** Confirmar makes an assumed quantity the agreed one (D-46). */
function agreed(order: OrderView): OrderView {
  if (!order.lines.some((line) => line.quantitySource !== undefined)) return order;
  return { ...order, lines: order.lines.map(({ quantitySource: _assumed, ...line }) => line) };
}

/** The ask kind as the question code perception and the never-silent fallback know. */
function questionCodeOf(kind: Exclude<AskKind, "none">, lines: number): QuestionCode {
  switch (kind) {
    case "quantities":
      return lines === 1 ? "quantity" : "quantities";
    case "options":
      return "ambiguous_product";
    case "unreadable":
      return "illegible";
    case "fulfillment":
      return "pickup_or_delivery";
    case "delivery_place":
      return "delivery_place";
    case "what_to_order":
      return "what_to_order";
  }
}

/** Sold by weight, or a weight said for a product the store doesn't sell by unit. */
function weighed(unit: string | null, product: PretendProduct | undefined): boolean {
  return product?.soldBy === "weight" || (isWeightUnit(unit) && product?.soldBy !== "unit");
}

/** "el paquete de 10" asked about "Tortillas paquete 10": the 10 is the product, not the quantity. */
function withoutNameNumbers(answer: string, productName: string | null): string {
  const numbers = new Set((productName ?? "").match(/\d+(?:[.,]\d+)?/gu) ?? []);
  return numbers.size === 0 ? answer : answer.replace(/\d+(?:[.,]\d+)?/gu, (n) => (numbers.has(n) ? " " : n));
}

/** Same mode, and for a delivery the same place: setting it again changes nothing. */
function sameFulfillment(a: OrderView["fulfillment"], b: NonNullable<OrderView["fulfillment"]>): boolean {
  if (a === null || a.mode !== b.mode) return false;
  if (a.mode === "pickup" || b.mode === "pickup") return true;
  return a.placeId === b.placeId && a.placeText === b.placeText && a.fee === b.fee && JSON.stringify(a.pin ?? null) === JSON.stringify(b.pin ?? null);
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
      const next: OrderView = { ...agreed(order), state: "confirmado" };
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
      const marked: OrderView = {
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
      // A line marked "No hay" leaves the total; the customer's notice says the new one.
      const next: OrderView = { ...marked, total: orderSubtotal(marked) };
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
