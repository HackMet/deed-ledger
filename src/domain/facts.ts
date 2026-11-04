/**
 * Fact memory types. Pure data: no I/O, no imports from infrastructure or application.
 * Shapes follow the fact-memory spec (§3 schema, §4 port change).
 */

/**
 * What a fact rests on. Mirrors the `fact_evidence.kind` CHECK (migrations/0023_order_facts.sql).
 * `member` is the console member who tapped; `session` is in the CHECK but not written yet.
 */
export interface EvidenceRef {
  readonly kind: "inbound_message" | "media_asset" | "confirmation" | "stock_movement" | "fact" | "member" | "session";
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
/** Mirrors the `facts.kind` CHECK (migrations/0024_change_requests.sql). `receipt_review` is K14's. */
export type FactKind =
  | "receipt"
  | "cancellation"
  | "price"
  | "order_version"
  | "order_confirm"
  | "order_cancel"
  | "order_status"
  | "business_info"
  | "change_request"
  | "change_review"
  | "receipt_review";

export interface FactCommit {
  readonly factId: string;
  readonly kind: FactKind;
  readonly operationKey: string;
  readonly draft: { readonly id: string; readonly revision: number } | null;
  /** The customer id or the member id: `facts.actor_user_id` has no foreign key. */
  readonly actorUserId: string;
  readonly validFromMs: number;
  /** Serialized by the repository. */
  readonly body: unknown;
  /**
   * Never empty. Receipts: exactly one 'confirmation' and an 'inbound_message'. A customer's order
   * facts: an 'inbound_message'. order_status: exactly one 'member'. change_request: an 'inbound_message';
   * change_review: exactly one 'member'.
   */
  readonly evidence: readonly EvidenceRef[];
  /**
   * Every dependency must be live: it and its ancestors exist and none is closed, except an ancestor
   * superseded by another ancestor (v2 depends on and supersedes v1, and stays live).
   */
  readonly dependsOn: readonly string[];
  /**
   * The `dependsOn` ids written earlier in the same batch (an approved change's new version rests on
   * the review saved with it). Every guard runs before any statement, so G4 checks the others first
   * and the fact's whole ancestry is checked again after the statements.
   */
  readonly sameBatch?: readonly string[];
  readonly closes: { readonly factId: string; readonly reason: "cancelled" | "superseded" } | null;
  readonly movements: readonly StockMovement[];
  /** C11: the agent configuration's id, on a customer's claim only; absent or null on everything else. */
  readonly agentId?: string | null;
}
