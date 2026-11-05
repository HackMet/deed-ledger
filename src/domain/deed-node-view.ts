/**
 * What one fact of an order means to a person reading the Deed en vivo graph: what happened, who said it,
 * who backed it, and the state that follows. Pure; no I/O and no markup. A fact with no real confirmation is
 * never "hecho": nothing here invents an agent or a confirmation that the record doesn't hold.
 */
import type { DeedStatus } from "./deed-graph";

export type NodeState = "en_duda" | "hecho" | "cerrado" | "bloqueado";

/** Who backed a fact, read from its evidence. */
export type Confirmer = "tienda" | "cliente" | "whatsapp";

/** The parts of a recorded fact this view reads. `detail` is the order's words for it, when the record has any. */
export interface FactForView {
  readonly factId: string;
  readonly kind: "order_version" | "order_confirm" | "order_cancel" | "order_status" | "change_request" | "change_review";
  readonly recordedAtMs: number;
  readonly agentId: string | null;
  readonly evidence: readonly { readonly kind: string; readonly refId: string }[];
  readonly detail: string | null;
  readonly closedByReason: "cancelled" | "superseded" | null;
}

export interface DeedNodeView {
  readonly factId: string;
  readonly state: NodeState;
  /** In Honduran Spanish, e.g. "Pedido · 2 lb azúcar", "Cambio → 3 lb", "Cancelado por la tienda". */
  readonly title: string;
  /** The agent that made the claim; null when the record names none, and then the view draws no agent leg. */
  readonly agentId: string | null;
  /** Null when no evidence confirms it: the view draws the leg dotted, "esperando confirmación". */
  readonly confirmedBy: Confirmer | null;
  readonly recordedAtMs: number;
  /** For the tooltip: each evidence's kind, as recorded. */
  readonly evidenceKinds: readonly string[];
}

/** Evidence kinds the ledger really records: member, inbound_message, media_asset (and "confirmation", which confirms nothing here). */
function confirmerOf(evidence: FactForView["evidence"]): Confirmer | null {
  if (evidence.some((e) => e.kind === "member")) return "tienda";
  if (evidence.some((e) => e.kind === "inbound_message" || e.kind === "media_asset")) return "cliente";
  return null;
}

function titleOf(fact: FactForView, confirmedBy: Confirmer | null): string {
  const detail = fact.detail !== null && fact.detail.trim() !== "" ? fact.detail.trim() : null;
  switch (fact.kind) {
    case "order_version":
      return detail === null ? "Pedido" : `Pedido · ${detail}`;
    case "order_confirm":
      return confirmedBy === "cliente" ? "Confirmado por el cliente" : confirmedBy === "tienda" ? "Confirmado por la tienda" : "Confirmado";
    case "order_cancel":
      return confirmedBy === "tienda" ? "Cancelado por la tienda" : confirmedBy === "cliente" ? "Cancelado por el cliente" : "Cancelado";
    case "order_status":
      return detail ?? "Cambio de estado";
    case "change_request":
      return detail === null ? "Cambio pedido" : `Cambio → ${detail}`;
    case "change_review": {
      const d = detail?.toLowerCase() ?? "";
      return d.includes("aprob") ? "Cambio aprobado" : d.includes("rechaz") ? "Cambio rechazado" : "Cambio revisado";
    }
  }
}

function stateOf(status: DeedStatus | undefined, confirmedBy: Confirmer | null): NodeState {
  if (status === "closed") return "cerrado";
  if (status === "blocked") return "bloqueado";
  if (status === "live" && confirmedBy !== null) return "hecho";
  return "en_duda";
}

export function nodeViews(facts: readonly FactForView[], statuses: ReadonlyMap<string, DeedStatus>): DeedNodeView[] {
  return facts.map((fact) => {
    const confirmedBy = confirmerOf(fact.evidence);
    return {
      factId: fact.factId,
      state: stateOf(statuses.get(fact.factId), confirmedBy),
      title: titleOf(fact, confirmedBy),
      agentId: fact.agentId,
      confirmedBy,
      recordedAtMs: fact.recordedAtMs,
      evidenceKinds: fact.evidence.map((e) => e.kind),
    };
  });
}
