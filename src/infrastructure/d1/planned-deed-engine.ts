/**
 * The planner on the Deed engine (DEED_ENGINE=1 with CONVERSATION=planner). Two halves, one batch:
 *
 * - The conversation: what is said next while an order is put together. It is the same conversation
 *   code the planner path was tuned on (`MemoryEngine`, with its readiness gate and plan rules), run
 *   per customer on a snapshot kept in `planner_memory` (migration 0030): the question last shown and
 *   its numbered options, each line's words, the planner's picks, an order still being built.
 * - The ledger: `OrderEngine`, the only writer of orders. A version is written when the conversation
 *   reads an order back (`onDecidedChange`), a confirmation when it confirms, a cancel when it cancels;
 *   the ledger's outcome is what the customer hears. Staff taps, the claim check of orders and the
 *   preparation list are the ledger's alone.
 *
 * Before every call the conversation is put back in step with the ledger: the ledger's open order
 * wins (its state, version, lines), except while the conversation is building a change on top of the
 * version it last saw. An order the ledger closed (cancelled, delivered) is forgotten.
 *
 * Every read and write is scoped to the store and customer of the context the caller built from the
 * lease. The planner's product picks reach the ledger only as product IDs of this store, checked by
 * `OrderEngine` again. The memory commit rides in the same batch as the ledger's, guarded by the
 * version it was read at: a race fails the batch loudly (`PlannerMemoryMovedError`) and saves nothing.
 *
 * Totals: the ledger's version total includes the delivery fee (`totalOf`); the conversation's and the
 * replies' `order.total` is the subtotal and the reply adds the fee. The views handed out here carry the
 * subtotal, and an order_total claim is checked against the ledger with the fee added back.
 */
import type { CustomerContext, Engine, EngineResult, LineMatch, MemberContext } from "../../application/engine";
import { actionKey, fromThousandths, type OrderEngine, type OrderStore, type StoredOrder as LedgerOrder } from "../../application/engine/order-engine";
import { toThousandths } from "../../domain/contract/numbers";
import { totalOf } from "../../domain/order-total";
import { labelOf } from "../../domain/orders";
import type { OrderReadingSource } from "../../application/order-reading";
import type { CatalogProduct } from "../../application/perception/matching";
import type { PlannerContext, PlannerSource } from "../../application/planner/source";
import type { Commit, Tenant } from "../../application/ports";
import type { ActionEnvelope, ConsoleAction, CustomerAction } from "../../domain/contract/actions";
import type { BurstReading, PerceptionContext } from "../../domain/contract/observation";
import type { Claim, EngineOutcome, OrderLineView, OrderView, PreparationCard } from "../../domain/contract/outcomes";
import type { TurnPlan } from "../../domain/planner/types";
import { MemoryEngine, type PretendStoreSnapshot, type StoredOrder as TalkOrder } from "../memory/memory-engine";
import { type D1PretendEngineOptions, pretendProduct, type StoreSetupSource } from "../memory/d1-pretend-engine";

/** The planner's memory moved on since it was read: the batch saved nothing; run it again. */
export class PlannerMemoryMovedError extends Error {
  constructor() {
    super("planner memory changed since it was read");
    this.name = "PlannerMemoryMovedError";
  }
}

/** What `planner_memory.state_json` holds for one customer. */
interface Memory {
  /** The conversation's state, this customer's only. */
  readonly snapshot: PretendStoreSnapshot;
  /** The ledger version the open order was last in step with; null for a draft the ledger hasn't seen. */
  readonly ledger: { readonly orderId: string; readonly version: number } | null;
}

interface Loaded {
  readonly engine: MemoryEngine;
  readonly memory: Memory;
  /** The stored row's version, or null when the customer has none yet. */
  readonly version: number | null;
  /** The stored JSON as read, to tell whether anything changed. */
  readonly json: string;
  /** The ledger's open order for the customer, as read now. */
  readonly ledgerOpen: LedgerOrder | null;
}

const OPEN: readonly OrderView["state"][] = ["armando", "por_confirmar", "confirmado", "preparando", "listo", "en_camino"];

/** The ledger states a change can still be made on (OrderEngine: EDITABLE). */
const EDITABLE: readonly OrderView["state"][] = ["por_confirmar", "confirmado", "preparando"];

const EMPTY: PretendStoreSnapshot = { orders: [], operations: [], drafts: [], lastQuestion: [] };

export interface PlannedDeedEngineDeps {
  readonly db: D1Database;
  readonly ledger: OrderEngine;
  /** The order engine's store, with this store's Tienda products resolved (`SetupCatalogOrderStore`). */
  readonly store: OrderStore;
  /** The store's products, hours and fee; tests pass a static catalog instead. */
  readonly setup?: StoreSetupSource;
  readonly options?: Omit<D1PretendEngineOptions, "setup">;
}

export class PlannedDeedEngine implements Engine, OrderReadingSource, PlannerSource {
  constructor(private readonly deps: PlannedDeedEngineDeps) {}

  async onBurst(context: CustomerContext, reading: BurstReading, matches: readonly LineMatch[], plan?: TurnPlan): Promise<EngineResult> {
    return this.converse(context, `burst:${context.jobId}`, (engine) => engine.onBurst(context, reading, matches, plan));
  }

  async onCustomerAction(context: CustomerContext, envelope: ActionEnvelope<CustomerAction>): Promise<EngineResult> {
    const { action } = envelope;
    // A removal or a cancel on a saved order is the ledger's own action, under the key the ledger derives;
    // the conversation catches up from the ledger on the next message.
    if (action.type === "remove_line" || action.type === "cancel_order") {
      const saved = await this.deps.store.customerOrder(context, context.customerId, action.orderId);
      if (saved !== null) return fromLedgerResult(await this.deps.ledger.onCustomerAction(context, envelope), null);
    }
    return this.converse(context, envelope.operationKey, (engine) => engine.onCustomerAction(context, envelope));
  }

  async onConsoleAction(context: MemberContext, envelope: ActionEnvelope<ConsoleAction>): Promise<EngineResult> {
    return fromLedgerResult(await this.deps.ledger.onConsoleAction(context, envelope), null);
  }

  /**
   * Orders: the ledger, with the fee added back to a claimed subtotal; an order still being built (not
   * in the ledger yet, or a change on top of the version it holds) by the conversation that holds it.
   * A unit price: the ledger's live confirmed price fact, the only price the planner path quotes. Stock
   * marks and hours: the store's own setup, where the planner path reads them.
   */
  async verifyClaims(tenant: Tenant, claims: readonly Claim[]): Promise<readonly boolean[]> {
    const options = await this.storeOptions(tenant);
    const setupCheck = new MemoryEngine(() => [], options);
    return Promise.all(
      claims.map(async (claim) => {
        if (typeof claim !== "object" || claim === null) return false;
        if (claim.type === "unit_price") return (await this.deps.ledger.verifyClaims(tenant, [claim]))[0] === true;
        if (claim.type !== "order_state" && claim.type !== "order_total") return (await setupCheck.verifyClaims(tenant, [claim]))[0] === true;
        if (typeof claim.orderId !== "string") return false;
        const saved = await this.deps.store.order(tenant, claim.orderId);
        if (saved !== null) {
          const fee = feeOf(saved.view);
          const asLedger: Claim = claim.type === "order_total" && claim.total !== null && fee !== null ? { ...claim, total: claim.total + fee } : claim;
          if ((await this.deps.ledger.verifyClaims(tenant, [asLedger]))[0] === true) return true;
        }
        return this.draftBacks(tenant, claim, saved !== null);
      }),
    );
  }

  async preparationList(tenant: Tenant): Promise<readonly PreparationCard[]> {
    const cards = await this.deps.ledger.preparationList(tenant);
    // Staff charge what the ledger recorded, the delivery fee included; only customer replies carry the
    // subtotal their copy adds the fee to.
    return cards.map((card) => ({ ...card, order: { ...fromLedger(card.order, null), total: card.order.total } }));
  }

  /**
   * The open order while stock's question waits on it, as the stock has it now (the ledger's read), so a
   * silent turn says that question again, as on the classic path. Null otherwise.
   */
  async shortOrder(context: CustomerContext): Promise<OrderView | null> {
    const [order, loaded] = await Promise.all([this.deps.ledger.shortOrder(context), this.load(context)]);
    return order === null ? null : fromLedger(order, openOf(loaded.memory.snapshot, context.customerId)?.order ?? null);
  }

  async perceptionContext(context: CustomerContext): Promise<PerceptionContext> {
    return (await this.load(context)).engine.perceptionContext(context);
  }

  async plannerContext(context: CustomerContext): Promise<PlannerContext> {
    return (await this.load(context)).engine.plannerContext(context);
  }

  async catalog(tenant: Tenant): Promise<readonly CatalogProduct[]> {
    return (await this.storeOptions(tenant)).catalog ?? [];
  }

  /**
   * One conversation step: the conversation decides, then the ledger saves what it decided, and the
   * ledger's outcome is said. `key` is the conversation's operation key for this step: a replay of a
   * step already saved says what it said then and touches nothing.
   */
  private async converse(context: CustomerContext, key: string, run: (engine: MemoryEngine) => Promise<EngineResult>): Promise<EngineResult> {
    const loaded = await this.load(context);
    const scopedKey = `customer:${context.customerId}:${key}`;
    // The conversation keeps the outcome said under each step's key (`rememberOutcome`): a replay gets it back.
    if (loaded.memory.snapshot.operations.some(([saved]) => saved === scopedKey)) return run(loaded.engine);
    const talk = await run(loaded.engine);
    let snapshot = loaded.engine.exportStore(context);
    let ledgerRef = loaded.memory.ledger;
    const talkOrder = orderOf(talk.outcome);
    let said: EngineResult;
    const step = await this.ledgerStep(context, talk.outcome, loaded);
    if (step === null) {
      const saved = loaded.ledgerOpen?.view ?? null;
      // The readback again, of exactly what the ledger holds: said as the ledger holds it (its version).
      const again = (talk.outcome.type === "readback" || talk.outcome.type === "order_changed") && saved !== null && saved.orderId === talk.outcome.order.orderId;
      // Said again as the ledger shows it now: a line stock can't cover still says what's left (asStockedNow).
      const short = again ? await this.deps.ledger.shortOrder(context) : null;
      const shown = saved !== null && short !== null && short.orderId === saved.orderId && short.version === saved.version ? short : saved;
      said = { ...talk, outcome: again ? { ...talk.outcome, order: fromLedger(shown!, talkOrder) } as EngineOutcome : fromTalkOutcome(talk.outcome, saved) };
    } else {
      const ledgerSaid = fromLedgerResult(step.result, talkOrder);
      said = { ...ledgerSaid, notices: [...talk.notices, ...ledgerSaid.notices], ...answeredOf(talk) };
      // Refused or a replay in the ledger: nothing is saved, and the conversation catches up from it next time.
      if (step.result.commits.length === 0) return said;
      const synced = syncToLedger(snapshot, context.customerId, talk.outcome, step.result.outcome);
      snapshot = synced.snapshot;
      ledgerRef = synced.ledger;
    }
    // A burst's outcome, or what the ledger said, is kept under the step's key; a tap the conversation only
    // answered (the name asked for a held Confirmar) is answered again, as the conversation does.
    const remembered = key.startsWith("burst:") || step !== null ? rememberOutcome(snapshot, scopedKey, said.outcome) : snapshot;
    const memory: Memory = { snapshot: remembered, ledger: ledgerRef };
    const json = JSON.stringify(memory);
    if (json === loaded.json) return said;
    // The order the conversation is about: the open one, or the last it closed (a draft cancelled before
    // any readback is backed by this memory alone).
    const aboutId = openOf(memory.snapshot, context.customerId)?.order.orderId ?? memory.snapshot.orders.at(-1)?.[0] ?? null;
    return { ...said, commits: [...said.commits, this.saveCommit(context, loaded.version, aboutId, json)] };
  }

  /**
   * What the ledger must save for what the conversation decided; null when nothing. A readback writes
   * the version read back (unless the ledger holds exactly that already); a confirmation confirms the
   * ledger's version under the key the button carries; a cancel cancels it.
   */
  private async ledgerStep(context: CustomerContext, outcome: EngineOutcome, loaded: Loaded): Promise<{ result: EngineResult } | null> {
    const { ledger } = this.deps;
    const saved = loaded.ledgerOpen;
    const customer = { type: "customer" as const, customerId: context.customerId };
    switch (outcome.type) {
      case "readback":
      case "order_changed": {
        if (saved !== null && saved.view.orderId === outcome.order.orderId && saved.view.state === "por_confirmar" && sameContent(saved.view, outcome.order)) {
          return null;
        }
        return { result: await ledger.onDecidedChange(context, outcome.order.lines, asLedgerKeeps(outcome.order.fulfillment)) };
      }
      case "order_confirmed": {
        // The ledger holds no such open order: never "confirmado" from the conversation alone, nothing saved.
        if (saved === null || saved.view.orderId !== outcome.order.orderId) {
          return { result: { outcome: { type: "rejected", reason: "not_found", order: saved?.view ?? null }, notices: [], commits: [] } };
        }
        const action = { type: "confirm_order" as const, orderId: saved.view.orderId, version: saved.view.version };
        return { result: await ledger.onCustomerAction(context, { operationKey: actionKey(action), actor: customer, action }) };
      }
      case "order_cancelled": {
        if (saved === null || saved.view.orderId !== outcome.order.orderId) return null;
        const action = { type: "cancel_order" as const, orderId: saved.view.orderId, version: saved.view.version };
        return { result: await ledger.onCustomerAction(context, { operationKey: actionKey(action), actor: customer, action }) };
      }
      default:
        return null;
    }
  }

  /**
   * An order claim the ledger doesn't back: the conversation answers only for what it alone holds. An
   * order being put together (armando); for one the ledger never saw, also its cancel before any readback.
   */
  private async draftBacks(tenant: Tenant, claim: Extract<Claim, { type: "order_state" | "order_total" }>, inLedger: boolean): Promise<boolean> {
    const row = await this.deps.db
      .prepare(`SELECT customer_id FROM planner_memory WHERE business_id = ? AND order_id = ?`)
      .bind(tenant.businessId, claim.orderId)
      .first<{ customer_id: string }>();
    if (row === null) return false;
    const loaded = await this.load({ businessId: tenant.businessId, customerId: row.customer_id });
    const draft = loaded.memory.snapshot.orders.find(([id, stored]) => id === claim.orderId && stored.customerId === row.customer_id)?.[1].order;
    if (draft === undefined || draft.version !== claim.version) return false;
    if (draft.state !== "armando" && (inLedger || draft.state !== "cancelado")) return false;
    return claim.type === "order_state" ? claim.state === draft.state : claim.total === draft.total;
  }

  /**
   * The store's products, hours and fee for the conversation. A product's price is its live confirmed
   * price fact, as the ledger prices a line (Angel, Nov 4): a legacy Tienda price with no fact
   * (`store_products.price_centavos`) is unknown, so it is never quoted, read back or totalled.
   */
  private async storeOptions(tenant: Tenant): Promise<Omit<D1PretendEngineOptions, "setup">> {
    const [base, confirmed] = await Promise.all([this.setupOptions(tenant), this.confirmedPrices(tenant)]);
    if (base.catalog === undefined) return base;
    return {
      ...base,
      catalog: base.catalog.map((product) => ({ ...product, price: product.restricted === true ? null : (confirmed.get(product.productId) ?? null) })),
    };
  }

  private async setupOptions(tenant: Tenant): Promise<Omit<D1PretendEngineOptions, "setup">> {
    if (this.deps.setup === undefined) return this.deps.options ?? {};
    const setup = await this.deps.setup.read(tenant);
    return { catalog: setup.products.map(pretendProduct), storeHours: setup.hours, deliveryFee: setup.deliveryFee };
  }

  /**
   * Every product's live confirmed price in this store, in one read: the newest confirmed price fact with
   * no closure, the rule of `D1OrderStore.priceState` and `liveConfirmedPriceSql`. A proposal backs nothing.
   */
  private async confirmedPrices(tenant: Tenant): Promise<ReadonlyMap<string, number>> {
    const { results } = await this.deps.db
      .prepare(
        `SELECT json_extract(f.body_json, '$.productId') AS product_id, json_extract(f.body_json, '$.price') AS price
         FROM facts f
         WHERE f.business_id = ? AND f.kind = 'price' AND json_extract(f.body_json, '$.status') = 'confirmed'
           AND NOT EXISTS (SELECT 1 FROM fact_closures c WHERE c.business_id = f.business_id AND c.fact_id = f.id)
         ORDER BY f.rowid DESC`,
      )
      .bind(tenant.businessId)
      .all<{ product_id: unknown; price: unknown }>();
    const prices = new Map<string, number>();
    for (const row of results) {
      if (typeof row.product_id !== "string" || prices.has(row.product_id)) continue;
      if (typeof row.price === "number" && Number.isSafeInteger(row.price) && row.price >= 0) prices.set(row.product_id, row.price);
    }
    return prices;
  }

  /** The customer's memory, put back in step with the ledger, in a conversation engine ready to run. */
  private async load(context: Tenant & { readonly customerId: string }): Promise<Loaded> {
    const [row, options, ledgerOpen] = await Promise.all([
      this.deps.db
        .prepare(`SELECT version, state_json FROM planner_memory WHERE business_id = ? AND customer_id = ?`)
        .bind(context.businessId, context.customerId)
        .first<{ version: number; state_json: string }>(),
      this.storeOptions(context),
      this.deps.store.openOrder(context, context.customerId),
    ]);
    const stored: Memory = row === null ? { snapshot: EMPTY, ledger: null } : (JSON.parse(row.state_json) as Memory);
    const memory = reconcile(stored, context.customerId, ledgerOpen);
    const engine = new MemoryEngine(() => [], options);
    engine.importStore(context, memory.snapshot);
    return { engine, memory, version: row?.version ?? null, json: row === null ? "" : JSON.stringify(stored), ledgerOpen };
  }

  /** Writes the memory only while the version it was read at is still the stored one. */
  private saveCommit(context: CustomerContext, version: number | null, orderId: string | null, json: string): Commit {
    const { db } = this.deps;
    const error = () => new PlannerMemoryMovedError();
    if (version === null) {
      return {
        guards: [
          {
            holdsSql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM planner_memory WHERE business_id = ? AND customer_id = ?)`,
            params: [context.businessId, context.customerId],
            error,
          },
        ],
        statements: [
          db
            .prepare(
              `INSERT INTO planner_memory (business_id, customer_id, order_id, version, state_json, updated_at_ms) VALUES (?, ?, ?, 1, ?, ?)`,
            )
            .bind(context.businessId, context.customerId, orderId, json, context.nowMs),
        ],
      };
    }
    return {
      guards: [
        {
          holdsSql: `SELECT 1 FROM planner_memory WHERE business_id = ? AND customer_id = ? AND version = ?`,
          params: [context.businessId, context.customerId, version],
          error,
        },
      ],
      statements: [
        db
          .prepare(
            `UPDATE planner_memory SET version = version + 1, order_id = ?, state_json = ?, updated_at_ms = ?
             WHERE business_id = ? AND customer_id = ? AND version = ?`,
          )
          .bind(orderId, json, context.nowMs, context.businessId, context.customerId, version),
      ],
    };
  }
}

/**
 * The order engine's store, with this store's Tienda products (`store_products`) resolving as products
 * too: the planner path matches against them, so a line it picked names a product of this store. Order
 * views get the product's name when the `products` table has none for it.
 */
export class SetupCatalogOrderStore implements OrderStore {
  constructor(
    private readonly inner: OrderStore,
    private readonly setup: StoreSetupSource,
  ) {}

  firstOutcome: OrderStore["firstOutcome"] = (tenant, key) => this.inner.firstOutcome(tenant, key);
  products: OrderStore["products"] = (tenant) => this.inner.products(tenant);
  orderHead: OrderStore["orderHead"] = (tenant, orderId) => this.inner.orderHead(tenant, orderId);
  courier: OrderStore["courier"] = (tenant, memberId) => this.inner.courier(tenant, memberId);
  changeRequest: OrderStore["changeRequest"] = (tenant, id) => this.inner.changeRequest(tenant, id);
  orderFacts: OrderStore["orderFacts"] = (tenant, orderId) => this.inner.orderFacts(tenant, orderId);
  customerNames: OrderStore["customerNames"] = (tenant, ids) => this.inner.customerNames(tenant, ids);
  changedLineIds: OrderStore["changedLineIds"] = (tenant, orderId, version) => this.inner.changedLineIds(tenant, orderId, version);
  queuePosition: OrderStore["queuePosition"] = (tenant, orderId, at) => this.inner.queuePosition(tenant, orderId, at);
  commitFor: OrderStore["commitFor"] = (tenant, write) => this.inner.commitFor(tenant, write);
  priceState: OrderStore["priceState"] = (tenant, productId, key) => this.inner.priceState(tenant, productId, key);
  noHayMarked: OrderStore["noHayMarked"] = (tenant, productId) => this.inner.noHayMarked(tenant, productId);

  async productNames(tenant: Tenant, productIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const found = new Map(await this.inner.productNames(tenant, productIds));
    if (productIds.every((id) => found.has(id))) return found;
    for (const product of (await this.setup.read(tenant)).products) {
      if (productIds.includes(product.productId) && !found.has(product.productId)) found.set(product.productId, product.name);
    }
    return found;
  }

  async openOrder(tenant: Tenant, customerId: string): Promise<LedgerOrder | null> {
    return this.named(tenant, await this.inner.openOrder(tenant, customerId));
  }

  async order(tenant: Tenant, orderId: string): Promise<LedgerOrder | null> {
    return this.named(tenant, await this.inner.order(tenant, orderId));
  }

  async customerOrder(tenant: Tenant, customerId: string, orderId: string): Promise<LedgerOrder | null> {
    return this.named(tenant, await this.inner.customerOrder(tenant, customerId, orderId));
  }

  async preparationOrders(tenant: Tenant): Promise<readonly LedgerOrder[]> {
    const orders = await this.inner.preparationOrders(tenant);
    return Promise.all(orders.map(async (order) => (await this.named(tenant, order))!));
  }

  private async named(tenant: Tenant, stored: LedgerOrder | null): Promise<LedgerOrder | null> {
    if (stored === null || stored.view.lines.every((line) => line.productId === null || line.productName !== null)) return stored;
    const names = new Map((await this.setup.read(tenant)).products.map((product) => [product.productId, product.name]));
    const lines = stored.view.lines.map((line) =>
      line.productId !== null && line.productName === null && names.has(line.productId) ? { ...line, productName: names.get(line.productId)! } : line,
    );
    return { ...stored, view: { ...stored.view, lines } };
  }
}

/** A delivery's fee when the ledger version carries one; null otherwise. */
function feeOf(order: OrderView): number | null {
  return order.fulfillment?.mode === "delivery" ? order.fulfillment.fee : null;
}

/** The ledger's total (fee included) as the replies' subtotal. */
function subtotalOf(order: OrderView): number | null {
  const fee = feeOf(order);
  return order.total === null || fee === null ? order.total : order.total - fee;
}

function openOf(snapshot: PretendStoreSnapshot, customerId: string | null): TalkOrder | null {
  for (const [, stored] of snapshot.orders) {
    if ((customerId === null || stored.customerId === customerId) && OPEN.includes(stored.order.state)) return stored;
  }
  return null;
}

/** A quantity as the ledger stores and reads it back ("2.50" is "2.5"); zero or unreadable is unknown. */
function canonical(quantity: string | null): string | null {
  const milli = quantity === null ? null : toThousandths(quantity);
  return milli === null || milli === 0 ? null : fromThousandths(milli);
}

/** A shared WhatsApp location in words, as the ledger keeps it (`order_versions` has no pin): staff can use it. */
export function pinPlaceText(pin: { readonly latitude: number; readonly longitude: number }): string {
  return `Ubicación compartida por WhatsApp: ${pin.latitude}, ${pin.longitude}`;
}

/**
 * How the ledger keeps a way of receiving the order: a delivery to a shared pin carries the pin in its
 * place text (after the words the customer wrote, when there are some), and no pin field.
 */
function asLedgerKeeps(fulfillment: OrderView["fulfillment"]): OrderView["fulfillment"] {
  if (fulfillment === null || fulfillment.mode !== "delivery") return fulfillment;
  const { pin, ...kept } = fulfillment;
  if (pin == null) return kept;
  const words = pinPlaceText(pin);
  return { ...kept, placeText: fulfillment.placeText === null ? words : `${fulfillment.placeText} · ${words}` };
}

/** Same lines (product, words, amount, unit, price) and the same way of receiving it. */
function sameContent(a: OrderView, b: OrderView): boolean {
  const lines = (order: OrderView) => order.lines.map((l) => [l.productId, l.text, canonical(l.quantity), l.unit, l.unitPrice, l.restricted]);
  // Compared as the ledger keeps it: a pin is its words.
  const how = (order: OrderView) => {
    const kept = asLedgerKeeps(order.fulfillment);
    return kept === null ? null : kept.mode === "pickup" ? ["pickup"] : ["delivery", kept.placeId, kept.placeText, kept.fee];
  };
  return JSON.stringify([lines(a), how(a)]) === JSON.stringify([lines(b), how(b)]);
}

/**
 * The conversation's order, in step with the ledger's. The ledger's open order wins, with the
 * conversation's line details (sold out, assumed amounts, pounds) kept where it holds the same
 * version; a change the conversation is building on top of the version it last saw is kept as it is.
 * An order the ledger closed is forgotten; a draft the ledger never saw is kept.
 */
function reconcile(memory: Memory, customerId: string, ledgerOpen: LedgerOrder | null): Memory {
  const { snapshot, ledger } = memory;
  const open = openOf(snapshot, customerId);
  if (ledgerOpen === null) {
    if (open === null || ledger === null || open.order.orderId !== ledger.orderId) return memory;
    return { snapshot: forget(snapshot, open.order.orderId), ledger: null };
  }
  const view = ledgerOpen.view;
  const sameVersion = open !== null && open.order.orderId === view.orderId && ledger?.orderId === view.orderId && ledger.version === view.version;
  // A change being built on the version it last saw, while the ledger still takes changes.
  if (sameVersion && open!.order.state === "armando" && EDITABLE.includes(view.state)) return memory;
  const mine = sameVersion ? open!.order : null;
  const order = fromLedger(conversationBase(ledgerOpen), mine);
  const stored: TalkOrder = {
    customerId,
    customerName: open?.customerName ?? null,
    confirmedAtMs: ledgerOpen.firstConfirmedAtMs ?? 0,
    changedLineIds: [],
    order,
  };
  const others = snapshot.orders.filter(([id, kept]) => id !== view.orderId && !(kept.customerId === customerId && OPEN.includes(kept.order.state)));
  const drafts = sameVersion || open?.order.orderId === view.orderId ? snapshot.drafts : snapshot.drafts.filter(([id]) => id !== view.orderId);
  return { snapshot: { ...snapshot, orders: [...others, [view.orderId, stored]], drafts }, ledger: { orderId: view.orderId, version: view.version } };
}

/**
 * What the conversation builds the customer's next change on: the change still waiting for the store
 * when there is one (K12), as `OrderEngine.decideBurst` does, else the version itself. The ledger's id,
 * version and state either way; what is said about the version itself comes from the ledger (`fromTalkOutcome`).
 */
function conversationBase(ledgerOpen: LedgerOrder): OrderView {
  const { view, openRequest } = ledgerOpen;
  if (openRequest === null) return view;
  const fee = openRequest.fulfillment === null ? null : openRequest.fulfillment.mode === "pickup" ? 0 : openRequest.fulfillment.fee;
  return { ...view, lines: openRequest.lines, fulfillment: openRequest.fulfillment, total: totalOf(openRequest.lines, fee).total };
}

function forget(snapshot: PretendStoreSnapshot, orderId: string): PretendStoreSnapshot {
  return {
    ...snapshot,
    orders: snapshot.orders.filter(([id]) => id !== orderId),
    drafts: snapshot.drafts.filter(([id]) => id !== orderId),
    held: (snapshot.held ?? []).filter(([, held]) => held.orderId !== orderId),
  };
}

/**
 * After the ledger saved: the conversation's order takes the ledger's ID, version and state, and its
 * lines the ledger's labels (L1…), so the next turn, the buttons and the planner all name the same lines.
 */
function syncToLedger(
  snapshot: PretendStoreSnapshot,
  customerId: string,
  talked: EngineOutcome,
  saved: EngineOutcome,
): { snapshot: PretendStoreSnapshot; ledger: Memory["ledger"] } {
  const talkOrder = "order" in talked ? talked.order : null;
  const ledgerOrder = "order" in saved ? saved.order : null;
  if (talkOrder === null || ledgerOrder === null) return { snapshot, ledger: null };
  if (saved.type === "order_cancelled") return { snapshot: forget(snapshot, talkOrder.orderId), ledger: null };
  const mine = snapshot.orders.find(([id]) => id === talkOrder.orderId)?.[1] ?? null;
  const wrote = saved.type === "readback" || saved.type === "order_changed";
  // A change after confirming saved as a request (K12): the version stays, and the next change builds on
  // what the customer asked for, as the ledger's own burst does (`conversationBase`).
  const requested = mine !== null && saved.type === "order_status" && ledgerOrder.openChangeRequest != null;
  // The conversation's lines in order, as the ledger labelled them (a request's lines are labelled the same way).
  const relabel = new Map<string, string>(
    wrote || requested ? (mine?.order.lines ?? []).map((line, n) => [line.lineId, wrote ? (ledgerOrder.lines[n]?.lineId ?? line.lineId) : labelOf(n)]) : [],
  );
  const order: OrderView = requested
    ? {
        ...fromLedger(ledgerOrder, null),
        lines: mine.order.lines.map((line, n) => ({ ...line, lineId: labelOf(n) })),
        fulfillment: mine.order.fulfillment,
        total: mine.order.total,
      }
    : fromLedger(ledgerOrder, mine?.order ?? null);
  const stored: TalkOrder = {
    customerId,
    customerName: mine?.customerName ?? null,
    confirmedAtMs: mine?.confirmedAtMs ?? 0,
    changedLineIds: [],
    order,
  };
  const orders = snapshot.orders.filter(([id]) => id !== talkOrder.orderId && id !== ledgerOrder.orderId);
  const drafts = snapshot.drafts.flatMap(([id, draft]): (typeof snapshot.drafts)[number][] => {
    if (id === ledgerOrder.orderId && id !== talkOrder.orderId) return [];
    if (id !== talkOrder.orderId) return [[id, draft]];
    return [[ledgerOrder.orderId, relabelDraft(draft, relabel)]];
  });
  const held = (snapshot.held ?? []).map(([who, kept]): [string, typeof kept] =>
    kept.orderId === talkOrder.orderId ? [who, { ...kept, orderId: ledgerOrder.orderId }] : [who, kept],
  );
  return {
    snapshot: { ...snapshot, orders: [...orders, [ledgerOrder.orderId, stored]], drafts, held },
    ledger: { orderId: ledgerOrder.orderId, version: ledgerOrder.version },
  };
}

type DraftOf = PretendStoreSnapshot["drafts"][number][1];

/** A draft's line references under the ledger's labels. Unmapped IDs stay as they are. */
function relabelDraft(draft: DraftOf, relabel: ReadonlyMap<string, string>): DraftOf {
  if (relabel.size === 0) return draft;
  const id = (lineId: string) => relabel.get(lineId) ?? lineId;
  const keys = <T>(record: Readonly<Record<string, T>> | undefined) =>
    record === undefined ? undefined : Object.fromEntries(Object.entries(record).map(([key, value]) => [id(key), value]));
  const planned = draft.planned;
  const last = planned?.last ?? null;
  return {
    ...draft,
    pending: draft.pending.map((p) => ({
      ...p,
      lineId: p.lineId === null ? null : id(p.lineId),
      ...(p.lines === undefined ? {} : { lines: p.lines.map(id) }),
    })),
    names: draft.names.map(([lineId, words]) => [id(lineId), words] as const),
    ...(planned === undefined
      ? {}
      : {
          planned: {
            ...planned,
            quantityAsks: keys(planned.quantityAsks) ?? {},
            ...(planned.picked === undefined ? {} : { picked: planned.picked.map(id) }),
            ...(planned.otherNames === undefined ? {} : { otherNames: keys(planned.otherNames)! }),
            ...(planned.whichAsks === undefined ? {} : { whichAsks: keys(planned.whichAsks)! }),
            last:
              last === null
                ? null
                : {
                    ...last,
                    lineIds: last.lineIds.map(id),
                    ...(last.options === undefined ? {} : { options: keys(last.options)! }),
                    ...(last.shown === undefined ? {} : { shown: last.shown.map((option) => ({ ...option, lineId: id(option.lineId) })) }),
                  },
          },
        }),
  } as DraftOf;
}

/** The outcome saved under the step's key, so a replay says the same thing the ledger said. */
function rememberOutcome(snapshot: PretendStoreSnapshot, key: string, outcome: EngineOutcome): PretendStoreSnapshot {
  const operations = [...snapshot.operations.filter(([saved]) => saved !== key), [key, outcome] as const];
  // The newest steps only: a retried job comes back within minutes, and the memory stays small.
  return { ...snapshot, operations: operations.slice(-KEPT_STEPS) };
}

/** How many steps' outcomes the memory keeps for replays. */
const KEPT_STEPS = 100;

function answeredOf(result: EngineResult): Pick<EngineResult, "answered"> {
  return result.answered == null ? {} : { answered: result.answered };
}

/** The order an outcome is about, if it names one. */
function orderOf(outcome: EngineOutcome): OrderView | null {
  return "order" in outcome ? outcome.order : null;
}

/**
 * A ledger view as the replies read it: the subtotal (the reply adds the fee), no order number, and the
 * conversation's line details (sold out, an assumed amount, pounds) where it holds the same lines.
 */
function fromLedger(order: OrderView, talk: OrderView | null): OrderView {
  const { code: _code, ...rest } = order;
  const same = talk !== null && talk.lines.length === order.lines.length;
  const lines = order.lines.map((line, n): OrderLineView => {
    const kept = same ? talk.lines[n] : undefined;
    if (kept === undefined || kept.productId !== line.productId) return line;
    return {
      ...line,
      // What the ledger says (its stock: hay, se_acabo) wins; an unknown takes the conversation's "No hay".
      availability: line.availability === "no_se" ? kept.availability : line.availability,
      ...(kept.quantitySource === undefined ? {} : { quantitySource: kept.quantitySource }),
      ...(kept.byWeight === undefined ? {} : { byWeight: kept.byWeight }),
    };
  });
  return { ...rest, lines, fulfillment: withPin(order.fulfillment, talk?.fulfillment ?? null), total: subtotalOf(order) };
}

/**
 * The ledger's place as the conversation said it: when the ledger's words are exactly the pin the
 * conversation holds, the replies get the pin back ("a tu ubicación"), with the ledger's fee and place.
 */
function withPin(ledger: OrderView["fulfillment"], talk: OrderView["fulfillment"]): OrderView["fulfillment"] {
  if (ledger === null || ledger.mode !== "delivery" || talk === null || talk.mode !== "delivery" || talk.pin == null) return ledger;
  const kept = asLedgerKeeps(talk);
  if (kept === null || kept.mode !== "delivery" || kept.placeText !== ledger.placeText) return ledger;
  return { ...ledger, placeText: talk.placeText, pin: talk.pin };
}

/** The conversation's view: the ledger's state, place in line and change request when it holds that version. */
function fromTalk(order: OrderView, ledger: OrderView | null): OrderView {
  const { code: _code, ...rest } = order;
  if (ledger === null || ledger.orderId !== order.orderId || ledger.version !== order.version) return rest;
  return {
    ...rest,
    state: ledger.state,
    queuePosition: ledger.queuePosition,
    ...(ledger.openChangeRequest === undefined ? {} : { openChangeRequest: ledger.openChangeRequest }),
    ...(ledger.lastReview === undefined ? {} : { lastReview: ledger.lastReview }),
  };
}

function mapOrder(outcome: EngineOutcome, map: (order: OrderView) => OrderView): EngineOutcome {
  if (outcome.type === "duplicate") return { ...outcome, first: mapOrder(outcome.first, map) };
  if (!("order" in outcome) || outcome.order === null) return outcome;
  return { ...outcome, order: map(outcome.order) } as EngineOutcome;
}

/**
 * While a change waits for the store (K12), the conversation holds what the customer asked for at the
 * ledger's version; what is said about that version (its status, its total) is the ledger's own. A
 * question keeps the conversation's lines, which it names.
 */
function fromTalkOutcome(outcome: EngineOutcome, ledger: OrderView | null): EngineOutcome {
  const waiting = (order: OrderView) =>
    outcome.type !== "ask" && ledger !== null && ledger.openChangeRequest != null && ledger.orderId === order.orderId && ledger.version === order.version;
  return mapOrder(outcome, (order) => (waiting(order) ? fromLedger(ledger!, null) : fromTalk(order, ledger)));
}

/** A ledger result as the replies read it, its notices' orders too. */
function fromLedgerResult(result: EngineResult, talk: OrderView | null): EngineResult {
  return {
    ...result,
    outcome: mapOrder(result.outcome, (order) => fromLedger(order, talk)),
    notices: result.notices.map((notice) =>
      "order" in notice.notice ? ({ ...notice, notice: { ...notice.notice, order: fromLedger(notice.notice.order, null) } } as typeof notice) : notice,
    ),
  };
}
