/**
 * Fact memory types. Pure data: no I/O, no imports from infrastructure or application.
 * Shapes follow the fact-memory spec (§3 schema, §4 port change).
 */

/** What a fact rests on. Mirrors the `fact_evidence.kind` CHECK in migrations/0004_ledger.sql. */
export interface EvidenceRef {
  readonly kind: "inbound_message" | "media_asset" | "confirmation" | "stock_movement" | "fact";
  readonly refId: string;
  /** Media only: the stored object's SHA-256. Null otherwise. */
  readonly contentSha256: string | null;
}

/** One row of `stock_movements`. Compensating movements carry a negative quantity. */
export interface StockMovement {
  readonly id: string;
  readonly productId: string;
  /** Never 0 (schema CHECK). */
  readonly qtyMilli: number;
  /** Null means unknown cost, never 0 (non-negotiable 2). */
  readonly unitCostCentavos: number | null;
}

/** An append-only fact the engine asks to admit, with everything it rests on. */
export interface FactCommit {
  readonly factId: string;
  readonly kind: "receipt" | "cancellation" | "price";
  readonly operationKey: string;
  readonly draft: { readonly id: string; readonly revision: number } | null;
  readonly actorUserId: string;
  readonly validFromMs: number;
  /** Serialized by the repository. */
  readonly body: unknown;
  /** Must include one 'confirmation'. */
  readonly evidence: readonly EvidenceRef[];
  /** Every dependency must be live. */
  readonly dependsOn: readonly string[];
  readonly closes: { readonly factId: string; readonly reason: "cancelled" | "superseded" } | null;
  readonly movements: readonly StockMovement[];
}
