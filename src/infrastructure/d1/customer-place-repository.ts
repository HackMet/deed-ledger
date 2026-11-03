import { CustomerNotFoundError } from "../../application/errors";
import type { BatchGuard, Commit, CustomerPlaceRepository, Tenant } from "../../application/ports";
import { type Pin, pinFromE6, type SavedPlace, tidyPlaceText, toE6 } from "../../domain/place";

/**
 * A customer's delivery places (#29, migration 0017). Every read and write is scoped to the store
 * and the customer; writes are commits for the job's completion batch and fail loudly when the
 * customer isn't the store's.
 */
export class D1CustomerPlaceRepository implements CustomerPlaceRepository {
  constructor(
    private readonly db: D1Database,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  async latest(tenant: Tenant, customerId: string): Promise<SavedPlace | null> {
    const row = await this.db
      .prepare(
        `SELECT id, place_text, latitude_e6, longitude_e6 FROM customer_places
         WHERE business_id = ? AND customer_id = ?
         ORDER BY last_used_at_ms DESC, created_at_ms DESC, id
         LIMIT 1`,
      )
      .bind(tenant.businessId, customerId)
      .first<{ id: string; place_text: string | null; latitude_e6: number | null; longitude_e6: number | null }>();
    if (row === null) return null;
    return { placeId: row.id, placeText: row.place_text, pin: pinFromE6(row.latitude_e6, row.longitude_e6) };
  }

  saveForOrderCommit(
    tenant: Tenant,
    customerId: string,
    orderId: string,
    place: { readonly placeText: string | null; readonly pin: Pin | null },
    nowMs: number,
  ): Commit {
    const guards = [customerOfStore(tenant, customerId)];
    const placeText = tidyPlaceText(place.placeText);
    if (placeText === null && place.pin === null) return { guards, statements: [] };
    const lat = place.pin === null ? null : toE6(place.pin.latitude);
    const lng = place.pin === null ? null : toE6(place.pin.longitude);
    return {
      guards,
      statements: [
        // The order's place, kept as the customer gave it. The upsert never moves a row to another
        // customer: the conflict only updates the row that belongs to this customer.
        this.db
          .prepare(
            `INSERT INTO customer_places
               (id, business_id, customer_id, place_text, latitude_e6, longitude_e6, order_id, created_at_ms, last_used_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (business_id, order_id) DO UPDATE
               SET place_text = excluded.place_text, latitude_e6 = excluded.latitude_e6,
                   longitude_e6 = excluded.longitude_e6, last_used_at_ms = excluded.last_used_at_ms
               WHERE customer_places.customer_id = excluded.customer_id`,
          )
          .bind(this.newId(), tenant.businessId, customerId, placeText, lat, lng, orderId, nowMs, nowMs),
      ],
    };
  }

  markUsedCommit(tenant: Tenant, customerId: string, placeId: string, nowMs: number): Commit {
    return {
      guards: [customerOfStore(tenant, customerId)],
      statements: [
        this.db
          .prepare(
            `UPDATE customer_places SET last_used_at_ms = MAX(last_used_at_ms, ?)
             WHERE business_id = ? AND customer_id = ? AND id = ?`,
          )
          .bind(nowMs, tenant.businessId, customerId, placeId),
      ],
    };
  }
}

function customerOfStore(tenant: Tenant, customerId: string): BatchGuard {
  return {
    holdsSql: `SELECT 1 FROM customers WHERE business_id = ? AND id = ?`,
    params: [tenant.businessId, customerId],
    error: () => new CustomerNotFoundError(),
  };
}
