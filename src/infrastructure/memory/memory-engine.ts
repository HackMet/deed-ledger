/**
 * A pretend engine kept in memory, so the console and the replies can be built and tried before
 * the real engine lands. It follows the contract's rules for the preparation list (versions,
 * operation keys, roles) but saves straight into memory instead of returning commits, and forgets
 * everything when the Worker restarts. Only wired in when the console runs in dev mode.
 *
 * Marking lines doesn't change an order's version: the version is the content the customer agreed
 * to, and only the customer's changes make a new one.
 */
import type { CustomerContext, Engine, EngineResult, MemberContext } from "../../application/engine";
import type { Tenant } from "../../application/ports";
import { type ActionEnvelope, type ConsoleAction, type CustomerAction, OWNER_ACTIONS } from "../../domain/contract/actions";
import type { Claim, CustomerNotice, EngineOutcome, OrderView, PreparationCard } from "../../domain/contract/outcomes";

export interface StoredOrder {
  readonly customerId: string;
  readonly customerName: string | null;
  readonly confirmedAtMs: number;
  readonly changedLineIds: readonly string[];
  readonly order: OrderView;
}

interface StoreState {
  readonly orders: Map<string, StoredOrder>;
  /** Operation key -> the first outcome saved under it. */
  readonly operations: Map<string, EngineOutcome>;
}

const ON_THE_LIST: readonly OrderView["state"][] = ["confirmado", "preparando", "listo"];
const PACKING: readonly OrderView["state"][] = ["confirmado", "preparando"];

export class MemoryEngine implements Engine {
  private readonly stores = new Map<string, StoreState>();

  /** `seed` fills a store with orders the first time it's used. */
  constructor(private readonly seed: (tenant: Tenant) => readonly StoredOrder[] = () => []) {}

  async onBurst(): Promise<EngineResult> {
    return result({ type: "nothing" });
  }

  async onCustomerAction(_context: CustomerContext, _action: ActionEnvelope<CustomerAction>): Promise<EngineResult> {
    return result({ type: "nothing" });
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
      state = { orders: new Map(this.seed(tenant).map((stored) => [stored.order.orderId, stored])), operations: new Map() };
      this.stores.set(tenant.businessId, state);
    }
    return state;
  }
}

function result(outcome: EngineOutcome): EngineResult {
  return { outcome, notices: [], commits: [] };
}

function allowed(context: MemberContext, action: ConsoleAction): boolean {
  if (action.type === "approve_fiado") return context.role === "owner" || context.canApproveFiado;
  return context.role === "owner" || !(OWNER_ACTIONS as readonly string[]).includes(action.type);
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
    case "dispatch":
      return null;
  }
}
