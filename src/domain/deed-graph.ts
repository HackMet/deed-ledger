/**
 * The Deed's graph of one order's facts (K20): which facts are live, closed, blocked or pending, and a
 * layered layout to draw them. Pure: no I/O, no imports outside src/domain.
 *
 * The status follows the ledger's liveness rule (order-trail.ts `FACTS_SQL`, fact-ledger.ts
 * `KILLING_CLOSURE`): a closure kills a fact unless it is a supersede by one of the fact's own
 * ancestors, the fact itself included. A fact whose own closure kills it is `closed`; one whose
 * ancestor's closure kills it is `blocked`; a change request nobody has answered is `pending`; the rest
 * are `live`. `live` and `pending` are the ledger's live facts.
 *
 * The layout: a fact's layer is the longest path from a root through `dependsOn`, so every dependency
 * sits in a lower layer than what rests on it. Inside a layer, facts keep the order they were recorded
 * in (then their id), so the same facts always draw the same way.
 */

export type DeedStatus = "live" | "closed" | "blocked" | "pending";

export interface DeedClosure {
  readonly closedByFactId: string;
  readonly reason: "cancelled" | "superseded";
  /** When the closure was recorded: the replay shows it only from then on. Absent: always shown. */
  readonly atMs?: number;
}

export interface DeedFact {
  readonly id: string;
  readonly kind: string;
  readonly recordedAtMs: number;
  readonly dependsOn: readonly string[];
  readonly closure: DeedClosure | null;
}

/** A check the engine refused on this order (K20): drawn beside the fact that decided it, when it had one. */
export interface DeedRefusal {
  readonly id: string;
  readonly atMs: number;
  readonly reason: string;
  readonly decidingFactId: string | null;
}

export interface DeedRefusalNode extends DeedRefusal {
  /** Position within the refusals' row, which sits below the last layer. */
  readonly column: number;
}

export interface DeedNode {
  readonly id: string;
  readonly kind: string;
  readonly recordedAtMs: number;
  readonly status: DeedStatus;
  /** Rows from the top: 0 for a root. */
  readonly layer: number;
  /** Position within the layer, from the left. */
  readonly column: number;
}

/**
 * `depends`: `from` is a dependency of `to` (solid). `closes`: `from` closed `to` (red, dotted).
 * `refused`: the refused check `from` was decided by the fact `to` (grey, dashed).
 */
export interface DeedEdge {
  readonly from: string;
  readonly to: string;
  readonly type: "depends" | "closes" | "refused";
}

export interface DeedGraph {
  readonly nodes: readonly DeedNode[];
  readonly edges: readonly DeedEdge[];
  /** How many layers the graph has (0 for no facts). The refusals sit in the row after the last one. */
  readonly layers: number;
  readonly refusals: readonly DeedRefusalNode[];
}

/** The facts in recorded order, then by id: the one order every output follows. */
const inRecordedOrder = (facts: readonly DeedFact[]): DeedFact[] =>
  [...facts].sort((a, b) => a.recordedAtMs - b.recordedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** A fact and every fact it rests on, transitively, itself included. Dependencies outside `facts` are skipped. */
function ancestorsOf(id: string, byId: ReadonlyMap<string, DeedFact>, memo: Map<string, ReadonlySet<string>>): ReadonlySet<string> {
  const known = memo.get(id);
  if (known !== undefined) return known;
  const found = new Set<string>([id]);
  // Marked before recursing, so a malformed cycle ends instead of looping.
  memo.set(id, found);
  for (const dependency of byId.get(id)?.dependsOn ?? []) {
    if (byId.has(dependency)) for (const ancestor of ancestorsOf(dependency, byId, memo)) found.add(ancestor);
  }
  return found;
}

/** Whether a fact's closure kills the fact whose ancestors (itself included) are `ancestors`. */
const kills = (closure: DeedClosure | null, ancestors: ReadonlySet<string>): boolean =>
  closure !== null && !(closure.reason === "superseded" && ancestors.has(closure.closedByFactId));

/** The facts as they stood at `atMs`: those recorded by then, and only the closures recorded by then. */
export function visibleAt(facts: readonly DeedFact[], atMs: number): DeedFact[] {
  return facts
    .filter((fact) => fact.recordedAtMs <= atMs)
    .map((fact) => ({
      ...fact,
      closure: fact.closure !== null && (fact.closure.atMs ?? Number.NEGATIVE_INFINITY) <= atMs ? fact.closure : null,
    }));
}

export function deedGraph(facts: readonly DeedFact[], refusals: readonly DeedRefusal[] = []): DeedGraph {
  const ordered = inRecordedOrder(facts);
  const byId = new Map(ordered.map((fact) => [fact.id, fact]));
  const ancestry = new Map<string, ReadonlySet<string>>();
  const depth = new Map<string, number>();

  // The longest path from a root: a fact one row below its deepest dependency.
  const layerOf = (id: string, onPath: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (onPath.has(id)) return 0;
    onPath.add(id);
    const dependencies = (byId.get(id)?.dependsOn ?? []).filter((dependency) => byId.has(dependency));
    const layer = dependencies.length === 0 ? 0 : 1 + Math.max(...dependencies.map((dependency) => layerOf(dependency, onPath)));
    onPath.delete(id);
    depth.set(id, layer);
    return layer;
  };

  const statusOf = (fact: DeedFact): DeedStatus => {
    const ancestors = ancestorsOf(fact.id, byId, ancestry);
    if (kills(fact.closure, ancestors)) return "closed";
    for (const ancestor of ancestors) {
      if (ancestor !== fact.id && kills(byId.get(ancestor)?.closure ?? null, ancestors)) return "blocked";
    }
    return fact.kind === "change_request" && fact.closure === null ? "pending" : "live";
  };

  const perLayer = new Map<number, number>();
  const nodes: DeedNode[] = ordered.map((fact) => {
    const layer = layerOf(fact.id, new Set());
    const column = perLayer.get(layer) ?? 0;
    perLayer.set(layer, column + 1);
    return { id: fact.id, kind: fact.kind, recordedAtMs: fact.recordedAtMs, status: statusOf(fact), layer, column };
  });

  const edges: DeedEdge[] = [];
  for (const fact of ordered) {
    for (const dependency of fact.dependsOn) {
      if (byId.has(dependency)) edges.push({ from: dependency, to: fact.id, type: "depends" });
    }
    if (fact.closure !== null && byId.has(fact.closure.closedByFactId)) {
      edges.push({ from: fact.closure.closedByFactId, to: fact.id, type: "closes" });
    }
  }

  const layers = nodes.length === 0 ? 0 : Math.max(...nodes.map((node) => node.layer)) + 1;
  const byTime = [...refusals].sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const refusalNodes = byTime.map((refusal, column) => ({ ...refusal, column }));
  for (const refusal of byTime) {
    if (refusal.decidingFactId !== null && byId.has(refusal.decidingFactId)) {
      edges.push({ from: refusal.id, to: refusal.decidingFactId, type: "refused" });
    }
  }

  return { nodes, edges, layers, refusals: refusalNodes };
}

/** The ledger's live reading of a status: a live fact, or a pending change request. */
export const isLiveStatus = (status: DeedStatus): boolean => status === "live" || status === "pending";

/**
 * For a blocked fact: the nearest ancestor whose closure kills it, and the path of facts from the blocked
 * fact down to it (both ends included), so the screen can draw what blocks it. Null for any fact that isn't
 * blocked. A closed ancestor whose supersede is one of the fact's own ancestors doesn't kill it, so it isn't named.
 */
export function blockingPath(graph: DeedGraph, factId: string, facts: readonly DeedFact[]): { closedId: string; path: string[] } | null {
  const node = graph.nodes.find((candidate) => candidate.id === factId);
  if (node === undefined || node.status !== "blocked") return null;
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const ancestors = ancestorsOf(factId, byId, new Map());
  // Breadth first over `dependsOn`, so the nearest killing ancestor wins; `via` rebuilds the path.
  const via = new Map<string, string>();
  const queue = [factId];
  const seen = new Set([factId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependency of byId.get(current)?.dependsOn ?? []) {
      if (!byId.has(dependency) || seen.has(dependency)) continue;
      seen.add(dependency);
      via.set(dependency, current);
      if (kills(byId.get(dependency)!.closure, ancestors)) {
        const path = [dependency];
        for (let step = via.get(dependency); step !== undefined; step = via.get(step)) path.unshift(step);
        return { closedId: dependency, path };
      }
      queue.push(dependency);
    }
  }
  return null;
}
