import type { ConsoleReceiptDraft, ReceiptDraftStore } from "../../application/receipts";
import { FactRefusedError, PermanentWriteError } from "../../application/errors";
import type { Commit, Tenant } from "../../application/ports";
import { isUnderStorePrefix } from "../../domain/media";
import { CONSOLE_CONVERSATION, type CatalogEntry, type ReceiptDraftBody } from "../../domain/receipt-draft";
import { productNameKey } from "../../domain/store-setup";

/** Console invoice drafts (`drafts` rows in the 'console' conversation) and what the ledger says of them. */
export class D1ConsoleReceipts implements ReceiptDraftStore {
  constructor(
    private readonly db: D1Database,
    private readonly bucket: R2Bucket,
  ) {}

  async catalog(tenant: Tenant): Promise<readonly CatalogEntry[]> {
    const { results } = await this.db
      .prepare(`SELECT id, canonical_name AS name FROM products WHERE business_id = ? ORDER BY canonical_name COLLATE NOCASE, id`)
      .bind(tenant.businessId)
      .all<{ id: string; name: string }>();
    return results.map((row) => ({ id: row.id, name: row.name, aliases: [] }));
  }

  private select(where: string) {
    // The receipt an approval wrote (facts.draft_id), whether a cancellation closed it, and a decline's reason.
    return `SELECT d.id, d.revision, d.state, d.payload_json, d.source_media_key, d.source_media_sha256, d.created_at_ms, d.expires_at_ms,
        r.id AS receipt_id,
        EXISTS (SELECT 1 FROM fact_closures c WHERE c.business_id = d.business_id AND c.fact_id = r.id) AS receipt_cancelled,
        (SELECT json_extract(v.body_json, '$.reason') FROM facts v
          WHERE v.business_id = d.business_id AND v.kind = 'receipt_review' AND json_extract(v.body_json, '$.draftId') = d.id) AS declined_reason
      FROM drafts d
      LEFT JOIN facts r ON r.business_id = d.business_id AND r.kind = 'receipt' AND r.draft_id = d.id
      WHERE d.business_id = ? AND d.conversation_id = '${CONSOLE_CONVERSATION}' AND d.kind = 'receipt' AND ${where}`;
  }

  private static toDraft(row: Row): ConsoleReceiptDraft {
    return {
      id: row.id,
      revision: row.revision,
      state: row.state,
      body: JSON.parse(row.payload_json) as ReceiptDraftBody,
      mediaKey: row.source_media_key,
      mediaSha256: row.source_media_sha256,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
      receipt: row.receipt_id === null ? null : { factId: row.receipt_id, cancelled: row.receipt_cancelled === 1 },
      declined: row.declined_reason === null ? null : { reason: row.declined_reason },
    };
  }

  async get(tenant: Tenant, draftId: string): Promise<ConsoleReceiptDraft | null> {
    const row = await this.db.prepare(this.select("d.id = ?")).bind(tenant.businessId, draftId).first<Row>();
    return row === null ? null : D1ConsoleReceipts.toDraft(row);
  }

  async list(tenant: Tenant): Promise<readonly ConsoleReceiptDraft[]> {
    const { results } = await this.db
      .prepare(`${this.select("1 = 1")} ORDER BY d.created_at_ms DESC, d.rowid DESC LIMIT 50`)
      .bind(tenant.businessId)
      .all<Row>();
    return results.map((row) => D1ConsoleReceipts.toDraft(row));
  }

  async create(tenant: Tenant, draft: Parameters<ReceiptDraftStore["create"]>[1]): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO drafts (id, business_id, conversation_id, kind, revision, state, payload_json, source_member_id,
           source_media_key, source_media_sha256, expires_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 'receipt', 1, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        draft.id,
        tenant.businessId,
        CONSOLE_CONVERSATION,
        JSON.stringify(draft.body),
        draft.memberId,
        draft.mediaKey,
        draft.mediaSha256,
        draft.expiresAtMs,
        draft.nowMs,
        draft.nowMs,
      )
      .run();
  }

  async revise(tenant: Tenant, draftId: string, fromRevision: number, body: ReceiptDraftBody, nowMs: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE drafts SET revision = revision + 1, payload_json = ?, updated_at_ms = ?
         WHERE business_id = ? AND conversation_id = ? AND id = ? AND kind = 'receipt' AND state = 'pending' AND revision = ?`,
      )
      .bind(JSON.stringify(body), nowMs, tenant.businessId, CONSOLE_CONVERSATION, draftId, fromRevision)
      .run();
    return result.meta.changes === 1;
  }

  async image(tenant: Tenant, key: string): Promise<{ readonly bytes: ArrayBuffer; readonly contentType: string } | null> {
    if (!isUnderStorePrefix(tenant.businessId, key)) return null;
    const object = await this.bucket.get(key);
    if (object === null) return null;
    return { bytes: await object.arrayBuffer(), contentType: object.httpMetadata?.contentType ?? "application/octet-stream" };
  }

  productsCommit(tenant: Tenant, created: readonly { readonly id: string; readonly name: string }[], matched: readonly string[], nowMs: number): Commit {
    return {
      guards: [
        {
          holdsSql: `SELECT CASE WHEN (SELECT count(*) FROM products WHERE business_id = ? AND id IN (SELECT value FROM json_each(?))) = ? THEN 1 END`,
          params: [tenant.businessId, JSON.stringify(matched), matched.length],
          error: () => new PermanentWriteError("a matched product is not the store's"),
        },
      ],
      // One product list (0031): a product an invoice creates gets its Productos row too, same ID, no
      // price (an invoice's cost is not the selling price). Skipped, never failing the invoice, when the
      // name is too long for it or another product has the name; the list still reads it from `products`.
      statements: created.flatMap((product) => [
        this.db
          .prepare(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) VALUES (?, ?, ?, ?)`)
          .bind(product.id, tenant.businessId, product.name, nowMs),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO store_products
               (id, business_id, name, name_key, other_names_json, price_centavos, no_hay, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, '[]', NULL, 0, ?, ?)`,
          )
          .bind(product.id, tenant.businessId, product.name, productNameKey(product.name), nowMs, nowMs),
      ]),
    };
  }

  declineCommit(tenant: Tenant, draftId: string, revision: number, nowMs: number): Commit {
    return {
      guards: [
        {
          holdsSql: `SELECT 1 FROM drafts WHERE business_id = ? AND conversation_id = ? AND id = ? AND state = 'pending' AND revision = ?
                       AND expires_at_ms > ?`,
          params: [tenant.businessId, CONSOLE_CONVERSATION, draftId, revision, nowMs],
          error: () => new FactRefusedError("draft_not_pending"),
        },
      ],
      statements: [
        this.db
          .prepare(`UPDATE drafts SET state = 'cancelled', updated_at_ms = ? WHERE business_id = ? AND id = ?`)
          .bind(nowMs, tenant.businessId, draftId),
      ],
    };
  }

  async shortfalls(tenant: Tenant, receiptFactId: string): Promise<readonly string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT p.canonical_name AS name FROM stock_movements m
         JOIN products p ON p.business_id = m.business_id AND p.id = m.product_id
         LEFT JOIN stock_balances b ON b.business_id = m.business_id AND b.product_id = m.product_id
         WHERE m.business_id = ? AND m.fact_id = ?
         GROUP BY m.product_id HAVING COALESCE(max(b.qty_milli), 0) < sum(m.qty_milli)
         ORDER BY p.canonical_name`,
      )
      .bind(tenant.businessId, receiptFactId)
      .all<{ name: string }>();
    return results.map((row) => row.name);
  }
}

interface Row {
  id: string;
  revision: number;
  state: ConsoleReceiptDraft["state"];
  payload_json: string;
  source_media_key: string;
  source_media_sha256: string;
  created_at_ms: number;
  expires_at_ms: number;
  receipt_id: string | null;
  receipt_cancelled: number;
  declined_reason: string | null;
}
