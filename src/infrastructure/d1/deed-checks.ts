/**
 * The Deed's checks on D1 (K20): the write adapter the order engine records through, and the read
 * model of the verification feed. Every query is scoped to the store; `deed_checks` is append-only
 * (migration 0027), so the reads never see a row change under them.
 */
import type { DeedCheckRow, DeedChecks } from "../../application/engine/deed-checks";
import type { Tenant } from "../../application/ports";

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

/** The counters on top of the feed: every check, the passes, and the refusals by reason. */
export interface DeedCounters {
  readonly total: number;
  readonly passed: number;
  readonly refused: number;
  readonly refusedByReason: ReadonlyMap<string, number>;
}

export class D1DeedReads {
  constructor(private readonly db: D1Database) {}

  async counters(tenant: Tenant): Promise<DeedCounters> {
    const { results } = await this.db
      .prepare(`SELECT result, reason_code, count(*) AS n FROM deed_checks WHERE business_id = ?1 GROUP BY result, reason_code`)
      .bind(tenant.businessId)
      .all<{ result: "pass" | "fail"; reason_code: string | null; n: number }>();
    let total = 0;
    let passed = 0;
    let refused = 0;
    const byReason = new Map<string, number>();
    for (const row of results) {
      total += row.n;
      if (row.result === "pass") passed += row.n;
      else {
        refused += row.n;
        const reason = row.reason_code ?? "unknown";
        byReason.set(reason, (byReason.get(reason) ?? 0) + row.n);
      }
    }
    return { total, passed, refused, refusedByReason: byReason };
  }

  /** The newest checks of the store, newest first. */
  async feed(tenant: Tenant, limit = 100): Promise<DeedCheckView[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, at_ms, source, order_id, claim_kind, result, reason_code, deciding_fact_id, operation_key
         FROM deed_checks WHERE business_id = ?1 ORDER BY at_ms DESC, id DESC LIMIT ?2`,
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
