import { PermanentWriteError } from "../../application/errors";
import type {
  CustomerMessageInput,
  CustomerMessageOutcome,
  IntakeRepository,
  StatusEvent,
  Tenant,
  UnknownMessageInput,
} from "../../application/ports";
import { mediaObjectKey } from "../../domain/media";
import { providerStatusRank, UNKNOWN_SENDER_NOTICE_INTERVAL_MS } from "../../domain/outbox";
import { toE6 } from "../../domain/place";
import { NEXT_OUTBOX_SEQ } from "./outbox-repository";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The conversation of this store number and the sender's customer record in this store. */
const SENDER_CONVERSATION = `c.business_id = ? AND c.channel_account_id = ?
  AND c.customer_id = (SELECT cu.id FROM customers cu WHERE cu.business_id = ? AND cu.phone = ?)`;

/**
 * Intake writes. Duplicates are absorbed with targeted `ON CONFLICT (...) DO NOTHING`, never
 * `INSERT OR IGNORE`, which would also swallow CHECK and NOT NULL violations. Constraint violations
 * surface as PermanentWriteError; anything else is transient.
 */
export class D1IntakeRepository implements IntakeRepository {
  constructor(private readonly db: D1Database) {}

  async recordCustomerMessage(
    tenant: Tenant,
    input: CustomerMessageInput,
  ): Promise<
    | { conversationId: string; customerId: string; outcome: Exclude<CustomerMessageOutcome, "refused"> }
    | { outcome: "refused" }
  > {
    const { event } = input;
    const b = tenant.businessId;
    const phone = event.senderPhone;
    const conversationParams = [b, input.channelAccountId, b, phone];
    // The tombstone check runs inside the batch, so a purge that commits after an earlier read
    // can't be undone by this message: every insert below requires it (#30).
    const notDeleted = `NOT EXISTS (SELECT 1 FROM customer_tombstones t
                                    WHERE t.business_id = ? AND t.sender_hash = ? AND t.deleted_at_ms >= ?)`;
    const notDeletedParams = [b, input.senderHash, event.providerTimestampS * 1000];
    // Admission, checked by the media and message inserts themselves: the message isn't stored yet,
    // and the conversation is under its hourly cap. Both inserts see the same answer (one batch is
    // one transaction), so a message that isn't admitted leaves no media asset behind either.
    const admitted = `${SENDER_CONVERSATION}
      AND NOT EXISTS (SELECT 1 FROM inbound_messages d
                      WHERE d.business_id = c.business_id AND d.provider = 'whatsapp' AND d.provider_message_id = ?)
      AND (SELECT COUNT(*) FROM inbound_messages r
           WHERE r.business_id = c.business_id AND r.conversation_id = c.id AND r.received_at_ms > ?) < ?
      AND ${notDeleted}`;
    const admittedParams = [
      ...conversationParams,
      event.providerMessageId,
      input.receivedAtMs - HOUR_MS,
      input.hourlyCap,
      ...notDeletedParams,
    ];

    const statements: D1PreparedStatement[] = [
      // Whoever writes to the store's number is its customer: one record per store and phone.
      this.db
        .prepare(
          `INSERT INTO customers (id, business_id, phone, created_at_ms) SELECT ?, ?, ?, ? WHERE ${notDeleted}
           ON CONFLICT (business_id, phone) DO NOTHING`,
        )
        .bind(input.newCustomerId, b, phone, input.receivedAtMs, ...notDeletedParams),
      this.db
        .prepare(
          `INSERT INTO conversations (id, business_id, channel_account_id, customer_id, created_at_ms)
           SELECT ?, cu.business_id, ?, cu.id, ? FROM customers cu WHERE cu.business_id = ? AND cu.phone = ? AND ${notDeleted}
           ON CONFLICT (business_id, channel_account_id, customer_id) DO NOTHING`,
        )
        .bind(input.newConversationId, input.channelAccountId, input.receivedAtMs, b, phone, ...notDeletedParams),
    ];
    if (event.media !== null) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO media_assets
               (id, business_id, provider, provider_media_id, mime_type, provider_sha256, object_key,
                state, created_at_ms)
             SELECT ?, c.business_id, 'whatsapp', ?, ?, ?, ?, 'pending', ?
             FROM conversations c WHERE ${admitted}
             ON CONFLICT (business_id, provider, provider_media_id) DO NOTHING`,
          )
          .bind(
            input.newMediaAssetId,
            event.media.providerMediaId,
            event.media.mimeType,
            event.media.sha256,
            mediaObjectKey(b, input.newMediaAssetId),
            input.receivedAtMs,
            ...admittedParams,
          ),
      );
    }
    statements.push(
      this.db
        .prepare(
          `INSERT INTO inbound_messages
             (id, business_id, conversation_id, provider, provider_message_id, provider_timestamp_s,
              order_ts_s, received_at_ms, kind, text_body, reply_id, context_message_id, latitude_e6, longitude_e6,
              media_asset_id, job_state, attempts)
           SELECT ?, c.business_id, c.id, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  (SELECT m.id FROM media_assets m
                   WHERE m.business_id = c.business_id AND m.provider = 'whatsapp' AND m.provider_media_id = ?),
                  'pending', 0
           FROM conversations c WHERE ${admitted}
           ON CONFLICT (business_id, provider, provider_message_id) DO NOTHING`,
        )
        .bind(
          input.newInboundId,
          event.providerMessageId,
          event.providerTimestampS,
          input.orderTsS,
          input.receivedAtMs,
          event.kind,
          event.textBody,
          event.replyId,
          event.contextMessageId,
          event.location == null ? null : toE6(event.location.latitude),
          event.location == null ? null : toE6(event.location.longitude),
          event.media?.providerMediaId ?? null,
          ...admittedParams,
        ),
      // The 24-hour window runs from our receive time of a new message; a redelivery can't move it.
      this.db
        .prepare(
          `UPDATE conversations AS c SET last_inbound_at_ms = MAX(COALESCE(c.last_inbound_at_ms, 0), ?)
           WHERE ${SENDER_CONVERSATION}
             AND EXISTS (SELECT 1 FROM inbound_messages WHERE business_id = ? AND id = ?)`,
        )
        .bind(input.receivedAtMs, ...conversationParams, b, input.newInboundId),
      this.db
        .prepare(
          `SELECT c.id AS conversation_id, c.customer_id,
                  (SELECT i.id FROM inbound_messages i
                   WHERE i.business_id = ? AND i.provider = 'whatsapp' AND i.provider_message_id = ?) AS inbound_id,
                  NOT (${notDeleted}) AS refused
           FROM (SELECT 1) LEFT JOIN conversations c ON ${SENDER_CONVERSATION}`,
        )
        .bind(b, event.providerMessageId, ...notDeletedParams, ...conversationParams),
    );

    const results = await this.batch<{
      conversation_id: string | null;
      customer_id: string | null;
      inbound_id: string | null;
      refused: number;
    }>(statements);
    const row = results.at(-1)?.results[0];
    if (row !== undefined && row.refused === 1) {
      // Nothing above was written (each insert carries the same condition, in the same transaction).
      return { outcome: "refused" };
    }
    if (row === undefined || row.conversation_id === null || row.customer_id === null) {
      throw new Error("conversation missing after intake batch");
    }
    const outcome: Exclude<CustomerMessageOutcome, "refused"> =
      row.inbound_id === input.newInboundId ? "new" : row.inbound_id === null ? "capped" : "duplicate";
    return { conversationId: row.conversation_id, customerId: row.customer_id, outcome };
  }

  async recordUnknownMessage(
    tenant: Tenant,
    input: UnknownMessageInput,
  ): Promise<{ stored: boolean; pendingNoticeId: string | null }> {
    const b = tenant.businessId;
    const sh = input.senderHash;
    const now = input.receivedAtMs;
    const stored = `EXISTS (SELECT 1 FROM unknown_inbound_messages WHERE business_id = ? AND message_hash = ?)`;
    // The 24-hour slot is held only by a notice that was sent (or may have been: unknown_delivery).
    const slotTaken = `EXISTS (SELECT 1 FROM outbound_messages
       WHERE business_id = ? AND recipient_hash = ? AND kind = 'unknown_sender_notice'
         AND (status IN ('pending', 'sending') OR (status IN ('sent', 'unknown_delivery') AND sent_at_ms > ?)))`;
    const slotParams = [b, sh, now - UNKNOWN_SENDER_NOTICE_INTERVAL_MS];

    const results = await this.batch<{ stored: number; notice_id: string | null }>([
      // The hashed record, unless this sender is over today's cap in this store.
      this.db
        .prepare(
          `INSERT INTO unknown_inbound_messages (business_id, message_hash, sender_hash, provider_timestamp_s, received_at_ms)
           SELECT ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM unknown_inbound_messages
                  WHERE business_id = ? AND sender_hash = ? AND received_at_ms > ?) < ?
           ON CONFLICT (business_id, message_hash) DO NOTHING`,
        )
        .bind(b, input.messageHash, sh, input.providerTimestampS, now, b, sh, now - DAY_MS, input.dailyCap),
      // Re-open the newest notice that failed to send, so this message can retry it, with a new expiry.
      this.db
        .prepare(
          `UPDATE outbound_messages SET status = 'pending', updated_at_ms = ?, expires_at_ms = ?
           WHERE id = (SELECT id FROM outbound_messages
                       WHERE business_id = ? AND recipient_hash = ? AND kind = 'unknown_sender_notice'
                         AND status = 'failed'
                       ORDER BY created_at_ms DESC LIMIT 1)
             AND ${stored} AND NOT ${slotTaken}`,
        )
        .bind(now, input.noticeExpiresAtMs, b, sh, b, input.messageHash, ...slotParams),
      // Or create one, if no notice is open, failed or recently sent. One message never creates two.
      this.db
        .prepare(
          `INSERT INTO outbound_messages
             (id, business_id, channel_account_id, recipient_hash, seq, kind, body_text, dedupe_key, status,
              expires_at_ms, created_at_ms, updated_at_ms)
           SELECT ?, ?, ?, ?, ${NEXT_OUTBOX_SEQ}, 'unknown_sender_notice', ?, ?, 'pending', ?, ?, ?
           WHERE ${stored} AND NOT ${slotTaken}
             AND NOT EXISTS (SELECT 1 FROM outbound_messages
                             WHERE business_id = ? AND recipient_hash = ? AND kind = 'unknown_sender_notice'
                               AND status = 'failed')
           ON CONFLICT (dedupe_key) DO NOTHING`,
        )
        .bind(
          input.newNoticeId,
          b,
          input.channelAccountId,
          sh,
          input.noticeBody,
          `unknown_notice:${b}:${input.messageHash}`,
          input.noticeExpiresAtMs,
          now,
          now,
          b,
          input.messageHash,
          ...slotParams,
          b,
          sh,
        ),
      this.db
        .prepare(
          `SELECT ${stored} AS stored,
                  (SELECT id FROM outbound_messages
                   WHERE business_id = ? AND recipient_hash = ? AND kind = 'unknown_sender_notice' AND status = 'pending'
                   ORDER BY created_at_ms DESC LIMIT 1) AS notice_id`,
        )
        .bind(b, input.messageHash, b, sh),
    ]);
    const row = results.at(-1)?.results[0];
    return { stored: row?.stored === 1, pendingNoticeId: row?.stored === 1 ? (row.notice_id ?? null) : null };
  }

  async recordProviderStatus(
    tenant: Tenant,
    event: StatusEvent,
    statusHash: string,
    nowMs: number,
  ): Promise<"applied" | "kept_early" | "unchanged"> {
    const rank = providerStatusRank(event.status);
    const b = tenant.businessId;
    // One batch: either the send result is already stored and the status moves it forward, or the
    // status is kept under a hash until markSent applies it.
    const [applied, kept] = await this.batch([
      this.db
        .prepare(
          `UPDATE outbound_messages
           SET provider_status = ?, provider_status_rank = ?, provider_status_at_s = ?, updated_at_ms = ?
           WHERE business_id = ? AND provider_message_id = ? AND provider_status_rank < ?`,
        )
        .bind(event.status, rank, event.providerTimestampS, nowMs, b, event.providerMessageId, rank),
      this.db
        .prepare(
          `INSERT INTO early_statuses
             (business_id, message_hash, provider_status, provider_status_rank, provider_status_at_s, received_at_ms)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM outbound_messages WHERE business_id = ? AND provider_message_id = ?)
           ON CONFLICT (business_id, message_hash) DO UPDATE SET
             provider_status = excluded.provider_status,
             provider_status_rank = excluded.provider_status_rank,
             provider_status_at_s = excluded.provider_status_at_s
           WHERE excluded.provider_status_rank > early_statuses.provider_status_rank`,
        )
        .bind(b, statusHash, event.status, rank, event.providerTimestampS, nowMs, b, event.providerMessageId),
    ]);
    if (applied?.meta.changes === 1) return "applied";
    if (kept?.meta.changes === 1) return "kept_early";
    return "unchanged";
  }

  private async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    try {
      return await this.db.batch<T>(statements);
    } catch (error) {
      if (error instanceof Error && error.message.includes("SQLITE_CONSTRAINT")) {
        throw new PermanentWriteError(error.message.slice(0, 200));
      }
      throw error;
    }
  }
}
