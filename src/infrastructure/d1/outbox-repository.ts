import { ClaimLostError, NoticeConversationMissingError } from "../../application/errors";
import type {
  ButtonsShown,
  Commit,
  ConsoleNoticeDraft,
  ConversationRef,
  OutboxMaintenance,
  OutboxMessage,
  OutboxRepository,
  QueuedConsoleNotice,
  Tenant,
} from "../../application/ports";
import {
  CUSTOMER_SERVICE_WINDOW_MS,
  EARLY_STATUS_TTL_MS,
  UNKNOWN_NOTICE_ABANDON_AFTER_MS,
  UNKNOWN_SENDER_NOTICE_INTERVAL_MS,
  UNKNOWN_SENDER_RETENTION_MS,
} from "../../domain/outbox";
import { type ButtonExtras, buttonExtras, type ClaimCheck, type ReplyButton } from "../../domain/replies";
import { DB_NOW_MS, type Guard, guardedBatch } from "./fence";

/** The next send order: one more than any row's. D1 runs one batch at a time, and seq is UNIQUE. */
export const NEXT_OUTBOX_SEQ = `(SELECT COALESCE(MAX(seq), 0) + 1 FROM outbound_messages)`;

/** An earlier row of the same conversation that hasn't settled: it holds back the rows after it. */
const unsettledEarlierInConversation = (row: string) => `EXISTS (SELECT 1 FROM outbound_messages p
  WHERE p.business_id = ${row}.business_id AND p.conversation_id = ${row}.conversation_id AND p.seq < ${row}.seq
    AND p.status IN ('pending', 'waiting_window', 'sending'))`;

/**
 * Two rows in one group: one job's replies, or one console action's notices to one conversation
 * (their operation key). Rows with neither (the slow notice) are in no group: NULL never equals.
 */
const sameGroup = (a: string, b: string) =>
  `(${a}.job_id = ${b}.job_id OR (${a}.operation_key = ${b}.operation_key AND ${a}.conversation_id = ${b}.conversation_id))`;

/** An earlier row of the same group that ended unsent: the rest never go out. */
const unsentEarlierInGroup = (row: string) => `EXISTS (SELECT 1 FROM outbound_messages p
  WHERE p.business_id = ${row}.business_id AND ${sameGroup("p", row)} AND p.seq < ${row}.seq
    AND p.status IN ('failed', 'expired', 'unknown_delivery'))`;

/** The row is still being sent under this claim: what markSent and every settle require. */
function claimHeld(tenant: Tenant, outboxId: string, claimId: string): Guard {
  return {
    holdsSql: `SELECT 1 FROM outbound_messages WHERE business_id = ? AND id = ? AND status = 'sending' AND claim_id = ?`,
    params: [tenant.businessId, outboxId, claimId],
    error: () => new ClaimLostError(),
  };
}

interface OutboxRow {
  id: string;
  business_id: string;
  channel_account_id: string;
  conversation_id: string | null;
  recipient_hash: string | null;
  kind: string;
  body_text: string;
  attempts: number;
  expires_at_ms: number;
  claims_json: string | null;
  buttons_json: string | null;
}

const COLUMN_NAMES = [
  "id",
  "business_id",
  "channel_account_id",
  "conversation_id",
  "recipient_hash",
  "kind",
  "body_text",
  "attempts",
  "expires_at_ms",
  "claims_json",
  "buttons_json",
];
const COLUMNS = COLUMN_NAMES.join(", ");

const toMessage = (row: OutboxRow): OutboxMessage => ({
  id: row.id,
  businessId: row.business_id,
  channelAccountId: row.channel_account_id,
  conversationId: row.conversation_id,
  recipientHash: row.recipient_hash,
  kind: row.kind,
  body: row.body_text,
  attempts: row.attempts,
  expiresAtMs: row.expires_at_ms,
  ...(row.claims_json === null ? {} : { claims: readClaims(row.claims_json) }),
  ...(row.buttons_json === null ? {} : readButtonSet(row.buttons_json)),
});

/** A check that never holds: what stored claims we can't read amount to. */
const UNREADABLE_CLAIMS: readonly ClaimCheck[] = [{ anyOf: [] }];

function readClaims(json: string): readonly ClaimCheck[] {
  try {
    const value: unknown = JSON.parse(json);
    const valid =
      Array.isArray(value) &&
      value.every(
        (check: unknown) =>
          typeof check === "object" &&
          check !== null &&
          Array.isArray((check as { anyOf?: unknown }).anyOf) &&
          (check as { anyOf: unknown[] }).anyOf.every(
            (claim) => typeof claim === "object" && claim !== null && typeof (claim as { type?: unknown }).type === "string",
          ),
      );
    return valid ? (value as ClaimCheck[]) : UNREADABLE_CLAIMS;
  } catch {
    return UNREADABLE_CLAIMS;
  }
}

/**
 * buttons_json: the buttons as a JSON array; with a footer or a text fallback, an object
 * `{ "buttons": [...], "footer": "...", "textFallback": "..." }` (Nov 3). Null without buttons.
 */
export function buttonsJson(row: { readonly buttons?: readonly ReplyButton[] } & ButtonExtras): string | null {
  if (row.buttons === undefined || row.buttons.length === 0) return null;
  const extras = buttonExtras(row);
  return Object.keys(extras).length === 0 ? JSON.stringify(row.buttons) : JSON.stringify({ buttons: row.buttons, ...extras });
}

type ButtonSet = { readonly buttons: readonly ReplyButton[] } & ButtonExtras;

/**
 * buttons_json read back, in either shape. Buttons we can't read are dropped, with what goes with
 * them; the body then goes as plain text with its text fallback, when one was stored.
 */
export function readButtonSet(json: string): ButtonSet {
  try {
    const value: unknown = JSON.parse(json);
    if (Array.isArray(value)) return { buttons: validButtons(value) };
    if (typeof value !== "object" || value === null) return { buttons: [] };
    const set = value as { buttons?: unknown; footer?: unknown; textFallback?: unknown };
    const buttons = Array.isArray(set.buttons) ? validButtons(set.buttons) : [];
    const textFallback = typeof set.textFallback === "string" ? { textFallback: set.textFallback } : {};
    if (buttons.length === 0) return { buttons, ...textFallback };
    return { buttons, ...(typeof set.footer === "string" ? { footer: set.footer } : {}), ...textFallback };
  } catch {
    return { buttons: [] };
  }
}

function validButtons(value: readonly unknown[]): readonly ReplyButton[] {
  const valid = value.every(
    (b: unknown) =>
      typeof b === "object" && b !== null && typeof (b as { id?: unknown }).id === "string" && typeof (b as { title?: unknown }).title === "string",
  );
  return valid ? (value as ReplyButton[]) : [];
}

/**
 * The buttons on the last message queued to a conversation before a time (#7 typed numbers, typed
 * yes): the newest row that wasn't left unsent, if it carried buttons. The slow notice doesn't
 * count: it's queued after the customer wrote. Scoped by store and conversation.
 */
export class D1ButtonsShown implements ButtonsShown {
  constructor(private readonly db: D1Database) {}

  async lastButtons(conversation: ConversationRef, beforeMs: number): Promise<readonly ReplyButton[]> {
    const row = await this.db
      .prepare(
        `SELECT buttons_json FROM outbound_messages
         WHERE business_id = ? AND conversation_id = ? AND created_at_ms < ?
           AND kind <> 'slow_notice' AND status NOT IN ('failed', 'expired')
         ORDER BY seq DESC LIMIT 1`,
      )
      .bind(conversation.businessId, conversation.conversationId, beforeMs)
      .first<{ buttons_json: string | null }>();
    return row?.buttons_json == null ? [] : readButtonSet(row.buttons_json).buttons;
  }
}

export class D1OutboxRepository implements OutboxRepository {
  constructor(private readonly db: D1Database) {}

  async listDispatchable(nowMs: number, limit: number, conversation?: ConversationRef): Promise<OutboxMessage[]> {
    // Only the oldest unsettled row of each conversation is a candidate, and only while its window
    // is open, so rows that can't go out now never fill the page and starve the ones that can.
    const scope = conversation === undefined ? "" : "AND o.business_id = ? AND o.conversation_id = ?";
    const scopeParams = conversation === undefined ? [] : [conversation.businessId, conversation.conversationId];
    const { results } = await this.db
      .prepare(
        `SELECT ${COLUMN_NAMES.map((column) => `o.${column}`).join(", ")}
         FROM outbound_messages o
         JOIN conversations c ON c.business_id = o.business_id AND c.id = o.conversation_id
         WHERE o.status IN ('pending', 'waiting_window')
           AND c.last_inbound_at_ms > ?
           AND NOT ${unsettledEarlierInConversation("o")}
           ${scope}
         ORDER BY o.seq
         LIMIT ?`,
      )
      .bind(nowMs - CUSTOMER_SERVICE_WINDOW_MS, ...scopeParams, limit)
      .all<OutboxRow>();
    return results.map(toMessage);
  }

  async get(tenant: Tenant, outboxId: string): Promise<OutboxMessage | null> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM outbound_messages WHERE business_id = ? AND id = ?`)
      .bind(tenant.businessId, outboxId)
      .first<OutboxRow>();
    return row === null ? null : toMessage(row);
  }

  async claim(
    tenant: Tenant,
    outboxId: string,
    claimId: string,
    ttlMs: number,
    nowMs: number,
  ): Promise<OutboxMessage | null> {
    // Never a row in "sending": if its sender died, the outcome is unknown. Never ahead of an
    // earlier row of its conversation, and never after its group stopped.
    const row = await this.db
      .prepare(
        `UPDATE outbound_messages
         SET status = 'sending', claim_id = ?, claim_until_ms = ${DB_NOW_MS} + ?, attempts = attempts + 1,
             updated_at_ms = ?
         WHERE business_id = ? AND id = ? AND status IN ('pending', 'waiting_window')
           AND NOT ${unsettledEarlierInConversation("outbound_messages")}
           AND NOT ${unsentEarlierInGroup("outbound_messages")}
         RETURNING ${COLUMNS}`,
      )
      .bind(claimId, ttlMs, nowMs, tenant.businessId, outboxId)
      .first<OutboxRow>();
    return row === null ? null : toMessage(row);
  }

  async confirmClaim(tenant: Tenant, outboxId: string, claimId: string, ttlMs: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE outbound_messages SET claim_until_ms = ${DB_NOW_MS} + ?
         WHERE business_id = ? AND id = ? AND status = 'sending' AND claim_id = ? AND claim_until_ms > ${DB_NOW_MS}`,
      )
      .bind(ttlMs, tenant.businessId, outboxId, claimId)
      .run();
    return result.meta.changes === 1;
  }

  async lastInboundAtMs(message: OutboxMessage): Promise<number | null> {
    if (message.conversationId !== null) {
      const row = await this.db
        .prepare(`SELECT last_inbound_at_ms AS at FROM conversations WHERE business_id = ? AND id = ?`)
        .bind(message.businessId, message.conversationId)
        .first<{ at: number | null }>();
      return row?.at ?? null;
    }
    const row = await this.db
      .prepare(
        `SELECT MAX(received_at_ms) AS at FROM unknown_inbound_messages WHERE business_id = ? AND sender_hash = ?`,
      )
      .bind(message.businessId, message.recipientHash)
      .first<{ at: number | null }>();
    return row?.at ?? null;
  }

  async customerPhone(tenant: Tenant, conversationId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT cu.phone FROM conversations c
         JOIN customers cu ON cu.business_id = c.business_id AND cu.id = c.customer_id
         WHERE c.business_id = ? AND c.id = ?`,
      )
      .bind(tenant.businessId, conversationId)
      .first<{ phone: string | null }>();
    return row?.phone ?? null;
  }

  async markSent(
    tenant: Tenant,
    outboxId: string,
    claimId: string,
    providerMessageId: string | null,
    statusHash: string | null,
    nowMs: number,
  ): Promise<boolean> {
    const stored = this.db
      .prepare(
        `UPDATE outbound_messages
         SET status = 'sent', provider_message_id = ?, sent_at_ms = ?, updated_at_ms = ?, claim_id = NULL,
             claim_until_ms = NULL, last_error = NULL
         WHERE business_id = ? AND id = ? AND status = 'sending' AND claim_id = ?`,
      )
      .bind(providerMessageId, nowMs, nowMs, tenant.businessId, outboxId, claimId);
    // A delivery status that arrived before this result was stored: applied, then cleared. The claim
    // guard makes both depend on this call's own transition.
    const earlyStatus =
      statusHash === null
        ? []
        : [
            this.db
              .prepare(
                `UPDATE outbound_messages
                 SET provider_status = e.provider_status, provider_status_rank = e.provider_status_rank,
                     provider_status_at_s = e.provider_status_at_s
                 FROM early_statuses e
                 WHERE outbound_messages.business_id = ? AND outbound_messages.id = ?
                   AND e.business_id = outbound_messages.business_id AND e.message_hash = ?
                   AND e.provider_status_rank > outbound_messages.provider_status_rank`,
              )
              .bind(tenant.businessId, outboxId, statusHash),
            this.db
              .prepare(`DELETE FROM early_statuses WHERE business_id = ? AND message_hash = ?`)
              .bind(tenant.businessId, statusHash),
          ];
    return this.whileClaimed(claimHeld(tenant, outboxId, claimId), [stored, ...earlyStatus]);
  }

  async markWaitingWindow(tenant: Tenant, outboxId: string, claimId: string, nowMs: number): Promise<boolean> {
    return this.settle(tenant, outboxId, claimId, nowMs, `status = 'waiting_window', attempts = attempts - 1`, [], false);
  }

  async markExpired(tenant: Tenant, outboxId: string, claimId: string, nowMs: number): Promise<boolean> {
    return this.settle(tenant, outboxId, claimId, nowMs, `status = 'expired', attempts = attempts - 1`, [], true);
  }

  async markUnknownDelivery(
    tenant: Tenant,
    outboxId: string,
    claimId: string,
    errorCode: string,
    nowMs: number,
  ): Promise<boolean> {
    return this.settle(
      tenant,
      outboxId,
      claimId,
      nowMs,
      `status = 'unknown_delivery', sent_at_ms = ?, last_error = ?`,
      [nowMs, errorCode.slice(0, 200)],
      true,
    );
  }

  async release(
    tenant: Tenant,
    outboxId: string,
    claimId: string,
    errorCode: string,
    final: boolean,
    nowMs: number,
  ): Promise<boolean> {
    return this.settle(
      tenant,
      outboxId,
      claimId,
      nowMs,
      `status = ?, last_error = ?`,
      [final ? "failed" : "pending", errorCode.slice(0, 200)],
      final,
    );
  }

  async markClaimsBlocked(tenant: Tenant, outboxId: string, claimId: string, nowMs: number): Promise<boolean> {
    const blocked = this.db
      .prepare(
        `UPDATE outbound_messages SET claims_blocked_at_ms = ?, updated_at_ms = ?
         WHERE business_id = ? AND id = ? AND status = 'sending' AND claim_id = ?`,
      )
      .bind(nowMs, nowMs, tenant.businessId, outboxId, claimId);
    // The reply's later parts carry the same claims: none of them goes out. Other replies of the
    // job have claims of their own and are checked on their own.
    const restOfReply = this.db
      .prepare(
        `UPDATE outbound_messages SET status = 'failed', last_error = 'claims_blocked_in_reply', updated_at_ms = ?
         WHERE business_id = ? AND status IN ('pending', 'waiting_window')
           AND EXISTS (SELECT 1 FROM outbound_messages b
                       WHERE b.business_id = outbound_messages.business_id AND b.id = ?
                         AND ${sameGroup("b", "outbound_messages")} AND b.reply_index = outbound_messages.reply_index
                         AND b.seq < outbound_messages.seq)`,
      )
      .bind(nowMs, tenant.businessId, outboxId);
    return this.whileClaimed(claimHeld(tenant, outboxId, claimId), [blocked, restOfReply]);
  }

  async maintain(nowMs: number): Promise<OutboxMaintenance> {
    const results = await this.db.batch([
      // Past their expiry: never sent.
      this.db
        .prepare(
          `UPDATE outbound_messages SET status = 'expired', updated_at_ms = ?
           WHERE status IN ('pending', 'waiting_window') AND expires_at_ms <= ?`,
        )
        .bind(nowMs, nowMs),
      // A sender that held a claim past its end (by the database's clock) died mid-send: the
      // outcome is unknown.
      this.db
        .prepare(
          `UPDATE outbound_messages
           SET status = 'unknown_delivery', last_error = 'claim_expired_mid_send', sent_at_ms = ?,
               claim_id = NULL, claim_until_ms = NULL, updated_at_ms = ?
           WHERE status = 'sending' AND claim_until_ms <= ${DB_NOW_MS}`,
        )
        .bind(nowMs, nowMs),
      // The rest of a group whose earlier row just ended unsent never goes out.
      this.stopGroupsAfterUnsent(nowMs),
      // Member replies whose window has closed wait, with their own status, until the member writes.
      this.db
        .prepare(
          `UPDATE outbound_messages SET status = 'waiting_window', updated_at_ms = ?
           WHERE status = 'pending' AND conversation_id IS NOT NULL
             AND COALESCE((SELECT c.last_inbound_at_ms FROM conversations c
                           WHERE c.business_id = outbound_messages.business_id
                             AND c.id = outbound_messages.conversation_id), 0) <= ?`,
        )
        .bind(nowMs, nowMs - CUSTOMER_SERVICE_WINDOW_MS),
      // Notices left pending by a request that died: their phone number is gone.
      this.db
        .prepare(
          `UPDATE outbound_messages SET status = 'failed', last_error = 'recipient_not_retained', updated_at_ms = ?
           WHERE recipient_hash IS NOT NULL AND status = 'pending' AND updated_at_ms <= ?`,
        )
        .bind(nowMs, nowMs - UNKNOWN_NOTICE_ABANDON_AFTER_MS),
      // Retention for numbers that aren't members, and for early statuses. A notice is kept for the
      // retention period after its latest activity, and never while its send still holds the
      // sender's 24-hour slot.
      this.db
        .prepare(`DELETE FROM unknown_inbound_messages WHERE received_at_ms <= ?`)
        .bind(nowMs - UNKNOWN_SENDER_RETENTION_MS),
      this.db
        .prepare(
          `DELETE FROM outbound_messages
           WHERE recipient_hash IS NOT NULL AND status <> 'sending'
             AND MAX(updated_at_ms, COALESCE(sent_at_ms, 0)) <= ? AND NOT (status IN ('sent', 'unknown_delivery') AND sent_at_ms > ?)`,
        )
        .bind(nowMs - UNKNOWN_SENDER_RETENTION_MS, nowMs - UNKNOWN_SENDER_NOTICE_INTERVAL_MS),
      this.db.prepare(`DELETE FROM early_statuses WHERE received_at_ms <= ?`).bind(nowMs - EARLY_STATUS_TTL_MS),
    ]);
    const changes = results.map((result) => result.meta.changes);
    return {
      expired: changes[0] ?? 0,
      unknownDelivery: changes[1] ?? 0,
      predecessorNotSent: changes[2] ?? 0,
      waitingWindow: changes[3] ?? 0,
      abandonedNotices: changes[4] ?? 0,
      pruned: (changes[5] ?? 0) + (changes[6] ?? 0) + (changes[7] ?? 0),
    };
  }

  async conversationOfCustomer(tenant: Tenant, customerId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT id FROM conversations WHERE business_id = ? AND customer_id = ?
         ORDER BY COALESCE(last_inbound_at_ms, 0) DESC, created_at_ms DESC, id LIMIT 1`,
      )
      .bind(tenant.businessId, customerId)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async saveConsoleAction(
    tenant: Tenant,
    operationKey: string,
    commits: readonly Commit[],
    notices: readonly ConsoleNoticeDraft[],
    nowMs: number,
  ): Promise<QueuedConsoleNotice[]> {
    const conversations = [...new Set(notices.map((notice) => notice.conversationId))];
    // The engine's guards first, so a refused decision reports the engine's own error.
    const guards: Guard[] = [
      ...commits.flatMap((commit) => commit.guards),
      ...conversations.map((conversationId) => conversationOfStore(tenant, conversationId)),
    ];
    const commitStatements = commits.flatMap((commit) => commit.statements);
    // The engine's post guards (G4) run after the writes, as in completeJob: one that fails refuses all.
    const results = await guardedBatch(
      this.db,
      guards,
      [...commitStatements, ...notices.map((notice) => this.noticeInsert(tenant, operationKey, notice, nowMs))],
      commits.flatMap((commit) => commit.post ?? []),
    );
    return results.slice(commitStatements.length).flatMap((result, n) => {
      const row = (result.results as { id: string; conversation_id: string; status: string }[])[0];
      const notice = notices[n]!;
      if (row === undefined) return [];
      return [
        {
          outboxId: row.id,
          conversationId: row.conversation_id,
          replyIndex: notice.replyIndex,
          partIndex: notice.partIndex,
          status: row.status === "waiting_window" ? "waiting_window" : "pending",
        } satisfies QueuedConsoleNotice,
      ];
    });
  }

  /**
   * A notice row: no job, grouped by the operation key, in send order after everything already
   * written to the conversation. Written as waiting_window when the 24-hour window is closed, so
   * it goes out when the customer writes again (as maintain would mark it anyway).
   */
  private noticeInsert(
    tenant: Tenant,
    operationKey: string,
    notice: ConsoleNoticeDraft,
    nowMs: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO outbound_messages
           (id, business_id, channel_account_id, conversation_id, seq, job_id, operation_key, reply_index, part_index,
            kind, body_text, dedupe_key, status, expires_at_ms, created_at_ms, updated_at_ms, claims_json, buttons_json)
         SELECT ?, c.business_id, c.channel_account_id, c.id, ${NEXT_OUTBOX_SEQ}, NULL, ?, ?, ?, ?, ?, ?,
                CASE WHEN COALESCE(c.last_inbound_at_ms, 0) > ? THEN 'pending' ELSE 'waiting_window' END,
                ?, ?, ?, ?, ?
         FROM conversations c WHERE c.business_id = ? AND c.id = ?
         ON CONFLICT (dedupe_key) DO NOTHING
         RETURNING id, conversation_id, status`,
      )
      .bind(
        notice.id,
        operationKey,
        notice.replyIndex,
        notice.partIndex,
        notice.kind,
        notice.body,
        notice.dedupeKey,
        nowMs - CUSTOMER_SERVICE_WINDOW_MS,
        notice.expiresAtMs,
        nowMs,
        nowMs,
        notice.claims === undefined || notice.claims.length === 0 ? null : JSON.stringify(notice.claims),
        buttonsJson(notice),
        tenant.businessId,
        notice.conversationId,
      );
  }

  /**
   * Ends a claim with the given column updates. Only the claim holder can: false, and nothing
   * written, when the claim was lost. A row that ended unsent stops the rest of its group.
   */
  private async settle(
    tenant: Tenant,
    outboxId: string,
    claimId: string,
    nowMs: number,
    set: string,
    params: readonly unknown[],
    endsUnsent: boolean,
  ): Promise<boolean> {
    const settled = this.db
      .prepare(
        `UPDATE outbound_messages SET ${set}, claim_id = NULL, claim_until_ms = NULL, updated_at_ms = ?
         WHERE business_id = ? AND id = ? AND status = 'sending' AND claim_id = ?`,
      )
      .bind(...params, nowMs, tenant.businessId, outboxId, claimId);
    const stopGroup = endsUnsent ? [this.stopGroupsAfterUnsent(nowMs, { tenant, outboxId })] : [];
    return this.whileClaimed(claimHeld(tenant, outboxId, claimId), [settled, ...stopGroup]);
  }

  /**
   * Runs a claim's transition (the first statement) and what follows from it as one batch guarded
   * by the claim, as leases fence job writes: when this call's claim isn't held, the batch fails and
   * nothing is written, follow-ups included. True when the transition applied.
   */
  private async whileClaimed(claim: Guard, statements: readonly D1PreparedStatement[]): Promise<boolean> {
    try {
      const [transition] = await guardedBatch(this.db, [claim], statements);
      return transition?.meta.changes === 1;
    } catch (error) {
      if (error instanceof ClaimLostError) return false;
      throw error;
    }
  }

  /**
   * Fails (predecessor_not_sent) the waiting rows of a group that come after a row of the group
   * that ended unsent: a confirmation never goes out without the draft before it. Scoped to one
   * row's group, or every group (the sweep).
   */
  private stopGroupsAfterUnsent(nowMs: number, of?: { tenant: Tenant; outboxId: string }): D1PreparedStatement {
    const scope =
      of === undefined
        ? ""
        : `AND business_id = ? AND EXISTS (SELECT 1 FROM outbound_messages g
                                           WHERE g.business_id = ? AND g.id = ? AND ${sameGroup("g", "outbound_messages")})`;
    const scopeParams = of === undefined ? [] : [of.tenant.businessId, of.tenant.businessId, of.outboxId];
    return this.db
      .prepare(
        `UPDATE outbound_messages SET status = 'failed', last_error = 'predecessor_not_sent', updated_at_ms = ?
         WHERE (job_id IS NOT NULL OR operation_key IS NOT NULL) AND status IN ('pending', 'waiting_window') ${scope}
           AND ${unsentEarlierInGroup("outbound_messages")}`,
      )
      .bind(nowMs, ...scopeParams);
  }
}

/** The notice's conversation is the store's: otherwise its insert would silently write nothing. */
function conversationOfStore(tenant: Tenant, conversationId: string): Guard {
  return {
    holdsSql: `SELECT 1 FROM conversations WHERE business_id = ? AND id = ?`,
    params: [tenant.businessId, conversationId],
    error: () => new NoticeConversationMissingError(),
  };
}
