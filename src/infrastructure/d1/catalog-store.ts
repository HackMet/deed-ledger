import type { CatalogRow, CatalogStore } from "../../application/catalog";
import type { Commit, Tenant } from "../../application/ports";

export class D1CatalogStore implements CatalogStore {
  constructor(private readonly db: D1Database) {}

  async list(tenant: Tenant): Promise<readonly CatalogRow[]> {
    const { results } = await this.db
      .prepare(`SELECT id, canonical_name AS name FROM products WHERE business_id = ? ORDER BY canonical_name COLLATE NOCASE, id`)
      .bind(tenant.businessId)
      .all<{ id: string; name: string }>();
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
    return results.map((product) => {
      const mine = facts.results.filter((fact) => fact.productId === product.id);
      const confirmedAt = mine.findIndex((fact) => fact.status === "confirmed");
      const proposed = mine.slice(0, confirmedAt === -1 ? undefined : confirmedAt).find((fact) => fact.status === "proposed");
      return {
        id: product.id,
        name: product.name,
        price: confirmedAt === -1 ? null : mine[confirmedAt]!.price,
        proposed: proposed?.price ?? null,
      };
    });
  }

  async nameTaken(tenant: Tenant, name: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 AS taken FROM products WHERE business_id = ? AND lower(canonical_name) = lower(?)`)
      .bind(tenant.businessId, name)
      .first<{ taken: number }>();
    return row !== null;
  }

  insertProduct(tenant: Tenant, product: { readonly id: string; readonly name: string; readonly nowMs: number }): Commit {
    return {
      guards: [],
      statements: [
        this.db
          .prepare(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) VALUES (?, ?, ?, ?)`)
          .bind(product.id, tenant.businessId, product.name, product.nowMs),
      ],
    };
  }
}
