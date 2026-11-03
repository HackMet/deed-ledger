import { CustomerNotFoundError } from "../../application/errors";
import type {
  BatchGuard,
  Commit,
  ConversationCustomer,
  ConversationRef,
  CustomerRepository,
  ReadbackRef,
  Tenant,
} from "../../application/ports";
import { normalizeCustomerName } from "../../domain/customer";

/**
 * Customers and their conversations: channel records owned by this side. Writes are commits for a
 * job's completion batch. Each one fails loudly (a guard) when its record isn't the store's; a
 * write that has nothing left to do (the name was saved already) changes nothing and doesn't fail.
 */
export class D1CustomerRepository implements CustomerRepository {
  constructor(private readonly db: D1Database) {}

  async ofConversation(conversation: ConversationRef): Promise<ConversationCustomer | null> {
    const row = await this.db
      .prepare(
        `SELECT cu.id, cu.name, cu.name_asked_at_ms, c.last_readback_order_id, c.last_readback_version,
                c.last_readback_at_ms
         FROM conversations c
         JOIN customers cu ON cu.business_id = c.business_id AND cu.id = c.customer_id
         WHERE c.business_id = ? AND c.id = ?`,
      )
      .bind(conversation.businessId, conversation.conversationId)
      .first<{
        id: string;
        name: string | null;
        name_asked_at_ms: number | null;
        last_readback_order_id: string | null;
        last_readback_version: number | null;
        last_readback_at_ms: number | null;
      }>();
    if (row === null) return null;
    return {
      id: row.id,
      name: row.name,
      nameAskedAtMs: row.name_asked_at_ms,
      lastReadback:
        row.last_readback_order_id === null || row.last_readback_version === null || row.last_readback_at_ms === null
          ? null
          : {
              orderId: row.last_readback_order_id,
              version: row.last_readback_version,
              queuedAtMs: row.last_readback_at_ms,
            },
    };
  }

  saveNameCommit(tenant: Tenant, customerId: string, name: string, nowMs: number): Commit {
    const tidy = normalizeCustomerName(name);
    const guards = [customerOfStore(tenant, customerId)];
    if (tidy === null) return { guards, statements: [] };
    return {
      guards,
      statements: [
        this.db
          .prepare(
            `UPDATE customers SET name = ?, name_saved_at_ms = ?
             WHERE business_id = ? AND id = ? AND name IS NULL`,
          )
          .bind(tidy, nowMs, tenant.businessId, customerId),
      ],
    };
  }

  markNameAskedCommit(tenant: Tenant, customerId: string, nowMs: number, closingJobId: string | null): Commit {
    const shown = onlyIfReplyWritten(tenant, closingJobId);
    return {
      guards: [customerOfStore(tenant, customerId)],
      statements: [
        this.db
          .prepare(
            `UPDATE customers SET name_asked_at_ms = ?
             WHERE business_id = ? AND id = ? AND name_asked_at_ms IS NULL ${shown.sql}`,
          )
          .bind(nowMs, tenant.businessId, customerId, ...shown.params),
      ],
    };
  }

  rememberReadbackCommit(
    conversation: ConversationRef,
    readback: ReadbackRef,
    nowMs: number,
    closingJobId: string | null,
  ): Commit {
    const shown = onlyIfReplyWritten(conversation, closingJobId);
    return {
      guards: [
        {
          holdsSql: `SELECT 1 FROM conversations WHERE business_id = ? AND id = ?`,
          params: [conversation.businessId, conversation.conversationId],
          error: () => new CustomerNotFoundError(),
        },
      ],
      statements: [
        this.db
          .prepare(
            `UPDATE conversations SET last_readback_order_id = ?, last_readback_version = ?, last_readback_at_ms = ?
             WHERE business_id = ? AND id = ? ${shown.sql}`,
          )
          .bind(readback.orderId, readback.version, nowMs, conversation.businessId, conversation.conversationId, ...shown.params),
      ],
    };
  }
}

/**
 * With a closing job, the same check that withholds a burst-closing reply (job-repository's
 * NO_OTHER_OPEN_JOB): no other job of that job's conversation is open. So a fact about what the
 * reply said is saved only when the reply itself is written.
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
