/**
 * An order's state, derived from its facts (R2): the ledger is the source and `orders.state` is the
 * cache this must agree with. Pure: the caller reads the facts and their liveness.
 */
import type { OrderState } from "./contract/outcomes";

/** One order fact as the derivation needs it. `live`: neither it nor an ancestor is closed. */
export interface OrderFact {
  readonly id: string;
  readonly kind: "order_version" | "order_confirm" | "order_cancel" | "order_status";
  readonly live: boolean;
  /** body.version: the order version the fact was decided on. */
  readonly version: number;
  readonly dependsOn: readonly string[];
  /** order_confirm only: where confirming put the order (D-38, D-43). */
  readonly resumeState: "confirmado" | "preparando" | null;
  /** order_status only, and only for a step (a line mark has none). */
  readonly status: "preparing" | "ready" | "delivered" | null;
}

/** Later steps win: a delivered order stays delivered whatever order the taps were recorded in. */
const STATUS_STATE = [
  ["delivered", "entregado"],
  ["ready", "listo"],
  ["preparing", "preparando"],
] as const;

/**
 * - `cancelado` when a live order_cancel exists;
 * - else, when the current version has a live confirm: the latest step among the live
 *   order_status facts resting on that confirm, or, with none, the confirm's resumeState. (After a
 *   change and a re-confirm, the status taps rested on the old confirm, which died with the old
 *   version: resumeState is what keeps preparando.)
 * - else `por_confirmar`, or `armando` when the cache says so (no fact records armando).
 */
export function deriveOrderState(facts: readonly OrderFact[], currentVersion: number, cached: OrderState): OrderState {
  const live = facts.filter((fact) => fact.live);
  if (live.some((fact) => fact.kind === "order_cancel")) return "cancelado";

  const versionFact = live.find((fact) => fact.kind === "order_version" && fact.version === currentVersion);
  const confirm = live.find(
    (fact) =>
      fact.kind === "order_confirm" &&
      fact.version === currentVersion &&
      (versionFact === undefined || fact.dependsOn.includes(versionFact.id)),
  );
  if (confirm !== undefined) {
    const steps = new Set(
      live.filter((fact) => fact.kind === "order_status" && fact.dependsOn.includes(confirm.id)).map((fact) => fact.status),
    );
    for (const [status, state] of STATUS_STATE) if (steps.has(status)) return state;
    return confirm.resumeState ?? "confirmado";
  }
  return cached === "armando" ? "armando" : "por_confirmar";
}
