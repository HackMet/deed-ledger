/**
 * The order engine's read of the store's verified stock, a port so the engine never names D1; the
 * adapter is `D1StockBalances`. Read-only: nothing here writes stock.
 */
import type { Thousandths } from "../../domain/contract/numbers";
import type { Tenant } from "../ports";

export interface StockBalances {
  /** This store's balance of each product that has a record. A product left out is unknown, never zero. */
  balances(tenant: Tenant, productIds: readonly string[]): Promise<ReadonlyMap<string, Thousandths>>;
}
