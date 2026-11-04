/**
 * Liveness by closures, never by cascade: a fact is dead when it is missing, or closed in a way that kills it.
 * A supersede by another ancestor doesn't kill: v2 depends on v1 and closes it `superseded`, so v2 stays live
 * while whatever rests on v1 alone dies with it.
 */

export interface Closed {
  readonly reason: "cancelled" | "superseded";
  readonly closedBy: string;
}

/** The read-only view liveness needs. A host builds it from its tables; the memory ledger from its maps. */
export interface LedgerView {
  readonly has: (factId: string) => boolean;
  readonly dependsOn: (factId: string) => readonly string[];
  readonly closure: (factId: string) => Closed | null;
}

/** The ids reached from `ids` through dependencies, the ids themselves included. */
export function ancestorsOf(ids: readonly string[], view: LedgerView): Set<string> {
  const seen = new Set<string>(ids);
  const queue = [...ids];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const dependency of view.dependsOn(id)) {
      if (!seen.has(dependency)) {
        seen.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return seen;
}

/**
 * The dependencies, and their ancestors, that are missing or killed. A closure kills unless it is a supersede by
 * another ancestor. Empty when the gate is open.
 */
export function deadAncestors(dependsOn: readonly string[], view: LedgerView): string[] {
  const ancestors = ancestorsOf(dependsOn, view);
  const dead: string[] = [];
  for (const id of ancestors) {
    const closed = view.closure(id);
    const killed = closed !== null && !(closed.reason === "superseded" && ancestors.has(closed.closedBy));
    if (!view.has(id) || killed) dead.push(id);
  }
  return dead;
}
