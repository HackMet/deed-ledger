/**
 * The Deed's record of checks (K20): one row for every refusal, duplicate and claim verdict the order
 * engine decides. A port, so the engine never names D1; the adapter is `D1DeedChecks`.
 *
 * Recording is best effort and comes after the decision: a failed record changes neither the outcome
 * nor the commits, and a row carries IDs and codes only, never the text a customer or member wrote.
 */
import type { Tenant } from "../ports";

/** Where a check was decided: the refusal's reason, a claim, or a repeated key (the table's CHECK). */
export const DEED_CHECK_SOURCES = ["verify_claims", "duplicate_key", "stale_version", "gate", "not_allowed", "not_found"] as const;
export type DeedCheckSource = (typeof DEED_CHECK_SOURCES)[number];

/** The claim types the contract names; anything else is recorded as `other`. */
export const DEED_CLAIM_KINDS = [
  "order_state",
  "order_total",
  "unit_price",
  "availability",
  "payment_confirmed",
  "balance",
  "store_hours",
  "other",
] as const;

export interface DeedCheckRow {
  readonly id: string;
  readonly atMs: number;
  readonly source: DeedCheckSource;
  readonly subjectFactId: string | null;
  readonly orderId: string | null;
  readonly claimKind: string | null;
  readonly result: "pass" | "fail";
  readonly reasonCode: string | null;
  readonly decidingFactId: string | null;
  readonly operationKey: string | null;
}

export interface DeedChecks {
  /** Writes the rows in one batch for the store. Throws when the write fails; the caller decides what that means. */
  record(tenant: Tenant, rows: readonly DeedCheckRow[]): Promise<void>;
}
