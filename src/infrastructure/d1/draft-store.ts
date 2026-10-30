import type { ReceiptDrafts, StoredReceiptDraft } from "../../application/engine/receipt-handler";
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

  async actorOf(lease: Lease): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT user_id FROM conversations WHERE business_id = ? AND id = ?`)
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
