/**
 * The read model of the order's three-lane view (K20c): what the agent said (its replies' claims), what the
 * book holds (the order's facts, their lines and refusals) and what the world recorded (delivery statuses and
 * the staff taps). Read-only. Every query is scoped to the store, and an order of another store is null.
 */
import type { Claim } from "../../domain/contract/outcomes";
import type { Tenant } from "../../application/ports";
import type { LibroFact, LibroInput, LibroRefusal, LibroReply, ProviderStatus, RecordedLine } from "../../domain/deed-libro";
import { FACTS_SQL } from "./order-trail";

interface FactRow {
  id: string;
  kind: LibroFact["kind"];
  operation_key: string;
  body_json: string;
  recorded_at_ms: number;
  live: number;
}

interface ReplyRow {
  id: string;
  status: string;
  provider_status: ProviderStatus | null;
  provider_status_at_s: number | null;
  claims_json: string;
  at_ms: number;
}

/** Thousandths as a decimal string the pure module reads exactly: 2500 → "2.5", 2000 → "2". */
const milliToDecimal = (milli: number): string => {
  const whole = Math.trunc(milli / 1000);
  const fraction = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
};

export class D1LibroReads {
  constructor(private readonly db: D1Database) {}

  /** The order's three-lane input, or null when the order is not in this store. */
  async read(tenant: Tenant, orderId: string): Promise<LibroInput | null> {
    const order = await this.db
      .prepare(`SELECT id FROM orders WHERE business_id = ?1 AND id = ?2`)
      .bind(tenant.businessId, orderId)
      .first<{ id: string }>();
    if (order === null) return null;
    const [facts, lines, replies, refusals] = await Promise.all([
      this.factsOf(tenant, orderId),
      this.linesOf(tenant, orderId),
      this.repliesOf(tenant, orderId),
      this.refusalsOf(tenant, orderId),
    ]);
    return { orderId, facts, lines, replies, refusals };
  }

  /** The order's facts with their liveness (K20's rule, FACTS_SQL) and the member or session that tapped each. */
  private async factsOf(tenant: Tenant, orderId: string): Promise<LibroFact[]> {
    const { results } = await this.db.prepare(FACTS_SQL).bind(tenant.businessId, orderId).all<FactRow>();
    if (results.length === 0) return [];
    const ids = JSON.stringify(results.map((row) => row.id));
    const { results: witnesses } = await this.db
      .prepare(
        `SELECT fact_id, kind, ref_id FROM fact_evidence
         WHERE business_id = ?1 AND kind IN ('member', 'session') AND fact_id IN (SELECT value FROM json_each(?2))
         ORDER BY kind, ref_id`,
      )
      .bind(tenant.businessId, ids)
      .all<{ fact_id: string; kind: "member" | "session"; ref_id: string }>();
    return results.map((row) => {
      const body = JSON.parse(row.body_json) as { version?: number; status?: LibroFact["status"]; resumeState?: LibroFact["resumeState"] };
      const witness = witnesses.find((w) => w.fact_id === row.id);
      return {
        id: row.id,
        kind: row.kind,
        operationKey: row.operation_key,
        recordedAtMs: row.recorded_at_ms,
        version: typeof body.version === "number" ? body.version : null,
        status: body.status ?? null,
        resumeState: body.resumeState ?? null,
        live: row.live === 1,
        witness: witness === undefined ? null : { kind: witness.kind, refId: witness.ref_id },
      };
    });
  }

  /** The order's lines, per version: a line left out of the total, or with an unknown price or quantity, says so. */
  private async linesOf(tenant: Tenant, orderId: string): Promise<RecordedLine[]> {
    const { results } = await this.db
      .prepare(
        `SELECT version, excluded_from_total, unit_price_centavos, qty_milli FROM order_lines
         WHERE business_id = ?1 AND order_id = ?2 ORDER BY version, line_no`,
      )
      .bind(tenant.businessId, orderId)
      .all<{ version: number; excluded_from_total: number; unit_price_centavos: number | null; qty_milli: number | null }>();
    return results.map((row) => ({
      version: row.version,
      counted: row.excluded_from_total === 0,
      unitPrice: row.unit_price_centavos,
      quantity: row.qty_milli === null ? null : milliToDecimal(row.qty_milli),
    }));
  }

  /**
   * The replies that carry a claim about this order, found through their claims. A reply whose claims were
   * blocked at send time is left out: its delivery is of the safe reply, not of what it claimed.
   */
  private async repliesOf(tenant: Tenant, orderId: string): Promise<LibroReply[]> {
    const { results } = await this.db
      .prepare(
        `SELECT o.id, o.status, o.provider_status, o.provider_status_at_s, o.claims_json,
           COALESCE(o.sent_at_ms, o.created_at_ms) AS at_ms
         FROM outbound_messages o
         WHERE o.business_id = ?1 AND o.claims_json IS NOT NULL AND o.claims_blocked_at_ms IS NULL
           AND EXISTS (SELECT 1 FROM json_each(o.claims_json) j WHERE json_extract(j.value, '$.orderId') = ?2)
         ORDER BY at_ms, o.seq`,
      )
      .bind(tenant.businessId, orderId)
      .all<ReplyRow>();
    return results.map((row) => ({
      id: row.id,
      atMs: row.at_ms,
      status: row.status,
      providerStatus: row.provider_status,
      providerStatusAtS: row.provider_status_at_s,
      claims: JSON.parse(row.claims_json) as Claim[],
    }));
  }

  /** The refused attempts on this order: refusal rows only, never the claim checks. */
  private async refusalsOf(tenant: Tenant, orderId: string): Promise<LibroRefusal[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, at_ms, reason_code, deciding_fact_id, operation_key FROM deed_checks
         WHERE business_id = ?1 AND order_id = ?2 AND result = 'fail' AND source <> 'verify_claims' ORDER BY at_ms, rowid`,
      )
      .bind(tenant.businessId, orderId)
      .all<{ id: string; at_ms: number; reason_code: string | null; deciding_fact_id: string | null; operation_key: string | null }>();
    return results.map((row) => ({
      id: row.id,
      atMs: row.at_ms,
      reason: row.reason_code ?? "",
      decidingFactId: row.deciding_fact_id,
      operationKey: row.operation_key,
    }));
  }
}
