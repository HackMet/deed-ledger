import {
  type CatalogRow,
  type CatalogStore,
  type NewProduct,
  PriceColumnMismatchError,
  type ProductDetails,
  ProductMissingError,
} from "../../application/catalog";
import { fromThousandths } from "../../application/engine/order-engine";
import type { Commit, Tenant } from "../../application/ports";
import { type Centavos, toThousandths } from "../../domain/contract/numbers";
import { type ProductSelling, productNameKey } from "../../domain/store-setup";

/**
 * The newest live confirmed price fact of the product row aliased `alias`, or NULL: the same rule as
 * `D1OrderStore.priceState` (a price fact is closed only by a newer confirmed one).
 */
export const liveConfirmedPriceSql = (alias: string): string => `(SELECT json_extract(f.body_json, '$.price') FROM facts f
  WHERE f.business_id = ${alias}.business_id AND f.kind = 'price' AND json_extract(f.body_json, '$.productId') = ${alias}.id
    AND json_extract(f.body_json, '$.status') = 'confirmed'
    AND NOT EXISTS (SELECT 1 FROM fact_closures c WHERE c.business_id = f.business_id AND c.fact_id = f.id)
  ORDER BY f.rowid DESC LIMIT 1)`;

interface Row {
  id: string;
  name: string;
  other_names_json: string | null;
  price_centavos: number | null;
  no_hay: number | null;
  sold_by: "unit" | "weight" | null;
  usual_quantity_milli: number | null;
}

/**
 * Both tables as one list: every `products` row with its `store_products` details, and any
 * `store_products` row the ledger's catalog doesn't have yet (migration 0031 adds them; this keeps
 * the list whole until it has run). Same ID in both tables; the store always comes from the tenant.
 */
const LIST = `SELECT pr.id, COALESCE(sp.name, pr.canonical_name) AS name, sp.other_names_json, sp.price_centavos, sp.no_hay,
    s.sold_by, s.usual_quantity_milli
  FROM products pr
  LEFT JOIN store_products sp ON sp.business_id = pr.business_id AND sp.id = pr.id
  LEFT JOIN store_product_selling s ON s.business_id = pr.business_id AND s.product_id = pr.id
  WHERE pr.business_id = ?1 AND (?2 IS NULL OR pr.id = ?2)
  UNION ALL
  SELECT sp.id, sp.name, sp.other_names_json, sp.price_centavos, sp.no_hay, s.sold_by, s.usual_quantity_milli
  FROM store_products sp
  LEFT JOIN store_product_selling s ON s.business_id = sp.business_id AND s.product_id = sp.id
  WHERE sp.business_id = ?1 AND (?2 IS NULL OR sp.id = ?2)
    AND NOT EXISTS (SELECT 1 FROM products pr WHERE pr.business_id = sp.business_id AND pr.id = sp.id)`;

export class D1CatalogStore implements CatalogStore {
  constructor(private readonly db: D1Database) {}

  async list(tenant: Tenant): Promise<readonly CatalogRow[]> {
    return this.read(tenant, null);
  }

  async product(tenant: Tenant, productId: string): Promise<CatalogRow | null> {
    return (await this.read(tenant, productId))[0] ?? null;
  }

  private async read(tenant: Tenant, productId: string | null): Promise<CatalogRow[]> {
    const { results } = await this.db.prepare(LIST).bind(tenant.businessId, productId).all<Row>();
    // The price facts of the store, newest first. Live = no closure. A proposal older than the live
    // confirmed price was already answered.
    const facts = await this.db
      .prepare(
        `SELECT json_extract(f.body_json, '$.productId') AS productId, json_extract(f.body_json, '$.status') AS status,
           json_extract(f.body_json, '$.price') AS price
         FROM facts f
         WHERE f.business_id = ? AND f.kind = 'price'
           AND NOT EXISTS (SELECT 1 FROM fact_closures c WHERE c.business_id = f.business_id AND c.fact_id = f.id)
         ORDER BY f.rowid DESC`,
      )
      .bind(tenant.businessId)
      .all<{ productId: string; status: string; price: number }>();
    const rows = results.map((product): CatalogRow => {
      const mine = facts.results.filter((fact) => fact.productId === product.id);
      const confirmedAt = mine.findIndex((fact) => fact.status === "confirmed");
      const proposed = mine.slice(0, confirmedAt === -1 ? undefined : confirmedAt).find((fact) => fact.status === "proposed");
      const price = confirmedAt === -1 ? null : mine[confirmedAt]!.price;
      return {
        id: product.id,
        name: product.name,
        price,
        proposed: proposed?.price ?? null,
        unconfirmed: price === null ? product.price_centavos : null,
        otherNames: otherNamesOf(product.other_names_json),
        noHay: product.no_hay === 1,
        soldBy: product.sold_by,
        usualQuantity: product.usual_quantity_milli === null ? null : fromThousandths(product.usual_quantity_milli),
      };
    });
    return rows.sort((a, b) => compareNames(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async nameTaken(tenant: Tenant, name: string, exceptId?: string): Promise<boolean> {
    const key = productNameKey(name);
    const { results } = await this.db
      .prepare(`SELECT id, canonical_name AS name FROM products WHERE business_id = ?1 UNION ALL SELECT id, name FROM store_products WHERE business_id = ?1`)
      .bind(tenant.businessId)
      .all<{ id: string; name: string }>();
    return results.some((row) => row.id !== exceptId && productNameKey(row.name) === key);
  }

  insertProduct(tenant: Tenant, product: NewProduct): Commit {
    return {
      guards: [],
      statements: [
        // UNIQUE (business_id, name_key): a name saved by another tap meanwhile fails the whole batch.
        this.db
          .prepare(
            `INSERT INTO store_products
               (id, business_id, name, name_key, other_names_json, price_centavos, no_hay, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .bind(product.id, tenant.businessId, product.name, productNameKey(product.name), JSON.stringify(product.otherNames), product.price, product.nowMs, product.nowMs),
        this.db
          .prepare(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) VALUES (?, ?, ?, ?)`)
          .bind(product.id, tenant.businessId, product.name, product.nowMs),
      ],
    };
  }

  priceColumn(tenant: Tenant, product: { readonly id: string; readonly name: string }, price: Centavos, nowMs: number): Commit {
    return {
      guards: [],
      statements: [
        this.ensureStoreRow(tenant, product.id, product.name, nowMs),
        this.db
          .prepare(`UPDATE store_products SET price_centavos = ?, updated_at_ms = ? WHERE business_id = ? AND id = ?`)
          .bind(price, nowMs, tenant.businessId, product.id),
      ],
      post: [
        {
          // The current price equals the fact just recorded. A row that couldn't be made (a name too long
          // for it) reads its price from the fact (`D1StoreSetupRepository`), so it agrees too.
          holdsSql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM store_products WHERE business_id = ? AND id = ? AND price_centavos IS NOT ?)`,
          params: [tenant.businessId, product.id, price],
          error: () => new PriceColumnMismatchError("store_products price differs from the price fact"),
        },
      ],
    };
  }

  details(tenant: Tenant, productId: string, details: ProductDetails, nowMs: number): Commit {
    const key = productNameKey(details.name);
    return {
      guards: [],
      statements: [
        this.ensureLedgerRow(tenant, productId),
        this.ensureStoreRow(tenant, productId, details.name, nowMs),
        this.db
          .prepare(`UPDATE store_products SET name = ?, name_key = ?, other_names_json = ?, updated_at_ms = ? WHERE business_id = ? AND id = ?`)
          .bind(details.name, key, JSON.stringify(details.otherNames), nowMs, tenant.businessId, productId),
        this.db.prepare(`UPDATE products SET canonical_name = ? WHERE business_id = ? AND id = ?`).bind(details.name, tenant.businessId, productId),
        ...(details.selling === undefined ? [] : [this.sellingStatement(tenant, productId, details.selling, nowMs)]),
      ],
      post: [this.bothRows(tenant, productId)],
    };
  }

  noHay(tenant: Tenant, product: { readonly id: string; readonly name: string }, noHay: boolean, nowMs: number): Commit {
    return {
      guards: [],
      statements: [
        this.ensureLedgerRow(tenant, product.id),
        this.ensureStoreRow(tenant, product.id, product.name, nowMs),
        this.db
          .prepare(`UPDATE store_products SET no_hay = ?, updated_at_ms = ? WHERE business_id = ? AND id = ?`)
          .bind(noHay ? 1 : 0, nowMs, tenant.businessId, product.id),
      ],
      post: [this.bothRows(tenant, product.id)],
    };
  }

  remove(tenant: Tenant, productId: string): Commit {
    return {
      guards: [],
      statements: [
        // How it's sold and its learned aliases go with it (0011, ON DELETE CASCADE).
        this.db.prepare(`DELETE FROM store_products WHERE business_id = ? AND id = ?`).bind(tenant.businessId, productId),
        this.db.prepare(`DELETE FROM products WHERE business_id = ? AND id = ?`).bind(tenant.businessId, productId),
      ],
    };
  }

  /** A `store_products` row with no `products` row yet gets one, same ID and name, before the engine reads it. */
  async ensureLedger(tenant: Tenant, productId: string): Promise<void> {
    await this.ensureLedgerRow(tenant, productId).run();
  }

  private ensureLedgerRow(tenant: Tenant, productId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO products (id, business_id, canonical_name, created_at_ms)
         SELECT id, business_id, name, created_at_ms FROM store_products WHERE business_id = ? AND id = ?`,
      )
      .bind(tenant.businessId, productId);
  }

  /**
   * A `products` row with no `store_products` row yet (an invoice's product, or one from before 0031)
   * gets one, same ID, its name keyed by code, its current price from its live confirmed fact.
   * Ignored when the row is there already, or when it can't be made (another product has the name).
   */
  private ensureStoreRow(tenant: Tenant, productId: string, name: string, nowMs: number): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO store_products
           (id, business_id, name, name_key, other_names_json, price_centavos, no_hay, created_at_ms, updated_at_ms)
         SELECT pr.id, pr.business_id, ?, ?, '[]', ${liveConfirmedPriceSql("pr")}, 0, pr.created_at_ms, ?
         FROM products pr WHERE pr.business_id = ? AND pr.id = ?`,
      )
      .bind(name, productNameKey(name), nowMs, tenant.businessId, productId);
  }

  /** After the writes, the product is in both tables of this store. */
  private bothRows(tenant: Tenant, productId: string) {
    return {
      // Plain placeholders: the guard runs inside `INSERT INTO batch_guards ... VALUES (?, (...))`.
      holdsSql: `SELECT 1 WHERE EXISTS (SELECT 1 FROM products WHERE business_id = ? AND id = ?)
                   AND EXISTS (SELECT 1 FROM store_products WHERE business_id = ? AND id = ?)`,
      params: [tenant.businessId, productId, tenant.businessId, productId],
      error: () => new ProductMissingError("product is not the store's"),
    };
  }

  /** Only a product of this store gets a row: another store's ID writes nothing. */
  private sellingStatement(tenant: Tenant, productId: string, selling: ProductSelling, nowMs: number): D1PreparedStatement {
    const milli = selling.usualQuantity === null ? null : toThousandths(selling.usualQuantity);
    if (milli === 0 || (selling.usualQuantity !== null && milli === null)) throw new Error("usual quantity is not a positive decimal");
    return this.db
      .prepare(
        `INSERT INTO store_product_selling (business_id, product_id, sold_by, usual_quantity_milli, updated_at_ms)
         SELECT business_id, id, ?, ?, ? FROM store_products WHERE business_id = ? AND id = ?
         ON CONFLICT (business_id, product_id) DO UPDATE
           SET sold_by = excluded.sold_by, usual_quantity_milli = excluded.usual_quantity_milli, updated_at_ms = excluded.updated_at_ms`,
      )
      .bind(selling.soldBy, milli, nowMs, tenant.businessId, productId);
  }
}

function compareNames(a: string, b: string): number {
  const ka = productNameKey(a);
  const kb = productNameKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function otherNamesOf(json: string | null): string[] {
  if (json === null) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
  } catch {
    return [];
  }
}
