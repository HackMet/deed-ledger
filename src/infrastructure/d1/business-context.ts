import type { BusinessInfoStore } from "../../application/business";
import type { Tenant } from "../../application/ports";
import type { BusinessInfo } from "../../domain/business-info";

/** The newest live `business_info` fact of a store; a new save closes the one before it. */
export class D1BusinessContext implements BusinessInfoStore {
  constructor(private readonly db: D1Database) {}

  async current(tenant: Tenant): Promise<BusinessInfo | null> {
    return (await this.currentFact(tenant))?.info ?? null;
  }

  /** The fact too, so a save can close it. */
  async currentFact(tenant: Tenant): Promise<{ readonly factId: string; readonly info: BusinessInfo } | null> {
    const row = await this.db
      .prepare(
        `SELECT f.id, f.body_json FROM facts f
         WHERE f.business_id = ? AND f.kind = 'business_info'
           AND NOT EXISTS (SELECT 1 FROM fact_closures c WHERE c.business_id = f.business_id AND c.fact_id = f.id)
         ORDER BY f.rowid DESC LIMIT 1`,
      )
      .bind(tenant.businessId)
      .first<{ id: string; body_json: string }>();
    return row === null ? null : { factId: row.id, info: JSON.parse(row.body_json) as BusinessInfo };
  }

  async keyUsed(tenant: Tenant, operationKey: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS used FROM facts WHERE business_id = ? AND operation_key = ?`)
      .bind(tenant.businessId, operationKey)
      .first<{ used: number }>();
    return row !== null;
  }
}
