/**
 * The core's input, policy and output. Pure types: no imports, no I/O.
 * `kind` and `evidence.kind` are opaque strings: the core never reads what they mean.
 */

export interface Evidence {
  readonly kind: string;
  readonly refId: string;
  /** Optional: the SHA-256 of the evidence's content, for any kind. Null otherwise. */
  readonly contentSha256: string | null;
}

export interface Closure {
  readonly factId: string;
  readonly reason: "cancelled" | "superseded";
}

/** One append-only entry the host asks to admit, with everything it rests on. */
export interface Entry {
  readonly factId: string;
  readonly kind: string;
  /** One logical operation, one key: a second entry with the same key is a duplicate. */
  readonly operationKey: string;
  readonly actor: string;
  readonly validFromMs: number;
  readonly body: unknown;
  readonly evidence: readonly Evidence[];
  /** Every dependency must be live (see liveness.ts). */
  readonly dependsOn: readonly string[];
  /** The `dependsOn` ids written earlier in the same batch: checked again after the writes. */
  readonly sameBatch?: readonly string[];
  readonly closes: Closure | null;
  /** Stamped by the host on a claim; the core stores it and never reads it. */
  readonly agentId?: string | null;
}

/** "At least `min` and at most `max` rows of `kind`". An absent bound is open. */
export interface Requirement {
  readonly kind: string;
  readonly min?: number;
  readonly max?: number;
}

/**
 * The first rule whose `when` holds decides, and it must then be satisfied. A rule without `when` always holds.
 * No rule holding refuses the entry.
 */
export interface EvidenceRule {
  readonly when?: Requirement;
  readonly require: readonly Requirement[];
}

/** The only thing a host writes to adopt the core: plain data, one entry per kind it admits. */
export interface Policy {
  readonly kinds: Readonly<Record<string, { readonly evidence: readonly EvidenceRule[] }>>;
}

/** Refusals the core itself gives. A host may add its own reason strings in its extension. */
export type CoreReason = "duplicate" | "unknown_kind" | "evidence_incomplete" | "dependency_not_live" | "closes_not_live";

export type Verdict = { readonly admitted: true; readonly factId: string } | { readonly admitted: false; readonly reason: CoreReason | (string & {}) };

/** The reads the judge needs, taken before the judge runs. Nothing else reaches it. */
export interface JudgeState {
  /** The operation key already has an entry. */
  readonly keyUsed: boolean;
  /** Dependencies (and their ancestors) that are missing or closed, from liveness.deadAncestors. */
  readonly deadDependencies: readonly string[];
  /** The entry this one closes: "missing" when absent, "closed" when already closed, null when it closes nothing. */
  readonly closes: "live" | "closed" | "missing" | null;
}
