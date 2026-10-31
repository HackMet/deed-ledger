import { BurstAlreadyReadError, BurstTooLargeError, JobConflictError, PermanentWriteError, StaleSnapshotError } from "../../application/errors";
import type {
  Commit,
  ConversationRef,
  Job,
  JobRepository,
  JobSnapshot,
  Lease,
  LeaseClaim,
  MediaAssetForJob,
  OutboxDraft,
  StoredMedia,
  Tenant,
} from "../../application/ports";
import { BURST_MAX_MESSAGES } from "../../domain/burst";
import { MAX_JOB_ATTEMPTS, type MessageKind } from "../../domain/processing";
import { DB_NOW_MS, fencedBatch, type Guard, jobGuard, leaseIsHeld } from "./fence";
import { NEXT_OUTBOX_SEQ } from "./outbox-repository";

/** Job preconditions, checked inside the transition's batch. */
const STARTABLE = `attempts < ? AND (
  (job_state = 'pending' AND (retry_after_ms IS NULL OR retry_after_ms <= ?))
  OR (job_state = 'processing' AND job_lease_id IS NOT ?))`;
const RUNNING_UNDER_LEASE = `job_state = 'processing' AND job_lease_id = ?`;
const ABANDONABLE = `job_state IN ('pending', 'processing') AND attempts >= ? AND job_lease_id IS NOT ?`;

/**
 * Nothing that sorts before job `j` (the snapshot's order: order_ts_s, received_at_ms, id) is open
 * in its conversation: `j` is next. A round's earlier jobs are done before a later one starts, so
 * what this finds arrived after the round's snapshot.
 */
const NEXT_IN_ORDER = `NOT EXISTS (SELECT 1 FROM inbound_messages n
  WHERE n.business_id = j.business_id AND n.conversation_id = j.conversation_id
    AND n.job_state IN ('pending', 'processing') AND n.id <> j.id
    AND (n.order_ts_s < j.order_ts_s
         OR (n.order_ts_s = j.order_ts_s
             AND (n.received_at_ms < j.received_at_ms OR (n.received_at_ms = j.received_at_ms AND n.id < j.id)))))`;

/** No job of the conversation `c` is open but the completing one (id ?): it is the burst's last. */
const NO_OTHER_OPEN_JOB = `NOT EXISTS (SELECT 1 FROM inbound_messages n
  WHERE n.business_id = c.business_id AND n.conversation_id = c.id AND n.job_state IN ('pending', 'processing')
    AND n.id <> ?)`;

const JOB_COLUMNS = `id, kind, text_body, reply_id, context_message_id, media_asset_id, order_ts_s,
  received_at_ms, attempts, retry_after_ms`;

interface JobRow {
  id: string;
  kind: MessageKind;
  text_body: string | null;
  reply_id: string | null;
  context_message_id: string | null;
  media_asset_id: string | null;
  order_ts_s: number;
  received_at_ms: number;
  attempts: number;
  retry_after_ms: number | null;
}

const toJob = (row: JobRow): Job => ({
  id: row.id,
  kind: row.kind,
  textBody: row.text_body,
  replyId: row.reply_id,
  contextMessageId: row.context_message_id,
  mediaAssetId: row.media_asset_id,
  orderTsS: row.order_ts_s,
  receivedAtMs: row.received_at_ms,
  attempts: row.attempts,
  retryAfterMs: row.retry_after_ms,
});

export class D1JobRepository implements JobRepository {
  constructor(private readonly db: D1Database) {}

  async claimLease(conversation: ConversationRef, leaseId: string, ttlMs: number): Promise<LeaseClaim> {
    const result = await this.db
      .prepare(
        `UPDATE conversations SET lease_id = ?, lease_until_ms = ${DB_NOW_MS} + ?
         WHERE business_id = ? AND id = ? AND (lease_id IS NULL OR lease_until_ms <= ${DB_NOW_MS})`,
      )
      .bind(leaseId, ttlMs, conversation.businessId, conversation.conversationId)
      .run();
    if (result.meta.changes === 1) return "claimed";
    const exists = await this.db
      .prepare(`SELECT 1 AS found FROM conversations WHERE business_id = ? AND id = ?`)
      .bind(conversation.businessId, conversation.conversationId)
      .first<{ found: number }>();
    return exists === null ? "missing" : "busy";
  }

  async extendLease(lease: Lease, ttlMs: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE conversations SET lease_until_ms = ${DB_NOW_MS} + ?
         WHERE business_id = ? AND id = ? AND lease_id = ? AND lease_until_ms > ${DB_NOW_MS}`,
      )
      .bind(ttlMs, lease.businessId, lease.conversationId, lease.leaseId)
      .run();
    return result.meta.changes === 1;
  }

  async releaseLease(lease: Lease): Promise<void> {
    await this.db
      .prepare(
        `UPDATE conversations SET lease_id = NULL, lease_until_ms = NULL
         WHERE business_id = ? AND id = ? AND lease_id = ?`,
      )
      .bind(lease.businessId, lease.conversationId, lease.leaseId)
      .run();
  }

  holdsLease(lease: Lease): Promise<boolean> {
    return leaseIsHeld(this.db, lease);
  }

  async snapshot(conversation: ConversationRef, settledBeforeMs: number, limit: number): Promise<JobSnapshot> {
    // One statement, so the settle decision and the job list see the same data.
    const { results } = await this.db
      .prepare(
        `WITH open AS (
           SELECT rowid AS seq, ${JOB_COLUMNS} FROM inbound_messages
           WHERE business_id = ? AND conversation_id = ? AND job_state IN ('pending', 'processing')),
         summary AS (
           SELECT COUNT(*) AS open_count, MAX(received_at_ms) AS newest_ms, COALESCE(MAX(seq), 0) AS max_seq FROM open)
         SELECT s.open_count, s.newest_ms, s.max_seq, o.*
         FROM summary s
         LEFT JOIN (SELECT * FROM open ORDER BY order_ts_s, received_at_ms, id LIMIT ?) o ON s.newest_ms <= ?
         ORDER BY o.order_ts_s, o.received_at_ms, o.id`,
      )
      .bind(conversation.businessId, conversation.conversationId, limit, settledBeforeMs)
      .all<JobRow & { open_count: number; newest_ms: number | null; max_seq: number }>();
    const first = results[0];
    return {
      openCount: first?.open_count ?? 0,
      newestReceivedAtMs: first?.newest_ms ?? null,
      seq: first?.max_seq ?? 0,
      jobs: results.filter((row) => row.id !== null).map(toJob),
    };
  }

  async hasArrivalsAfter(conversation: ConversationRef, seq: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS found FROM inbound_messages
         WHERE business_id = ? AND conversation_id = ? AND job_state IN ('pending', 'processing') AND rowid > ?
         LIMIT 1`,
      )
      .bind(conversation.businessId, conversation.conversationId, seq)
      .first<{ found: number }>();
    return row !== null;
  }

  async getMediaAsset(tenant: Tenant, assetId: string): Promise<MediaAssetForJob | null> {
    const row = await this.db
      .prepare(
        `SELECT m.id, m.provider_media_id, m.object_key, m.state, m.stored_key, ca.phone_number_id
         FROM media_assets m
         JOIN inbound_messages i ON i.business_id = m.business_id AND i.media_asset_id = m.id
         JOIN conversations c ON c.business_id = i.business_id AND c.id = i.conversation_id
         JOIN channel_accounts ca ON ca.business_id = c.business_id AND ca.id = c.channel_account_id
         WHERE m.business_id = ? AND m.id = ?
         LIMIT 1`,
      )
      .bind(tenant.businessId, assetId)
      .first<{
        id: string;
        provider_media_id: string;
        object_key: string;
        state: MediaAssetForJob["state"];
        stored_key: string | null;
        phone_number_id: string;
      }>();
    if (row === null) return null;
    return {
      id: row.id,
      providerMediaId: row.provider_media_id,
      prefix: row.object_key,
      state: row.state,
      storedKey: row.stored_key,
      phoneNumberId: row.phone_number_id,
    };
  }

  async startJob(lease: Lease, jobId: string, nowMs: number): Promise<void> {
    const startable = jobGuard(lease, jobId, STARTABLE, [MAX_JOB_ATTEMPTS, nowMs, lease.leaseId]);
    await fencedBatch(this.db, lease, [startable, nextInOrder(lease, jobId)], [
      this.db
        .prepare(
          `UPDATE inbound_messages
           SET job_state = 'processing', attempts = attempts + 1, job_lease_id = ?, job_started_at_ms = ?,
               retry_after_ms = NULL, last_error = NULL
           WHERE business_id = ? AND conversation_id = ? AND id = ?`,
        )
        .bind(lease.leaseId, nowMs, lease.businessId, lease.conversationId, jobId),
    ]);
  }

  async publishMedia(lease: Lease, jobId: string, assetId: string, stored: StoredMedia, nowMs: number): Promise<void> {
    const assetPending: Guard = {
      holdsSql: `SELECT 1 FROM media_assets m
                 JOIN inbound_messages i ON i.business_id = m.business_id AND i.media_asset_id = m.id
                 WHERE m.business_id = ? AND m.id = ? AND i.id = ? AND m.state = 'pending'`,
      params: [lease.businessId, assetId, jobId],
      error: () => new JobConflictError(),
    };
    await fencedBatch(this.db, lease, [this.runningGuard(lease, jobId), assetPending], [
      this.db
        .prepare(
          `UPDATE media_assets
           SET state = 'stored', stored_key = ?, content_sha256 = ?, byte_size = ?, stored_at_ms = ?
           WHERE business_id = ? AND id = ?`,
        )
        .bind(stored.key, stored.sha256, stored.size, nowMs, lease.businessId, assetId),
    ]);
  }

  async completeJob(
    lease: Lease,
    jobId: string,
    nowMs: number,
    replies: readonly OutboxDraft[],
    closesBurst: boolean,
    commits: readonly Commit[] = [],
  ): Promise<number> {
    // Ignoring a post guard would save a fact nobody checked: refuse until the fence runs them.
    if (commits.some((commit) => (commit.post?.length ?? 0) > 0)) {
      throw new PermanentWriteError("post guards are not supported yet");
    }
    const commitStatements = commits.flatMap((commit) => commit.statements);
    // The lease and job guards come first: a stale writer gets StaleWriteError, not a commit's error.
    const guards = [this.runningGuard(lease, jobId), ...commits.flatMap((commit) => commit.guards)];
    const results = await fencedBatch(this.db, lease, guards, [
      this.db
        .prepare(
          `UPDATE inbound_messages SET job_state = 'done', job_finished_at_ms = ?
           WHERE business_id = ? AND conversation_id = ? AND id = ?`,
        )
        .bind(nowMs, lease.businessId, lease.conversationId, jobId),
      ...commitStatements,
      // The job's replies are one group: when they close the burst, every one carries the same check.
      ...replies.map((reply) => this.outboxInsert(lease, jobId, reply, nowMs, closesBurst)),
    ]);
    const inserted = results.slice(1 + commitStatements.length);
    return inserted.filter((result) => result.meta.changes === 1).length;
  }

  async deferJob(lease: Lease, jobId: string, errorCode: string, retryAfterMs: number): Promise<void> {
    await fencedBatch(this.db, lease, [this.runningGuard(lease, jobId)], [
      this.db
        .prepare(
          `UPDATE inbound_messages SET job_state = 'pending', retry_after_ms = ?, last_error = ?
           WHERE business_id = ? AND conversation_id = ? AND id = ?`,
        )
        .bind(retryAfterMs, errorCode, lease.businessId, lease.conversationId, jobId),
    ]);
  }

  async failJob(
    lease: Lease,
    jobId: string,
    errorCode: string,
    nowMs: number,
    replies: readonly OutboxDraft[],
  ): Promise<void> {
    await fencedBatch(this.db, lease, [this.runningGuard(lease, jobId)], [
      this.failStatement(lease, jobId, errorCode, nowMs),
      ...replies.map((reply) => this.outboxInsert(lease, jobId, reply, nowMs)),
    ]);
  }

  async abandonJob(
    lease: Lease,
    jobId: string,
    errorCode: string,
    nowMs: number,
    replies: readonly OutboxDraft[],
  ): Promise<void> {
    await fencedBatch(
      this.db,
      lease,
      [jobGuard(lease, jobId, ABANDONABLE, [MAX_JOB_ATTEMPTS, lease.leaseId])],
      [
        this.failStatement(lease, jobId, errorCode, nowMs),
        ...replies.map((reply) => this.outboxInsert(lease, jobId, reply, nowMs)),
      ],
    );
  }

  async findStrandedConversations(cutoffMs: number, nowMs: number, limit: number): Promise<ConversationRef[]> {
    // The one query that spans stores: the sweep only collects references, and each conversation
    // is then processed under its own store's scope.
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT i.business_id, i.conversation_id
         FROM inbound_messages i
         JOIN conversations c ON c.business_id = i.business_id AND c.id = i.conversation_id
         WHERE i.job_state IN ('pending', 'processing') AND i.received_at_ms <= ?
           AND (i.retry_after_ms IS NULL OR i.retry_after_ms <= ?)
           AND (c.lease_id IS NULL OR c.lease_until_ms <= ${DB_NOW_MS})
         LIMIT ?`,
      )
      .bind(cutoffMs, nowMs, limit)
      .all<{ business_id: string; conversation_id: string }>();
    return results.map((row) => ({ businessId: row.business_id, conversationId: row.conversation_id }));
  }

  async unreadBurst(lease: Lease, throughJobId: string, sinceMs: number): Promise<Job[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM inbound_messages i
         WHERE i.business_id = ? AND i.conversation_id = ? AND i.received_at_ms >= ?
           AND (i.job_state = 'done' OR (i.id = ? AND i.job_state = 'processing' AND i.job_lease_id = ?))
           AND NOT EXISTS (SELECT 1 FROM burst_reads r WHERE r.business_id = i.business_id AND r.inbound_message_id = i.id)
           AND (i.order_ts_s, i.received_at_ms, i.id) <= (SELECT t.order_ts_s, t.received_at_ms, t.id
                                                          FROM inbound_messages t
                                                          WHERE t.business_id = i.business_id
                                                            AND t.conversation_id = i.conversation_id AND t.id = ?)
         ORDER BY i.order_ts_s, i.received_at_ms, i.id
         LIMIT ?`,
      )
      .bind(lease.businessId, lease.conversationId, sinceMs, throughJobId, lease.leaseId, throughJobId, BURST_MAX_MESSAGES + 1)
      .all<JobRow>();
    // Never a partial burst: the rest would stay unread with no job left to read it.
    if (results.length > BURST_MAX_MESSAGES) throw new BurstTooLargeError();
    return results.map(toJob);
  }

  async nextOpenJob(lease: Lease, afterJobId: string): Promise<Job | null> {
    const row = await this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM inbound_messages n
         WHERE n.business_id = ? AND n.conversation_id = ? AND n.job_state IN ('pending', 'processing') AND n.id <> ?
           AND (n.order_ts_s, n.received_at_ms, n.id) > (SELECT t.order_ts_s, t.received_at_ms, t.id
                                                         FROM inbound_messages t
                                                         WHERE t.business_id = n.business_id
                                                           AND t.conversation_id = n.conversation_id AND t.id = ?)
         ORDER BY n.order_ts_s, n.received_at_ms, n.id
         LIMIT 1`,
      )
      .bind(lease.businessId, lease.conversationId, afterJobId, afterJobId)
      .first<JobRow>();
    return row === null ? null : toJob(row);
  }

  markReadCommit(lease: Lease, readerJobId: string, messageIds: readonly string[], nowMs: number): Commit {
    if (messageIds.length === 0) return { guards: [], statements: [] };
    // One JSON parameter, so a long burst stays under D1's limit on bound parameters.
    const ids = JSON.stringify(messageIds);
    const inBurst = `id IN (SELECT value FROM json_each(?))`;
    return {
      guards: [
        {
          holdsSql: `SELECT 1 WHERE (SELECT COUNT(*) FROM inbound_messages
                                     WHERE business_id = ? AND conversation_id = ? AND ${inBurst}) = ?`,
          params: [lease.businessId, lease.conversationId, ids, new Set(messageIds).size],
          error: () => new Error("burst message outside the leased conversation"),
        },
        {
          holdsSql: `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM burst_reads
                                                WHERE business_id = ? AND inbound_message_id IN (SELECT value FROM json_each(?)))`,
          params: [lease.businessId, ids],
          error: () => new BurstAlreadyReadError(),
        },
      ],
      statements: [
        this.db
          .prepare(
            `INSERT INTO burst_reads (business_id, inbound_message_id, conversation_id, read_by_job_id, read_at_ms)
             SELECT business_id, id, conversation_id, ?, ? FROM inbound_messages
             WHERE business_id = ? AND conversation_id = ? AND ${inBurst}`,
          )
          .bind(readerJobId, nowMs, lease.businessId, lease.conversationId, ids),
      ],
    };
  }

  private runningGuard(lease: Lease, jobId: string): Guard {
    return jobGuard(lease, jobId, RUNNING_UNDER_LEASE, [lease.leaseId]);
  }

  private failStatement(lease: Lease, jobId: string, errorCode: string, nowMs: number): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE inbound_messages
         SET job_state = 'failed', job_lease_id = ?, last_error = ?, job_finished_at_ms = ?, retry_after_ms = NULL
         WHERE business_id = ? AND conversation_id = ? AND id = ?`,
      )
      .bind(lease.leaseId, errorCode, nowMs, lease.businessId, lease.conversationId, jobId);
  }

  /**
   * A reply to the conversation's member, sent later by the outbox dispatcher, in send order and
   * grouped with the job's other replies. With `onlyIfLastOpenJob` (the job's replies close the
   * burst) it is written only if no other job of the conversation is open, checked here, inside the
   * batch. Every reply of the group sees the same answer, so they are written together or not at all.
   */
  private outboxInsert(
    conversation: ConversationRef,
    jobId: string,
    reply: OutboxDraft,
    nowMs: number,
    onlyIfLastOpenJob = false,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO outbound_messages
           (id, business_id, channel_account_id, conversation_id, seq, job_id, reply_index, part_index, kind,
            body_text, dedupe_key, status, expires_at_ms, created_at_ms, updated_at_ms, claims_json, buttons_json)
         SELECT ?, c.business_id, c.channel_account_id, c.id, ${NEXT_OUTBOX_SEQ}, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?
         FROM conversations c WHERE c.business_id = ? AND c.id = ?
           ${onlyIfLastOpenJob ? `AND ${NO_OTHER_OPEN_JOB}` : ""}
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .bind(
        reply.id,
        jobId,
        reply.replyIndex,
        reply.partIndex,
        reply.kind,
        reply.body,
        reply.dedupeKey,
        reply.expiresAtMs,
        nowMs,
        nowMs,
        reply.claims === undefined || reply.claims.length === 0 ? null : JSON.stringify(reply.claims),
        reply.buttons === undefined || reply.buttons.length === 0 ? null : JSON.stringify(reply.buttons),
        conversation.businessId,
        conversation.conversationId,
        ...(onlyIfLastOpenJob ? [jobId] : []),
      );
  }
}

/**
 * The job is its conversation's next message in order (see NEXT_IN_ORDER). When it isn't, the
 * round's snapshot is stale: a message that belongs ahead of it arrived after the snapshot.
 */
function nextInOrder(lease: Lease, jobId: string): Guard {
  return {
    holdsSql: `SELECT 1 FROM inbound_messages j
               WHERE j.business_id = ? AND j.conversation_id = ? AND j.id = ? AND ${NEXT_IN_ORDER}`,
    params: [lease.businessId, lease.conversationId, jobId],
    error: () => new StaleSnapshotError(),
  };
}
