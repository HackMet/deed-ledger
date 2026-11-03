/**
 * The Deed's checks on D1 (K20): the write adapter the order engine records through, and the read
 * model of the verification feed. Every query is scoped to the store; `deed_checks` is append-only
 * (migration 0027), so the reads never see a row change under them.
 */
import type { DeedCheckRow, DeedChecks } from "../../application/engine/deed-checks";
import type { Tenant } from "../../application/ports";
import type { DeedRefusal } from "../../domain/deed-graph";

export class D1DeedChecks implements DeedChecks {
  constructor(private readonly db: D1Database) {}

  async record(tenant: Tenant, rows: readonly DeedCheckRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.batch(
      rows.map((row) =>
        this.db
          .prepare(
            `INSERT INTO deed_checks (business_id, id, at_ms, source, subject_fact_id, order_id, claim_kind, result, reason_code,
               deciding_fact_id, operation_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            tenant.businessId,
            row.id,
            row.atMs,
            row.source,
            row.subjectFactId,
            row.orderId,
            row.claimKind,
            row.result,
            row.reasonCode,
            row.decidingFactId,
            row.operationKey,
          ),
      ),
    );
  }
}

/** One row of the feed, as the screen shows it. */
export interface DeedCheckView {
  readonly id: string;
  readonly atMs: number;
  readonly source: string;
  readonly orderId: string | null;
  readonly claimKind: string | null;
  readonly result: "pass" | "fail";
  readonly reasonCode: string | null;
  readonly decidingFactId: string | null;
  readonly operationKey: string | null;
}

/**
 * The counters on top of the feed. Refused attempts (the engine said no to a tap or a message) are counted
 * apart from claims (the engine checked what was said): a claim that failed is not an attempt refused.
 */
export interface DeedCounters {
  /** Attempts the engine refused: refusal rows, by reason in `refusedByReason`. */
  readonly attempts: number;
  /** Claims the engine checked, and how many of them held. */
  readonly claims: number;
  readonly claimsPassed: number;
  readonly refusedByReason: ReadonlyMap<string, number>;
}

export class D1DeedReads {
  constructor(private readonly db: D1Database) {}

  async counters(tenant: Tenant): Promise<DeedCounters> {
    const { results } = await this.db
      .prepare(
        `SELECT source = 'verify_claims' AS claim, result, reason_code, count(*) AS n FROM deed_checks
         WHERE business_id = ?1 GROUP BY claim, result, reason_code`,
      )
      .bind(tenant.businessId)
      .all<{ claim: 0 | 1; result: "pass" | "fail"; reason_code: string | null; n: number }>();
    let attempts = 0;
    let claims = 0;
    let claimsPassed = 0;
    const byReason = new Map<string, number>();
    for (const row of results) {
      if (row.claim === 1) {
        claims += row.n;
        if (row.result === "pass") claimsPassed += row.n;
        continue;
      }
      if (row.result === "pass") continue;
      attempts += row.n;
      const reason = row.reason_code ?? "unknown";
      byReason.set(reason, (byReason.get(reason) ?? 0) + row.n);
    }
    return { attempts, claims, claimsPassed, refusedByReason: byReason };
  }

  /** The refusals the engine made on one order, oldest first; the claim checks are not an order's refusals. */
  async refusalsOf(tenant: Tenant, orderId: string): Promise<DeedRefusal[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, at_ms, reason_code, deciding_fact_id FROM deed_checks
         WHERE business_id = ?1 AND order_id = ?2 AND result = 'fail' AND source <> 'verify_claims' ORDER BY at_ms, rowid`,
      )
      .bind(tenant.businessId, orderId)
      .all<{ id: string; at_ms: number; reason_code: string | null; deciding_fact_id: string | null }>();
    return results.map((row) => ({ id: row.id, atMs: row.at_ms, reason: row.reason_code ?? "", decidingFactId: row.deciding_fact_id }));
  }

  /** The newest checks of the store, newest first. */
  async feed(tenant: Tenant, limit = 100): Promise<DeedCheckView[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, at_ms, source, order_id, claim_kind, result, reason_code, deciding_fact_id, operation_key
         FROM deed_checks WHERE business_id = ?1 ORDER BY at_ms DESC, rowid DESC LIMIT ?2`,
      )
      .bind(tenant.businessId, limit)
      .all<{
        id: string;
        at_ms: number;
        source: string;
        order_id: string | null;
        claim_kind: string | null;
        result: "pass" | "fail";
        reason_code: string | null;
        deciding_fact_id: string | null;
        operation_key: string | null;
      }>();
    return results.map((row) => ({
      id: row.id,
      atMs: row.at_ms,
      source: row.source,
      orderId: row.order_id,
      claimKind: row.claim_kind,
      result: row.result,
      reasonCode: row.reason_code,
      decidingFactId: row.deciding_fact_id,
      operationKey: row.operation_key,
    }));
  }
}
