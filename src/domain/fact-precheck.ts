/**
 * The read before the write.
 *
 * Every guard in a commit batch answers "may this be saved?" by making the batch fail. That is the
 * right answer for a race, and the wrong answer for a question the records can already settle: a
 * stale tap, a key already used, a dependency someone cancelled. Those have an outcome the
 * customer should see, so the engine reads first and returns one, and the guard stays as the
 * backstop for the case where the records changed between the read and the batch.
 *
 * A guard that does fire after a passing precheck is a real race: `processor.ts` retries, the
 * retry reads again, and the second read produces the outcome.
 */
import type { EngineOutcome } from "./contract/outcomes";

/** What the records say about one proposed fact, read before its batch is built. */
export interface FactPrecheckReads {
  /** The outcome of the first save under this operation key, or null when the key is unused. */
  readonly firstOutcome: EngineOutcome | null;
  /** The draft's current revision and state, or null when the conversation has no such draft. */
  readonly draft: { readonly revision: number; readonly state: string; readonly expiresAtMs: number } | null;
  /** Dependency ids of this fact that are closed, or belong to another store, or don't exist. */
  readonly deadDependencies: readonly string[];
  /**
   * The fact this one closes: null when it closes nothing, "live" when it is this store's and open,
   * "closed" when already cancelled, "missing" when it doesn't exist or belongs to another store.
   */
  readonly closesState: "live" | "closed" | "missing" | null;
}

/** What the engine proposes to save, as far as the precheck cares. */
export interface FactPrecheckSubject {
  readonly draft: { readonly id: string; readonly revision: number } | null;
  readonly dependsOn: readonly string[];
}

/**
 * The outcome the records already imply, or null when nothing stands in the way and the commit
 * should be built. Order matters: a used key wins over everything, because the work is already
 * done; a stale revision wins over the gate, because the customer is looking at the wrong screen.
 */
export type FactPrecheckResult =
  | {
      readonly outcome: EngineOutcome;
      readonly deadDependencies?: readonly string[];
      /** Set when the fact to close can't be closed: already closed, or not this store's. */
      readonly closes?: "closed" | "missing";
    }
  | null;

export function precheckFact(subject: FactPrecheckSubject, reads: FactPrecheckReads, nowMs: number): FactPrecheckResult {
  if (reads.firstOutcome !== null) {
    return { outcome: { type: "duplicate", first: reads.firstOutcome } };
  }

  if (subject.draft !== null) {
    const { draft } = reads;
    if (draft === null || draft.state !== "pending" || draft.expiresAtMs <= nowMs) {
      return { outcome: { type: "rejected", reason: "invalid_state", order: null } };
    }
    if (draft.revision !== subject.draft.revision) {
      return { outcome: { type: "rejected", reason: "stale_version", order: null } };
    }
  }

  if (reads.deadDependencies.length > 0) {
    // Not a failure. The contract's QuestionCode has no code for "what it depends on was
    // cancelled", so this is a rejection the caller turns into one concrete question; adding a
    // code belongs to the contract (#5), not here.
    return { outcome: { type: "rejected", reason: "invalid_state", order: null }, deadDependencies: reads.deadDependencies };
  }

  if (reads.closesState === "closed" || reads.closesState === "missing") {
    return { outcome: { type: "rejected", reason: "invalid_state", order: null }, closes: reads.closesState };
  }

  return null;
}
