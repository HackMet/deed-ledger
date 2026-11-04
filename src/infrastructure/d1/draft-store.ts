import type { ReceiptDrafts, StoredReceiptDraft } from "../../application/engine/receipt-handler";
import { productNameKey } from "../../domain/store-setup";
import type { Lease } from "../../application/ports";
import type { ReceiptClaim } from "../../domain/receipt";

export class D1ReceiptDrafts implements ReceiptDrafts {
  constructor(private readonly db: D1Database) {}

  async propose(lease: Lease, draft: Parameters<ReceiptDrafts["propose"]>[1]): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO drafts (id, business_id, conversation_id, kind, revision, state, payload_json,
           source_inbound_id, source_media_asset_id, expires_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 'receipt', 1, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        draft.id,
        lease.businessId,
        lease.conversationId,
        JSON.stringify(draft.claim),
        draft.sourceInboundId,
        draft.sourceMediaAssetId,
        draft.expiresAtMs,
        draft.nowMs,
        draft.nowMs,
      )
      .run();
  }

  async latest(lease: Lease): Promise<StoredReceiptDraft | null> {
    const row = await this.db
      .prepare(
        `SELECT id, revision, state, payload_json, source_inbound_id, source_media_asset_id, expires_at_ms
         FROM drafts WHERE business_id = ? AND conversation_id = ? AND kind = 'receipt'
         ORDER BY created_at_ms DESC, rowid DESC LIMIT 1`,
      )
      .bind(lease.businessId, lease.conversationId)
      .first<{
        id: string;
        revision: number;
        state: StoredReceiptDraft["state"];
        payload_json: string;
        source_inbound_id: string;
        source_media_asset_id: string | null;
        expires_at_ms: number;
      }>();
    if (row === null) return null;
    return {
      id: row.id,
      revision: row.revision,
      state: row.state,
      claim: JSON.parse(row.payload_json) as ReceiptClaim,
      sourceInboundId: row.source_inbound_id,
      sourceMediaAssetId: row.source_media_asset_id,
      expiresAtMs: row.expires_at_ms,
    };
  }

  /**
   * The store member writing in this conversation: conversations belong to customers (0004), so the
   * member is found by the customer's WhatsApp number among this store's active memberships. Null
   * when the writer isn't one of the store's members.
   */
  async actorOf(lease: Lease): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT m.user_id FROM conversations c
         JOIN customers cu ON cu.business_id = c.business_id AND cu.id = c.customer_id
         JOIN users u ON u.phone = cu.phone
         JOIN memberships m ON m.business_id = c.business_id AND m.user_id = u.id AND m.active = 1
         WHERE c.business_id = ? AND c.id = ?`,
      )
      .bind(lease.businessId, lease.conversationId)
      .first<{ user_id: string }>();
    return row?.user_id ?? null;
  }

  async ensureProducts(lease: Lease, names: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const found = new Map<string, string>();
    for (const name of names) {
      await this.db
        .prepare(
          `INSERT INTO products (id, business_id, canonical_name, created_at_ms)
           SELECT lower(hex(randomblob(16))), ?1, ?2, CAST(unixepoch('subsec') * 1000 AS INTEGER)
           WHERE NOT EXISTS (SELECT 1 FROM products WHERE business_id = ?1 AND canonical_name = ?2)`,
        )
        .bind(lease.businessId, name)
        .run();
      const row = await this.db
        .prepare(`SELECT id FROM products WHERE business_id = ? AND canonical_name = ? ORDER BY created_at_ms, id LIMIT 1`)
        .bind(lease.businessId, name)
        .first<{ id: string }>();
      // One product list (0031): its Productos row too, same ID, no price. Skipped when it can't be made
      // (a name too long for it, or another product has the name); the list still reads it from `products`.
      await this.db
        .prepare(
          `INSERT OR IGNORE INTO store_products
             (id, business_id, name, name_key, other_names_json, price_centavos, no_hay, created_at_ms, updated_at_ms)
           SELECT id, business_id, canonical_name, ?, '[]', NULL, 0, created_at_ms, created_at_ms FROM products
           WHERE business_id = ? AND id = ?`,
        )
        .bind(productNameKey(name), lease.businessId, row!.id)
        .run();
      found.set(name, row!.id);
    }
    return found;
  }

  async mediaSha256(lease: Lease, assetId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT content_sha256 FROM media_assets WHERE business_id = ? AND id = ? AND state = 'stored'`)
      .bind(lease.businessId, assetId)
      .first<{ content_sha256: string | null }>();
    return row?.content_sha256 ?? null;
  }
}
