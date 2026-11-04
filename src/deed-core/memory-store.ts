/**
 * The same rules as the D1 store, with no database: for tests and for hosts that aren't on Cloudflare.
 * Writes are applied only after every check passes, so a refused entry leaves nothing behind.
 */
import { judge } from "./judge";
import { type Closed, type LedgerView, deadAncestors } from "./liveness";
import type { LedgerStore } from "./store";
import type { Entry, JudgeState, Policy, Verdict } from "./types";

interface Scope {
  /** Fact id to the ids it depends on. */
  readonly dependsOn: Map<string, readonly string[]>;
  readonly keys: Set<string>;
  readonly closures: Map<string, Closed>;
}

export class MemoryLedgerStore implements LedgerStore {
  private readonly scopes = new Map<string, Scope>();

  constructor(private readonly policy: Policy) {}

  async admit(scope: string, entry: Entry): Promise<Verdict> {
    return this.admitNow(scope, entry);
  }

  /** The same admit, synchronous: for a judge that must answer in one step (see recheck.ts). */
  admitNow(scope: string, entry: Entry): Verdict {
    const state = this.scopeOf(scope);
    const verdict = judge(entry, stateOf(state, entry), this.policy);
    if (!verdict.admitted) return verdict;
    // After the writes, the entry and its whole ancestry must be live. Checked on an overlay before any write.
    if (deadAncestors([entry.factId], viewOf(withEntry(state, entry))).length > 0) return { admitted: false, reason: "dependency_not_live" };
    state.dependsOn.set(entry.factId, entry.dependsOn);
    state.keys.add(entry.operationKey);
    if (entry.closes !== null) state.closures.set(entry.closes.factId, { reason: entry.closes.reason, closedBy: entry.factId });
    return verdict;
  }

  private scopeOf(scope: string): Scope {
    let found = this.scopes.get(scope);
    if (found === undefined) {
      found = { dependsOn: new Map(), keys: new Set(), closures: new Map() };
      this.scopes.set(scope, found);
    }
    return found;
  }
}

/**
 * The reads for one entry: a key or fact id in use, dependencies dead before the write (sameBatch excluded), and the
 * closed target's state.
 */
function stateOf(scope: Scope, entry: Entry): JudgeState {
  const sameBatch = entry.sameBatch ?? [];
  const target = entry.closes?.factId;
  const closes: JudgeState["closes"] =
    target === undefined ? null : scope.closures.has(target) ? "closed" : scope.dependsOn.has(target) ? "live" : "missing";
  return {
    keyUsed: scope.keys.has(entry.operationKey) || scope.dependsOn.has(entry.factId),
    deadDependencies: deadAncestors(entry.dependsOn.filter((id) => !sameBatch.includes(id)), viewOf(scope)),
    closes,
  };
}

function viewOf(scope: Scope): LedgerView {
  return {
    has: (factId) => scope.dependsOn.has(factId),
    dependsOn: (factId) => scope.dependsOn.get(factId) ?? [],
    closure: (factId) => scope.closures.get(factId) ?? null,
  };
}

/** The scope as it would be after `entry`, without touching it. */
function withEntry(scope: Scope, entry: Entry): Scope {
  const dependsOn = new Map(scope.dependsOn);
  dependsOn.set(entry.factId, entry.dependsOn);
  const closures = new Map(scope.closures);
  if (entry.closes !== null) closures.set(entry.closes.factId, { reason: entry.closes.reason, closedBy: entry.factId });
  return { dependsOn, keys: scope.keys, closures };
}
