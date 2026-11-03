import type { SpendLedger, SpendReservation, Tenant } from "../../application/ports";

/** The pilot store's offset: Honduras is UTC-6 all year (no daylight saving). */
const STORE_UTC_OFFSET_MS = -6 * 60 * 60 * 1000;

/** The store's local day for a moment, YYYY-MM-DD. */
export function storeDay(nowMs: number): string {
  return new Date(nowMs + STORE_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The daily cap in D1. Each reservation is one statement (an upsert whose insert and update both
 * check the cap), and D1 runs statements one at a time, so two reservations can't both fit.
 */
export class D1SpendLedger implements SpendLedger {
  constructor(private readonly db: D1Database) {}

  async reserve(tenant: Tenant, nowMs: number, microUsd: number, capMicroUsd: number): Promise<SpendReservation | null> {
    const amount = Math.max(0, Math.ceil(microUsd));
    const day = storeDay(nowMs);
    const result = await this.db
      .prepare(
        `INSERT INTO model_spend (business_id, day, micro_usd, calls, updated_at_ms)
         SELECT ?1, ?2, ?3, 1, ?5 WHERE ?3 <= ?4
         ON CONFLICT (business_id, day) DO UPDATE
           SET micro_usd = micro_usd + excluded.micro_usd, calls = calls + 1, updated_at_ms = excluded.updated_at_ms
           WHERE model_spend.micro_usd + excluded.micro_usd <= ?4`,
      )
      .bind(tenant.businessId, day, amount, capMicroUsd, nowMs)
      .run();
    return result.meta.changes === 1 ? { businessId: tenant.businessId, day, microUsd: amount } : null;
  }

  async settle(reservation: SpendReservation, actualMicroUsd: number): Promise<void> {
    const actual = Math.max(0, Math.ceil(actualMicroUsd));
    await this.db
      .prepare(
        `UPDATE model_spend SET micro_usd = max(0, micro_usd - ?3 + ?4)
         WHERE business_id = ?1 AND day = ?2`,
      )
      .bind(reservation.businessId, reservation.day, reservation.microUsd, actual)
      .run();
  }

  /** Today's spend so far, for tests and the console. */
  async spentMicroUsd(tenant: Tenant, nowMs: number): Promise<number> {
    const row = await this.db
      .prepare(`SELECT micro_usd FROM model_spend WHERE business_id = ?1 AND day = ?2`)
      .bind(tenant.businessId, storeDay(nowMs))
      .first<{ micro_usd: number }>();
    return row?.micro_usd ?? 0;
  }
}
