/**
 * Finds a store's order from what a customer or a staff member types: the order code (`#ABCDE` or
 * `ABCDE`, any case) or the reference a customer's message carries (8 hex, optionally `Ref. ` before it).
 * Read-only. Every query is scoped to the store, so another store's order is never found: the code
 * alone is never trusted. Two orders can share a code; the newer order wins.
 */
import type { Tenant } from "../../application/ports";
import { orderCode } from "../../domain/order-code";
import { orderRef } from "../../domain/order-ref";

export type OrderQuery = { readonly kind: "code"; readonly code: string } | { readonly kind: "ref"; readonly ref: string };

const CODE = /^[0-9A-HJKMNP-TV-Z]{5}$/;
const REF = /^[0-9a-f]{8}$/;

/** What was typed, read as a code or a reference; null when it is neither. */
export function parseOrderQuery(raw: string): OrderQuery | null {
  const text = raw.trim().replace(/^ref\.\s*/i, "");
  const code = text.replace(/^#/, "").toUpperCase();
  if (CODE.test(code)) return { kind: "code", code: `#${code}` };
  const ref = text.toLowerCase();
  if (REF.test(ref)) return { kind: "ref", ref };
  return null;
}

export class D1OrderLookup {
  constructor(private readonly db: D1Database) {}

  /** The store's order the typed text names, or null when there is none. */
  async find(tenant: Tenant, raw: string): Promise<string | null> {
    const query = parseOrderQuery(raw);
    if (query === null) return null;
    const { results: orders } = await this.db
      .prepare(`SELECT id FROM orders WHERE business_id = ?1 ORDER BY created_at_ms DESC, id`)
      .bind(tenant.businessId)
      .all<{ id: string }>();
    if (query.kind === "ref") return orders.find((order) => orderRef(order.id) === query.ref)?.id ?? null;
    // An approved change confirms again and the code moves on, but the customer may still hold the earlier one.
    const { results: confirms } = await this.db
      .prepare(
        `SELECT json_extract(body_json, '$.orderId') AS order_id, id FROM facts
         WHERE business_id = ?1 AND kind = 'order_confirm' ORDER BY recorded_at_ms DESC, rowid DESC`,
      )
      .bind(tenant.businessId)
      .all<{ order_id: string; id: string }>();
    const known = new Set(orders.map((order) => order.id));
    for (const confirm of confirms) {
      if (known.has(confirm.order_id) && (await orderCode(confirm.id)) === query.code) return confirm.order_id;
    }
    return null;
  }
}
