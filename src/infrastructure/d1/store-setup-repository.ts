import { fromThousandths } from "../../application/engine/order-engine";
import type { Tenant } from "../../application/ports";
import { type Centavos, toThousandths } from "../../domain/contract/numbers";
import type { StoreHours, StoreHoursEntry } from "../../domain/contract/outcomes";
import { isUsableStoreHours } from "../../domain/store-hours";
import { type ProductSelling, productNameKey, type StoreProduct, type StoreSetup } from "../../domain/store-setup";
import { liveConfirmedPriceSql } from "./catalog-store";

export interface ProductFields {
  readonly name: string;
  readonly otherNames: readonly string[];
  readonly price: Centavos | null;
}

interface ProductRow {
  id: string;
  name: string;
  other_names_json: string;
  price_centavos: number | null;
  no_hay: number;
  sold_by: "unit" | "weight" | null;
  usual_quantity_milli: number | null;
}

/**
 * The store's one product list (0031, `CatalogService`): every `store_products` row with how it's sold
 * (0011: no selling row reads as both unknown), and every `products` row that has no `store_products`
 * row yet (an invoice's product, or one from before 0031) by its canonical name, with its live
 * confirmed price fact as its price (none: unknown) and no "No hay" mark. ?1 is the store, ?2 one
 * product or NULL for all.
 */
const PRODUCTS = `SELECT * FROM (
  SELECT p.id, p.name, p.name_key AS sort_key, p.other_names_json, p.price_centavos, p.no_hay, s.sold_by, s.usual_quantity_milli
  FROM store_products p
  LEFT JOIN store_product_selling s ON s.business_id = p.business_id AND s.product_id = p.id
  WHERE p.business_id = ?1 AND (?2 IS NULL OR p.id = ?2)
  UNION ALL
  SELECT pr.id, pr.canonical_name, lower(pr.canonical_name), '[]', ${liveConfirmedPriceSql("pr")}, 0, NULL, NULL
  FROM products pr
  WHERE pr.business_id = ?1 AND (?2 IS NULL OR pr.id = ?2)
    AND NOT EXISTS (SELECT 1 FROM store_products p WHERE p.business_id = pr.business_id AND p.id = pr.id)
) ORDER BY sort_key, id`;

/**
 * The store's own setup (#40, migration 0019): products, hours and delivery fee. Products are written
 * only by `CatalogService` (the Productos screen), which keeps `products` and `store_products` one
 * list; the product writes below are kept for tests that seed a store directly. Every read and
 * write takes the tenant and is scoped to its store; a product ID from a form only ever matches a
 * row of that store, so another store's ID finds nothing and changes nothing.
 */
export class D1StoreSetupRepository {
  constructor(
    private readonly db: D1Database,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Everything the pretend engine needs, in two reads. */
  async read(tenant: Tenant): Promise<StoreSetup> {
    const [products, settings] = await Promise.all([this.listProducts(tenant), this.settings(tenant)]);
    return { products, ...settings };
  }

  async listProducts(tenant: Tenant): Promise<StoreProduct[]> {
    const { results } = await this.db.prepare(PRODUCTS).bind(tenant.businessId, null).all<ProductRow>();
    return results.map(productOf);
  }

  async product(tenant: Tenant, productId: string): Promise<StoreProduct | null> {
    const row = await this.db.prepare(PRODUCTS).bind(tenant.businessId, productId).first<ProductRow>();
    return row === null ? null : productOf(row);
  }

  /** "exists" when the store already has a product by that name. */
  async addProduct(tenant: Tenant, fields: ProductFields, nowMs: number): Promise<"added" | "exists"> {
    const result = await this.db
      .prepare(
        `INSERT INTO store_products
           (id, business_id, name, name_key, other_names_json, price_centavos, no_hay, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (business_id, name_key) DO NOTHING`,
      )
      .bind(
        this.newId(),
        tenant.businessId,
        fields.name,
        productNameKey(fields.name),
        JSON.stringify(fields.otherNames),
        fields.price,
        nowMs,
        nowMs,
      )
      .run();
    return result.meta.changes === 1 ? "added" : "exists";
  }

  /**
   * The paste box: a new name is added; a name the store already has gets the new price (its other
   * names and "No hay" mark stay). One batch: all of it lands, or none.
   */
  async importProducts(tenant: Tenant, items: readonly { readonly name: string; readonly price: Centavos }[], nowMs: number): Promise<void> {
    if (items.length === 0) return;
    await this.db.batch(
      items.map((item) =>
        this.db
          .prepare(
            `INSERT INTO store_products
               (id, business_id, name, name_key, other_names_json, price_centavos, no_hay, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, '[]', ?, 0, ?, ?)
             ON CONFLICT (business_id, name_key) DO UPDATE
               SET price_centavos = excluded.price_centavos, updated_at_ms = excluded.updated_at_ms`,
          )
          .bind(this.newId(), tenant.businessId, item.name, productNameKey(item.name), item.price, nowMs, nowMs),
      ),
    );
  }

  /**
   * "missing" when the product isn't this store's; "name_taken" when another product has the name.
   * With `selling`, how it's sold is saved in the same batch: all of it lands, or none.
   */
  async updateProduct(
    tenant: Tenant,
    productId: string,
    fields: ProductFields,
    nowMs: number,
    selling?: ProductSelling,
  ): Promise<"saved" | "missing" | "name_taken"> {
    const key = productNameKey(fields.name);
    const clash = await this.db
      .prepare(`SELECT 1 FROM store_products WHERE business_id = ? AND name_key = ? AND id <> ?`)
      .bind(tenant.businessId, key, productId)
      .first();
    if (clash !== null) return "name_taken";
    try {
      const update = this.db
        .prepare(
          `UPDATE store_products SET name = ?, name_key = ?, other_names_json = ?, price_centavos = ?, updated_at_ms = ?
           WHERE business_id = ? AND id = ?`,
        )
        .bind(fields.name, key, JSON.stringify(fields.otherNames), fields.price, nowMs, tenant.businessId, productId);
      const [result] = await this.db.batch(selling === undefined ? [update] : [update, this.sellingStatement(tenant, productId, selling, nowMs)]);
      return result!.meta.changes === 1 ? "saved" : "missing";
    } catch (error) {
      // A rename racing another save of the same name: the UNIQUE rule refused it.
      if (String(error).includes("UNIQUE")) return "name_taken";
      throw error;
    }
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

  async setNoHay(tenant: Tenant, productId: string, noHay: boolean, nowMs: number): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE store_products SET no_hay = ?, updated_at_ms = ? WHERE business_id = ? AND id = ?`)
      .bind(noHay ? 1 : 0, nowMs, tenant.businessId, productId)
      .run();
    return result.meta.changes === 1;
  }

  /** Its aliases and how it's sold go with it (0011, ON DELETE CASCADE). */
  async removeProduct(tenant: Tenant, productId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM store_products WHERE business_id = ? AND id = ?`)
      .bind(tenant.businessId, productId)
      .run();
    // D1 also counts the rows the cascade removed, so any change means this product was removed.
    return result.meta.changes > 0;
  }

  async settings(tenant: Tenant): Promise<{ readonly hours: StoreHours | null; readonly deliveryFee: Centavos | null }> {
    const row = await this.db
      .prepare(`SELECT hours_json, delivery_fee_centavos FROM store_setup_settings WHERE business_id = ?`)
      .bind(tenant.businessId)
      .first<{ hours_json: string | null; delivery_fee_centavos: number | null }>();
    return { hours: hoursOf(row?.hours_json ?? null), deliveryFee: row?.delivery_fee_centavos ?? null };
  }

  /** Null clears the hours (the bot says "te confirmo"). Only a usable schedule is written. */
  async saveHours(tenant: Tenant, hours: StoreHours | null, nowMs: number): Promise<void> {
    if (hours !== null && !isUsableStoreHours(hours)) throw new Error("store hours are not usable");
    const json = hours === null ? null : JSON.stringify(hours.map((e) => ({ days: e.days, opens: e.opens, closes: e.closes })));
    await this.db
      .prepare(
        `INSERT INTO store_setup_settings (business_id, hours_json, delivery_fee_centavos, updated_at_ms) VALUES (?, ?, NULL, ?)
         ON CONFLICT (business_id) DO UPDATE SET hours_json = excluded.hours_json, updated_at_ms = excluded.updated_at_ms`,
      )
      .bind(tenant.businessId, json, nowMs)
      .run();
  }

  async saveDeliveryFee(tenant: Tenant, fee: Centavos | null, nowMs: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO store_setup_settings (business_id, hours_json, delivery_fee_centavos, updated_at_ms) VALUES (?, NULL, ?, ?)
         ON CONFLICT (business_id) DO UPDATE
           SET delivery_fee_centavos = excluded.delivery_fee_centavos, updated_at_ms = excluded.updated_at_ms`,
      )
      .bind(tenant.businessId, fee, nowMs)
      .run();
  }
}

function productOf(row: ProductRow): StoreProduct {
  return {
    productId: row.id,
    name: row.name,
    otherNames: otherNamesOf(row.other_names_json),
    price: row.price_centavos,
    noHay: row.no_hay === 1,
    soldBy: row.sold_by,
    usualQuantity: row.usual_quantity_milli === null ? null : fromThousandths(row.usual_quantity_milli),
  };
}

function otherNamesOf(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
  } catch {
    return [];
  }
}

/** Hours as stored, checked again: anything that isn't a usable schedule reads as unset. */
function hoursOf(json: string | null): StoreHours | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return null;
    const hours: StoreHoursEntry[] = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) return null;
      const { days, opens, closes } = entry as Record<string, unknown>;
      if (!Array.isArray(days) || typeof opens !== "string" || typeof closes !== "string") return null;
      hours.push({ days: days as number[], opens, closes });
    }
    return isUsableStoreHours(hours) ? hours : null;
  } catch {
    return null;
  }
}
