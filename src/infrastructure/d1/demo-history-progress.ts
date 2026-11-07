import type { SeedProgress } from "../../application/demo-history";
import { DEMO_BUSINESS_PREFIX } from "../../domain/demo";

const SEED_ID = /^demo\.seed\.(\d+)\.(\d+)$/;

/**
 * What a demo store holds of its seeded history (demo-history.ts), in two reads: the seed's
 * messages with the state of each one's order, and the invoices drafted. Only a demo store's rows.
 */
export async function readSeedProgress(db: D1Database, businessId: string): Promise<SeedProgress | null> {
  if (!businessId.startsWith(DEMO_BUSINESS_PREFIX)) return null;
  const [messages, invoices] = await db.batch([
    db
      .prepare(
        `SELECT i.provider_message_id AS id,
                (SELECT o.state FROM orders o WHERE o.business_id = c.business_id AND o.customer_id = c.customer_id
                 ORDER BY o.created_at_ms LIMIT 1) AS state
         FROM inbound_messages i
         JOIN conversations c ON c.id = i.conversation_id AND c.business_id = i.business_id
         WHERE i.business_id = ?1 AND i.provider_message_id LIKE 'demo.seed.%'`,
      )
      .bind(businessId),
    db.prepare(`SELECT count(*) AS n FROM drafts WHERE business_id = ?1 AND kind = 'receipt'`).bind(businessId),
  ]);
  const messageIds = new Set<string>();
  const stateByItem = new Map<number, string>();
  for (const row of (messages?.results ?? []) as { id: string; state: string | null }[]) {
    messageIds.add(row.id);
    const match = SEED_ID.exec(row.id);
    if (match !== null && match[2] === "0" && row.state !== null) stateByItem.set(Number(match[1]), row.state);
  }
  const n = ((invoices?.results ?? []) as { n: number }[])[0]?.n ?? 0;
  return { messageIds, stateByItem, invoices: n };
}
