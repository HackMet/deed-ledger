/**
 * The store's own work in a fact's batch, outside the core: the draft a fact may rest on (G3, S1, S6), and the
 * stock a fact moves (S4's compensating movements, S5). Every statement and guard here runs in the core's batch.
 */
import { FactRefusedError } from "../../application/errors";
import type { CoreGuard, HostExtension } from "../../deed-core/store";
import type { FactCommit } from "../../domain/facts";

/** The scope a fact is written in: a store, and the conversation its draft lives in when there is one. */
export interface ExtensionScope {
  readonly businessId: string;
  readonly conversationId?: string;
}

export function storeExtension(db: D1Database, scope: ExtensionScope, commit: FactCommit, nowMs: number): HostExtension {
  const businessId = scope.businessId;
  const confirmation = commit.evidence.find((ref) => ref.kind === "confirmation");
  // The message that confirmed: the commit's last inbound_message evidence.
  const confirmingInbound = commit.evidence.filter((ref) => ref.kind === "inbound_message").at(-1);
  const guards: CoreGuard[] = [];
  const before: D1PreparedStatement[] = [];
  const after: D1PreparedStatement[] = [];

  // G3: the exact revision the owner confirmed is still pending, unexpired, in this conversation.
  // A draft lives in a conversation: without one, the draft can't be the one the owner confirmed.
  if (commit.draft !== null && scope.conversationId === undefined) {
    guards.push({ holdsSql: `SELECT NULL`, params: [], error: () => new FactRefusedError("draft_not_pending") });
  } else if (commit.draft !== null) {
    guards.push({
      holdsSql: `SELECT 1 FROM drafts
                 WHERE business_id = ? AND conversation_id = ? AND id = ? AND state = 'pending' AND revision = ?
                   AND expires_at_ms > ?`,
      params: [businessId, scope.conversationId, commit.draft.id, commit.draft.revision, nowMs],
      error: () => new FactRefusedError("draft_not_pending"),
    });
  }

  // S1: one approval per draft, ever (UNIQUE business_id, draft_id). Before the fact row, as before.
  if (commit.draft !== null && confirmation !== undefined && confirmingInbound !== undefined) {
    before.push(
      db
        .prepare(
          `INSERT INTO draft_confirmations (id, business_id, draft_id, revision, actor_user_id, inbound_id, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(confirmation.refId, businessId, commit.draft.id, commit.draft.revision, commit.actorUserId, confirmingInbound.refId, nowMs),
    );
  }

  // S4: a closed fact's stock is restored by compensating movements (negated quantities), after the closure row.
  // The balance rows exist (the original movements upserted them), so this is an UPDATE: an INSERT would check the
  // negated value against the CHECK before any conflict. A restore that would drive a balance below zero fails its
  // CHECK and rolls the closure back too.
  if (commit.closes !== null) {
    after.push(
      db
        .prepare(
          `INSERT INTO stock_movements (id, business_id, fact_id, product_id, qty_milli, unit_cost_centavos, created_at_ms)
           SELECT lower(hex(randomblob(16))), business_id, ?, product_id, -qty_milli, unit_cost_centavos, ?
           FROM stock_movements WHERE business_id = ? AND fact_id = ?`,
        )
        .bind(commit.factId, nowMs, businessId, commit.closes.factId),
      db
        .prepare(
          `UPDATE stock_balances SET qty_milli = qty_milli + (
             SELECT sum(-m.qty_milli) FROM stock_movements m
             WHERE m.business_id = stock_balances.business_id AND m.product_id = stock_balances.product_id AND m.fact_id = ?
           ), updated_at_ms = ?
           WHERE business_id = ? AND product_id IN (SELECT product_id FROM stock_movements WHERE business_id = ? AND fact_id = ?)`,
        )
        .bind(commit.closes.factId, nowMs, businessId, businessId, commit.closes.factId),
    );
  }

  // S5: movements and balances; a balance below zero fails its CHECK.
  for (const movement of commit.movements) {
    after.push(
      db
        .prepare(
          `INSERT INTO stock_movements (id, business_id, fact_id, product_id, qty_milli, unit_cost_centavos, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(movement.id, businessId, commit.factId, movement.productId, movement.qtyMilli, movement.unitCostCentavos, nowMs),
      db
        .prepare(
          `INSERT INTO stock_balances (business_id, product_id, qty_milli, updated_at_ms) VALUES (?, ?, ?, ?)
           ON CONFLICT (business_id, product_id)
           DO UPDATE SET qty_milli = qty_milli + excluded.qty_milli, updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(businessId, movement.productId, movement.qtyMilli, nowMs),
    );
  }

  // S6: the draft is spent (G3 pinned it, so this matches exactly one row).
  if (commit.draft !== null) {
    after.push(
      db
        .prepare(`UPDATE drafts SET state = 'committed', updated_at_ms = ? WHERE business_id = ? AND id = ?`)
        .bind(nowMs, businessId, commit.draft.id),
    );
  }

  return {
    guards,
    factColumns: { draft_id: commit.draft?.id ?? null, draft_revision: commit.draft?.revision ?? null },
    statementsBefore: before,
    statementsAfter: after,
  };
}
