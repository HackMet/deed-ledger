/**
 * Demo stores in D1 (migration 0032). Opening one writes the store, its owner, the owner's console
 * session and the demo row in one batch: a visitor gets all of it or none. Every read is scoped to a
 * business ID that starts with "demo-", so nothing here can open or read a real store.
 */
import type { DemoStoreCounts, DemoStoreWriter, NewDemoStore } from "../../application/demo-store";
import type { ReplyButton } from "../../domain/replies";
import type { BatchGuard } from "../../application/ports";
import { DemoLimitError } from "../../application/demo-store";
import {
  DEMO_BUSINESS_PREFIX,
  DEMO_STORES_PER_HOUR,
  DEMO_STORES_PER_VISITOR_PER_HOUR,
  DEMO_STORES_TOTAL,
  HOUR_MS,
  isDemoBusiness,
} from "../../domain/demo";
import { guardedBatch } from "./fence";
import { readButtonSet } from "./outbox-repository";

export interface DemoStore {
  readonly businessId: string;
  readonly phoneNumberId: string;
  readonly customerPhone: string;
  readonly expiresAtMs: number;
}

export class D1DemoStoreRepository implements DemoStoreWriter {
  constructor(private readonly db: D1Database) {}

  /**
   * How many demo stores this visitor, and everyone, opened in the hour before `nowMs`, and how many
   * are open at `nowMs` (not yet expired). Expired stores never count toward the total.
   */
  async recentCounts(visitorHash: string, nowMs: number): Promise<DemoStoreCounts> {
    const since = nowMs - HOUR_MS;
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT count(*) FROM demo_stores WHERE visitor_hash = ?1 AND created_at_ms > ?2) AS visitor,
           (SELECT count(*) FROM demo_stores WHERE created_at_ms > ?2) AS everyone,
           (SELECT count(*) FROM demo_stores WHERE expires_at_ms > ?3) AS open`,
      )
      .bind(visitorHash, since, nowMs)
      .first<{ visitor: number; everyone: number; open: number }>();
    return { visitor: row?.visitor ?? 0, everyone: row?.everyone ?? 0, open: row?.open ?? 0 };
  }

  async create(store: NewDemoStore): Promise<void> {
    if (!isDemoBusiness(store.businessId)) throw new Error("a demo store's ID must start with demo-");
    const { nowMs } = store;
    // The limits again, inside the batch: two visits that both read "under the limit" can't both open
    // a store past it. The batch fails as a whole, and the visitor gets the limit page.
    const underLimits: BatchGuard = {
      holdsSql: `SELECT CASE WHEN
          (SELECT count(*) FROM demo_stores WHERE visitor_hash = ? AND created_at_ms > ?) < ?
          AND (SELECT count(*) FROM demo_stores WHERE created_at_ms > ?) < ?
          AND (SELECT count(*) FROM demo_stores WHERE expires_at_ms > ?) < ? THEN 1 END`,
      params: [
        store.visitorHash,
        nowMs - HOUR_MS,
        DEMO_STORES_PER_VISITOR_PER_HOUR,
        nowMs - HOUR_MS,
        DEMO_STORES_PER_HOUR,
        nowMs,
        DEMO_STORES_TOTAL,
      ],
      error: () => new DemoLimitError(),
    };
    await guardedBatch(this.db, [underLimits], [
      this.db.prepare(`INSERT INTO businesses (id, name, created_at_ms) VALUES (?, ?, ?)`).bind(store.businessId, store.storeName, nowMs),
      this.db
        .prepare(`INSERT INTO locations (id, business_id, name, created_at_ms) VALUES (?, ?, 'Principal', ?)`)
        .bind(store.locationId, store.businessId, nowMs),
      this.db
        .prepare(
          `INSERT INTO channel_accounts (id, business_id, location_id, provider, phone_number_id, created_at_ms)
           VALUES (?, ?, ?, 'whatsapp', ?, ?)`,
        )
        .bind(store.channelAccountId, store.businessId, store.locationId, store.phoneNumberId, nowMs),
      this.db
        .prepare(`INSERT INTO users (id, phone, display_name, created_at_ms) VALUES (?, ?, ?, ?)`)
        .bind(store.ownerUserId, store.ownerPhone, store.ownerName, nowMs),
      // The visitor has read the voice-note notice by choosing the demo: login goes straight to the console.
      this.db
        .prepare(
          `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms, voice_notice_seen_at_ms)
           VALUES (?, ?, ?, 'owner', ?, ?)`,
        )
        .bind(store.businessId, store.ownerUserId, store.locationId, nowMs, nowMs),
      this.db
        .prepare(
          `INSERT INTO console_sessions (id, business_id, user_id, token_hash, created_at_ms, expires_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(store.sessionId, store.businessId, store.ownerUserId, store.sessionTokenHash, nowMs, store.expiresAtMs),
      this.db
        .prepare(
          `INSERT INTO demo_stores (business_id, customer_phone, visitor_hash, created_at_ms, expires_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(store.businessId, store.customerPhone, store.visitorHash, nowMs, store.expiresAtMs),
    ]);
  }

  /**
   * How many messages this demo store's phone has sent: the per-store limit counts them. Only the
   * visitor's phone: the store's seeded customers (demo-history.ts) never use up the visitor's turns.
   */
  /** Whether this store already recorded a message with this provider ID (a retried phone send). */
  async hasPhoneMessage(store: DemoStore, providerMessageId: string): Promise<boolean> {
    if (!isDemoBusiness(store.businessId)) return false;
    const row = await this.db
      .prepare(`SELECT 1 AS found FROM inbound_messages WHERE business_id = ? AND provider_message_id = ? LIMIT 1`)
      .bind(store.businessId, providerMessageId)
      .first<{ found: number }>();
    return row !== null;
  }

  async messageCount(store: DemoStore): Promise<number> {
    if (!isDemoBusiness(store.businessId)) return 0;
    const row = await this.db
      .prepare(
        `SELECT count(*) AS sent FROM inbound_messages i
         JOIN conversations c ON c.id = i.conversation_id AND c.business_id = i.business_id
         JOIN customers cu ON cu.id = c.customer_id AND cu.business_id = c.business_id
         WHERE i.business_id = ?1 AND cu.phone = ?2`,
      )
      .bind(store.businessId, store.customerPhone)
      .first<{ sent: number }>();
    return row?.sent ?? 0;
  }

  /**
   * Takes one console reading from this demo store's allowance, in one guarded write: true when one
   * was left, false when it's used up, the store expired or the business isn't a demo store.
   */
  takeConsoleRead(businessId: string, limit: number, nowMs: number): Promise<boolean> {
    return this.take("console_reads", businessId, limit, nowMs);
  }

  /**
   * Takes one send from this demo store phone's lifetime allowance, the same way: parallel sends
   * can't pass the limit together. `returnPhoneSend` gives it back when nothing new went in.
   */
  takePhoneSend(store: DemoStore, limit: number, nowMs: number): Promise<boolean> {
    return this.take("phone_sends", store.businessId, limit, nowMs);
  }

  async returnPhoneSend(store: DemoStore): Promise<void> {
    if (!isDemoBusiness(store.businessId)) return;
    await this.db
      .prepare(`UPDATE demo_stores SET phone_sends = phone_sends - 1 WHERE business_id = ?1 AND phone_sends > 0`)
      .bind(store.businessId)
      .run();
  }

  private async take(column: "console_reads" | "phone_sends", businessId: string, limit: number, nowMs: number): Promise<boolean> {
    if (!isDemoBusiness(businessId)) return false;
    const result = await this.db
      .prepare(
        `UPDATE demo_stores SET ${column} = ${column} + 1
         WHERE business_id = ?1 AND business_id LIKE '${DEMO_BUSINESS_PREFIX}%' AND expires_at_ms > ?2 AND ${column} < ?3`,
      )
      .bind(businessId, nowMs, limit)
      .run();
    return result.meta.changes === 1;
  }

  /** The demo store behind a business ID, while it hasn't expired. Never a real store. */
  async find(businessId: string, nowMs: number): Promise<DemoStore | null> {
    if (!isDemoBusiness(businessId)) return null;
    const row = await this.db
      .prepare(
        `SELECT d.business_id, ca.phone_number_id, d.customer_phone, d.expires_at_ms
         FROM demo_stores d
         JOIN channel_accounts ca ON ca.business_id = d.business_id AND ca.provider = 'whatsapp'
         WHERE d.business_id = ?1 AND d.business_id LIKE '${DEMO_BUSINESS_PREFIX}%' AND d.expires_at_ms > ?2`,
      )
      .bind(businessId, nowMs)
      .first<{ business_id: string; phone_number_id: string; customer_phone: string; expires_at_ms: number }>();
    if (row === null) return null;
    return { businessId: row.business_id, phoneNumberId: row.phone_number_id, customerPhone: row.customer_phone, expiresAtMs: row.expires_at_ms };
  }

  /**
   * What seeding a demo store's history needs, read back from the store itself: its number, its owner
   * and when it opened. Only a live demo store; never a real one.
   */
  async seedTarget(businessId: string, nowMs: number): Promise<DemoSeedTarget | null> {
    if (!isDemoBusiness(businessId)) return null;
    const row = await this.db
      .prepare(
        `SELECT d.business_id, ca.phone_number_id, m.user_id, d.created_at_ms
         FROM demo_stores d
         JOIN channel_accounts ca ON ca.business_id = d.business_id AND ca.provider = 'whatsapp'
         JOIN memberships m ON m.business_id = d.business_id AND m.role = 'owner'
         WHERE d.business_id = ?1 AND d.business_id LIKE '${DEMO_BUSINESS_PREFIX}%' AND d.expires_at_ms > ?2
         ORDER BY m.created_at_ms LIMIT 1`,
      )
      .bind(businessId, nowMs)
      .first<{ business_id: string; phone_number_id: string; user_id: string; created_at_ms: number }>();
    if (row === null) return null;
    return { businessId: row.business_id, phoneNumberId: row.phone_number_id, ownerUserId: row.user_id, openedAtMs: row.created_at_ms };
  }

  /**
   * The demo phone's chat, oldest first: what the customer sent and what the store answered, after
   * `afterMs`. Only this store's synthetic customer's conversation.
   */
  async chat(store: DemoStore, afterMs: number): Promise<DemoChatLine[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM (
           SELECT 'in' AS side, i.id AS id, i.received_at_ms AS at_ms, i.kind AS kind, i.text_body AS body, NULL AS buttons_json
           FROM inbound_messages i
           JOIN conversations c ON c.id = i.conversation_id AND c.business_id = i.business_id
           JOIN customers cu ON cu.id = c.customer_id AND cu.business_id = c.business_id
           WHERE i.business_id = ?1 AND cu.phone = ?2 AND i.received_at_ms > ?3
           UNION ALL
           SELECT 'out' AS side, o.id AS id, o.created_at_ms AS at_ms, 'text' AS kind, o.body_text AS body, o.buttons_json AS buttons_json
           FROM outbound_messages o
           JOIN conversations c ON c.id = o.conversation_id AND c.business_id = o.business_id
           JOIN customers cu ON cu.id = c.customer_id AND cu.business_id = c.business_id
           WHERE o.business_id = ?1 AND cu.phone = ?2 AND o.created_at_ms > ?3
         ) ORDER BY at_ms, side DESC
         LIMIT 200`,
      )
      .bind(store.businessId, store.customerPhone, afterMs)
      .all<{ side: "in" | "out"; id: string; at_ms: number; kind: string; body: string | null; buttons_json: string | null }>();
    return results.map((row) => ({
      side: row.side,
      id: row.id,
      atMs: row.at_ms,
      kind: row.kind,
      body: row.body,
      buttons: row.buttons_json === null ? [] : readButtonSet(row.buttons_json).buttons,
    }));
  }
}

export interface DemoSeedTarget {
  readonly businessId: string;
  readonly phoneNumberId: string;
  readonly ownerUserId: string;
  readonly openedAtMs: number;
}

export interface DemoChatLine {
  readonly side: "in" | "out";
  readonly id: string;
  readonly atMs: number;
  readonly kind: string;
  readonly body: string | null;
  readonly buttons: readonly ReplyButton[];
}
