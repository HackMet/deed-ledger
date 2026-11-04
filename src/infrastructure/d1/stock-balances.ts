import type { StockBalances } from "../../application/engine/stock-balances";
import type { Tenant } from "../../application/ports";
import type { Thousandths } from "../../domain/contract/numbers";

/** Reads `stock_balances`, scoped to the store. It only reads: the ledger's commits write that table. */
export class D1StockBalances implements StockBalances {
  constructor(private readonly db: D1Database) {}

  async balances(tenant: Tenant, productIds: readonly string[]): Promise<ReadonlyMap<string, Thousandths>> {
    if (productIds.length === 0) return new Map();
    const { results } = await this.db
      .prepare(`SELECT product_id, qty_milli FROM stock_balances WHERE business_id = ? AND product_id IN (SELECT value FROM json_each(?))`)
      .bind(tenant.businessId, JSON.stringify(productIds))
      .all<{ product_id: string; qty_milli: number }>();
    return new Map(results.map((row) => [row.product_id, row.qty_milli]));
  }
}
