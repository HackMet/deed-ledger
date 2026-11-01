import { CustomerNotFoundError } from "../../application/errors";
import type {
  BatchGuard,
  Commit,
  ConversationRef,
  CustomerControlRepository,
  CustomerControlState,
  DeletionDue,
  DeletionMedia,
  Tenant,
} from "../../application/ports";

/** What a deleted message's body becomes in the outbox (body_text can't be empty). */
const ERASED_BODY = "-";

/**
 * Customer controls: the first message, ALTO and SEGUIR, and deletion. Gate writes are commits for
 * the job's completion batch, guarded so a customer of another store fails loudly. The purge is its
 * own batch, run by the sweep.
 */
export class D1CustomerControlRepository implements CustomerControlRepository {
  constructor(private readonly db: D1Database) {}

  async stateOf(conversation: ConversationRef): Promise<CustomerControlState | null> {
    const row = await this.db
      .prepare(
        `SELECT cu.id, b.name AS store_name, cu.introduced_at_ms, cu.stopped_at_ms, cu.stop_reminded_at_ms,
                cu.deletion_requested_at_ms,
                (SELECT COALESCE(m.display_name, u.display_name) FROM memberships m JOIN users u ON u.id = m.user_id
                 WHERE m.business_id = c.business_id AND m.role = 'owner' AND m.active = 1
                   AND COALESCE(m.display_name, u.display_name) IS NOT NULL
                 ORDER BY m.created_at_ms, m.user_id LIMIT 1) AS owner_name
         FROM conversations c
         JOIN customers cu ON cu.business_id = c.business_id AND cu.id = c.customer_id
         JOIN businesses b ON b.id = c.business_id
         WHERE c.business_id = ? AND c.id = ?`,
      )
      .bind(conversation.businessId, conversation.conversationId)
      .first<{
        id: string;
        store_name: string;
        owner_name: string | null;
        introduced_at_ms: number | null;
        stopped_at_ms: number | null;
        stop_reminded_at_ms: number | null;
        deletion_requested_at_ms: number | null;
      }>();
    if (row === null) return null;
    return {
      customerId: row.id,
      storeName: row.store_name,
      ownerName: firstName(row.owner_name),
      introducedAtMs: row.introduced_at_ms,
      stoppedAtMs: row.stopped_at_ms,
      stopRemindedAtMs: row.stop_reminded_at_ms,
      deletionRequestedAtMs: row.deletion_requested_at_ms,
    };
  }

  async isStopped(tenant: Tenant, conversationId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS stopped FROM conversations c
         JOIN customers cu ON cu.business_id = c.business_id AND cu.id = c.customer_id
         WHERE c.business_id = ? AND c.id = ? AND cu.stopped_at_ms IS NOT NULL`,
      )
      .bind(tenant.businessId, conversationId)
      .first<{ stopped: number }>();
    return row !== null;
  }

  markIntroducedCommit(tenant: Tenant, customerId: string, nowMs: number, closingJobId: string | null): Commit {
    const written = onlyIfReplyWritten(tenant, closingJobId);
    return this.customerCommit(
      tenant,
      customerId,
      `UPDATE customers SET introduced_at_ms = ?
       WHERE business_id = ? AND id = ? AND introduced_at_ms IS NULL ${written.sql}`,
      [nowMs, tenant.businessId, customerId, ...written.params],
    );
  }

  stopCommit(tenant: Tenant, customerId: string, nowMs: number): Commit {
    return this.customerCommit(
      tenant,
      customerId,
      `UPDATE customers SET stopped_at_ms = ?, stop_reminded_at_ms = NULL
       WHERE business_id = ? AND id = ? AND stopped_at_ms IS NULL`,
      [nowMs, tenant.businessId, customerId],
    );
  }

  resumeCommit(tenant: Tenant, customerId: string): Commit {
    return this.customerCommit(
      tenant,
      customerId,
      `UPDATE customers SET stopped_at_ms = NULL, stop_reminded_at_ms = NULL
       WHERE business_id = ? AND id = ? AND deletion_requested_at_ms IS NULL`,
      [tenant.businessId, customerId],
    );
  }

  markStopRemindedCommit(tenant: Tenant, customerId: string, nowMs: number): Commit {
    return this.customerCommit(
      tenant,
      customerId,
      `UPDATE customers SET stop_reminded_at_ms = ?
       WHERE business_id = ? AND id = ? AND stopped_at_ms IS NOT NULL AND stop_reminded_at_ms IS NULL`,
      [nowMs, tenant.businessId, customerId],
    );
  }

  requestDeletionCommit(tenant: Tenant, customerId: string, nowMs: number): Commit {
    return this.customerCommit(
      tenant,
      customerId,
      `UPDATE customers SET deletion_requested_at_ms = COALESCE(deletion_requested_at_ms, ?),
                            stopped_at_ms = COALESCE(stopped_at_ms, ?)
       WHERE business_id = ? AND id = ? AND deleted_at_ms IS NULL`,
      [nowMs, nowMs, tenant.businessId, customerId],
    );
  }

  async deletionsDue(readyBeforeMs: number, limit: number): Promise<DeletionDue[]> {
    // Spans stores, like the sweep's stranded-job query: it only collects references, and each
    // purge then runs in its own store's scope. Waits for the confirmation to go out first.
    const { results } = await this.db
      .prepare(
        `SELECT cu.business_id, cu.id FROM customers cu
         WHERE cu.deletion_requested_at_ms IS NOT NULL AND cu.deleted_at_ms IS NULL
           AND (cu.deletion_requested_at_ms <= ?
                OR NOT EXISTS (SELECT 1 FROM outbound_messages o
                               JOIN conversations c ON c.business_id = o.business_id AND c.id = o.conversation_id
                               WHERE c.business_id = cu.business_id AND c.customer_id = cu.id
                                 AND o.status IN ('pending', 'sending')))
         ORDER BY cu.deletion_requested_at_ms
         LIMIT ?`,
      )
      .bind(readyBeforeMs, limit)
      .all<{ business_id: string; id: string }>();
    return results.map((row) => ({ businessId: row.business_id, customerId: row.id }));
  }

  async purgedSince(sinceMs: number, limit: number): Promise<DeletionDue[]> {
    // Spans stores like deletionsDue; each erase then runs in its own store's scope.
    const { results } = await this.db
      .prepare(
        `SELECT business_id, id FROM customers WHERE deleted_at_ms IS NOT NULL AND deleted_at_ms >= ?
         ORDER BY deleted_at_ms LIMIT ?`,
      )
      .bind(sinceMs, limit)
      .all<{ business_id: string; id: string }>();
    return results.map((row) => ({ businessId: row.business_id, customerId: row.id }));
  }

  async deletionMedia(tenant: Tenant, customerId: string): Promise<DeletionMedia> {
    const customer = await this.db
      .prepare(`SELECT phone FROM customers WHERE business_id = ? AND id = ?`)
      .bind(tenant.businessId, customerId)
      .first<{ phone: string | null }>();
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT m.object_key FROM media_assets m
         JOIN inbound_messages i ON i.business_id = m.business_id AND i.media_asset_id = m.id
         JOIN conversations c ON c.business_id = i.business_id AND c.id = i.conversation_id
         WHERE c.business_id = ? AND c.customer_id = ?`,
      )
      .bind(tenant.businessId, customerId)
      .all<{ object_key: string }>();
    return { phone: customer?.phone ?? null, mediaPrefixes: results.map((row) => row.object_key) };
  }

  async purge(tenant: Tenant, customerId: string, senderHash: string | null, nowMs: number): Promise<boolean> {
    const b = tenant.businessId;
    // Every statement applies only while the deletion is requested and unfinished; the customer's
    // own row goes last, so its change count says whether this batch did the purge.
    const due = `EXISTS (SELECT 1 FROM customers WHERE business_id = ? AND id = ?
                           AND deletion_requested_at_ms IS NOT NULL AND deleted_at_ms IS NULL)`;
    const theirConversations = `SELECT id FROM conversations WHERE business_id = ? AND customer_id = ?`;
    const statements: D1PreparedStatement[] = [];
    if (senderHash !== null) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO customer_tombstones (business_id, sender_hash, deleted_at_ms)
             SELECT ?, ?, ? WHERE ${due}
             ON CONFLICT (business_id, sender_hash) DO UPDATE SET deleted_at_ms = MAX(deleted_at_ms, excluded.deleted_at_ms)`,
          )
          .bind(b, senderHash, nowMs, b, customerId),
      );
    }
    statements.push(
      // Media references: the provider's ID and hash, and the stored object (already erased from R2).
      this.db
        .prepare(
          `UPDATE media_assets
           SET provider_media_id = 'deleted:' || id, mime_type = NULL, provider_sha256 = NULL, state = 'failed',
               content_sha256 = NULL, stored_key = NULL, byte_size = NULL
           WHERE business_id = ? AND id IN (SELECT media_asset_id FROM inbound_messages
                                            WHERE business_id = ? AND conversation_id IN (${theirConversations}))
             AND ${due}`,
        )
        .bind(b, b, b, customerId, b, customerId),
      // Message text, shared locations and provider IDs (they embed the phone). Unstarted jobs end without a reply.
      this.db
        .prepare(
          `UPDATE inbound_messages
           SET text_body = NULL, reply_id = NULL, context_message_id = NULL, latitude_e6 = NULL, longitude_e6 = NULL,
               provider_message_id = 'deleted:' || id,
               last_error = CASE WHEN job_state = 'pending' THEN 'customer_deleted' ELSE last_error END,
               job_finished_at_ms = CASE WHEN job_state = 'pending' THEN ? ELSE job_finished_at_ms END,
               retry_after_ms = CASE WHEN job_state = 'pending' THEN NULL ELSE retry_after_ms END,
               job_state = CASE WHEN job_state = 'pending' THEN 'failed' ELSE job_state END
           WHERE business_id = ? AND conversation_id IN (${theirConversations}) AND ${due}`,
        )
        .bind(nowMs, b, b, customerId, b, customerId),
      // What we sent them (it can carry their name and order), the provider IDs, and anything unsent.
      this.db
        .prepare(
          `UPDATE outbound_messages
           SET body_text = ?, provider_message_id = NULL, claims_json = NULL, buttons_json = NULL,
               last_error = CASE WHEN status IN ('pending', 'waiting_window') THEN 'customer_deleted' ELSE last_error END,
               status = CASE WHEN status IN ('pending', 'waiting_window') THEN 'failed' ELSE status END,
               updated_at_ms = ?
           WHERE business_id = ? AND conversation_id IN (${theirConversations}) AND ${due}`,
        )
        .bind(ERASED_BODY, nowMs, b, b, customerId, b, customerId),
      // Their saved delivery places (#29): what they wrote and where they are.
      this.db
        .prepare(`DELETE FROM customer_places WHERE business_id = ? AND customer_id = ? AND ${due}`)
        .bind(b, customerId, b, customerId),
      // Their Pendientes: the owner's list no longer points at them.
      this.db
        .prepare(`DELETE FROM conversation_pendientes WHERE business_id = ? AND conversation_id IN (${theirConversations}) AND ${due}`)
        .bind(b, b, customerId, b, customerId),
      this.db
        .prepare(
          `UPDATE conversations SET last_readback_order_id = NULL, last_readback_version = NULL, last_readback_at_ms = NULL
           WHERE business_id = ? AND customer_id = ? AND ${due}`,
        )
        .bind(b, customerId, b, customerId),
      this.db
        .prepare(
          `UPDATE customers
           SET phone = NULL, name = NULL, name_saved_at_ms = NULL, name_asked_at_ms = NULL, deleted_at_ms = ?
           WHERE business_id = ? AND id = ? AND deletion_requested_at_ms IS NOT NULL AND deleted_at_ms IS NULL`,
        )
        .bind(nowMs, b, customerId),
    );
    const results = await this.db.batch(statements);
    return results[results.length - 1]!.meta.changes === 1;
  }

  private customerCommit(tenant: Tenant, customerId: string, sql: string, params: readonly unknown[]): Commit {
    return {
      guards: [customerOfStore(tenant, customerId)],
      statements: [this.db.prepare(sql).bind(...params)],
    };
  }
}

/** The first word of a display name, so "quiero hablar con Johan" stays short. */
function firstName(displayName: string | null): string | null {
  const first = displayName?.trim().split(/\s+/u)[0];
  return first === undefined || first === "" ? null : first;
}

/**
 * With a closing job: no other job of its conversation is open, the same check that withholds a
 * burst-closing reply (see customer-repository's onlyIfReplyWritten). So "introduced" is saved
 * only when the reply carrying the introduction is written.
 */
function onlyIfReplyWritten(tenant: Tenant, closingJobId: string | null): { sql: string; params: unknown[] } {
  if (closingJobId === null) return { sql: "", params: [] };
  return {
    sql: `AND NOT EXISTS (SELECT 1 FROM inbound_messages j JOIN inbound_messages n
                            ON n.business_id = j.business_id AND n.conversation_id = j.conversation_id
                          WHERE j.business_id = ? AND j.id = ? AND n.id <> j.id
                            AND n.job_state IN ('pending', 'processing'))`,
    params: [tenant.businessId, closingJobId],
  };
}

function customerOfStore(tenant: Tenant, customerId: string): BatchGuard {
  return {
    holdsSql: `SELECT 1 FROM customers WHERE business_id = ? AND id = ?`,
    params: [tenant.businessId, customerId],
    error: () => new CustomerNotFoundError(),
  };
}
