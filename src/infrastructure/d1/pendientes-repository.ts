import type { AnyPendiente, Clock, IdSource, Logger, OpenPendiente, Pendientes, PendientesBoard, Tenant } from "../../application/ports";
import { describeError } from "../../application/errors";
import { LoggingPendientes } from "../logging-pendientes";

/** The most items the console lists at once. */
const MAX_OPEN = 100;

/**
 * Pendientes kept in D1 for the console (wireframe C5), and still logged as before. Raising never
 * throws: a failed write is logged, and the caller's work goes on.
 */
export class D1Pendientes implements Pendientes, PendientesBoard {
  private readonly logging: LoggingPendientes;

  constructor(
    private readonly db: D1Database,
    private readonly ids: IdSource,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {
    this.logging = new LoggingPendientes(log);
  }

  async raise(tenant: Tenant, item: AnyPendiente): Promise<void> {
    await this.logging.raise(tenant, item);
    const row = rowOf(item, this.ids);
    try {
      await this.db
        .prepare(
          `INSERT INTO conversation_pendientes
             (id, business_id, kind, conversation_id, dedupe_key, detail, item_count, urgent, raised_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
        )
        .bind(this.ids.newId(), tenant.businessId, item.kind, row.conversationId, row.dedupeKey, row.detail, row.count, row.urgent ? 1 : 0, this.clock.now())
        .run();
    } catch (error) {
      this.log.error("pendiente_store_failed", { businessId: tenant.businessId, reason: item.kind, status: describeError(error) });
    }
  }

  async listOpen(tenant: Tenant): Promise<readonly OpenPendiente[]> {
    const { results } = await this.db
      .prepare(
        `SELECT p.id, p.kind, p.detail, p.item_count, p.urgent, p.raised_at_ms, cu.name, cu.phone
         FROM conversation_pendientes p
         LEFT JOIN conversations c ON c.business_id = p.business_id AND c.id = p.conversation_id
         LEFT JOIN customers cu ON cu.business_id = c.business_id AND cu.id = c.customer_id
         WHERE p.business_id = ? AND p.done_at_ms IS NULL
         ORDER BY p.urgent DESC, p.raised_at_ms DESC, p.id
         LIMIT ${MAX_OPEN}`,
      )
      .bind(tenant.businessId)
      .all<{
        id: string;
        kind: OpenPendiente["kind"];
        detail: string | null;
        item_count: number | null;
        urgent: number;
        raised_at_ms: number;
        name: string | null;
        phone: string | null;
      }>();
    return results.map((r) => ({
      id: r.id,
      kind: r.kind,
      detail: r.detail,
      count: r.item_count,
      urgent: r.urgent === 1,
      raisedAtMs: r.raised_at_ms,
      customerName: r.name,
      phoneEnding: r.phone === null ? null : r.phone.slice(-4),
    }));
  }

  async countOpen(tenant: Tenant): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS open FROM conversation_pendientes WHERE business_id = ? AND done_at_ms IS NULL`)
      .bind(tenant.businessId)
      .first<{ open: number }>();
    return row?.open ?? 0;
  }

  async markDone(tenant: Tenant, id: string, userId: string, nowMs: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE conversation_pendientes SET done_at_ms = ?, done_by_user_id = ?
         WHERE business_id = ? AND id = ? AND done_at_ms IS NULL`,
      )
      .bind(nowMs, userId, tenant.businessId, id)
      .run();
    return result.meta.changes === 1;
  }
}

function rowOf(item: AnyPendiente, ids: IdSource) {
  switch (item.kind) {
    case "customer_handoff":
      return { conversationId: item.conversationId, dedupeKey: `handoff:${item.inboundId}`, detail: null, count: null, urgent: false };
    case "customer_question":
      return {
        conversationId: item.conversationId,
        dedupeKey: `question:${item.inboundId}:${item.topic}`,
        detail: item.topic,
        count: item.unknown,
        urgent: false,
      };
    case "slow_reply":
      return { conversationId: item.conversationId, dedupeKey: `slow:${item.inboundId}`, detail: null, count: null, urgent: true };
    case "notice_waiting_window":
      return { conversationId: item.conversationId, dedupeKey: `notice:${item.outboxId}`, detail: item.notice, count: null, urgent: false };
    case "claim_blocked":
      return {
        conversationId: item.conversationId,
        // A reply in the outbox is one item; a reply stopped before the save has no ID to repeat.
        dedupeKey: item.outboxId === null ? `blocked:${item.stage}:${ids.newId()}` : `blocked:${item.stage}:${item.outboxId}`,
        detail: item.stage,
        count: null,
        urgent: item.urgency === "urgent",
      };
  }
}
