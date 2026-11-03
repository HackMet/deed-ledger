import { env } from "cloudflare:workers";
import type { CustomerContext, EngineResult, LineMatch } from "../../src/application/engine";
import { OrderEngine } from "../../src/application/engine/order-engine";
import type { ActionEnvelope, CustomerAction } from "../../src/domain/contract/actions";
import { D1OrderStore } from "../../src/infrastructure/d1/order-store";
import { D1FactLedger } from "../../src/infrastructure/d1/fact-ledger";
import { guardedBatch } from "../../src/infrastructure/d1/fence";
import { confirmTap, firstOrder, firstOrderMatches, ids } from "../fixtures/contract";
import { newPhone, seedStore } from "./seed";

/** The order engine on local D1, shared by the engine's test files. */
export const T0 = Date.UTC(2026, 9, 31, 14);
export const store = new D1OrderStore(env.DB);
export const engine = new OrderEngine({ store, ids: { newId: () => crypto.randomUUID() }, ledger: new D1FactLedger(env.DB) });

/** Runs a result's commits as the job's completion batch does: one batch, every guard first. */
export async function save(result: EngineResult): Promise<void> {
  if (result.commits.length === 0) return;
  await guardedBatch(
    env.DB,
    result.commits.flatMap((c) => c.guards),
    result.commits.flatMap((c) => c.statements),
    result.commits.flatMap((c) => c.post ?? []),
  );
}

export async function newStore() {
  const seeded = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
  const businessId = seeded.businessId;
  // The catalog products the fixture's matches name, under ids unique to this store.
  const productId = (id: string) => `${businessId}:${id}`;
  await env.DB.batch(
    firstOrderMatches.map((m) =>
      env.DB.prepare(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) VALUES (?, ?, ?, 0)`).bind(
        productId(m.productId),
        businessId,
        m.productId.replace("product-", ""),
      ),
    ),
  );
  const matches: LineMatch[] = firstOrderMatches.map((m) => ({ ...m, productId: productId(m.productId) }));
  const context = (over: Partial<CustomerContext> = {}): CustomerContext => ({
    businessId,
    customerId: ids.customer,
    conversationId: "conversation-carla",
    jobId: crypto.randomUUID(),
    nowMs: T0,
    ...over,
  });
  return { businessId, matches, context };
}

/** The fixture's tap, aimed at the order the engine created. */
export const tap = (orderId: string, version: number, over: Partial<ActionEnvelope<CustomerAction>> = {}): ActionEnvelope<CustomerAction> => ({
  ...confirmTap,
  operationKey: `confirm:${orderId}:v${version}`,
  action: { type: "confirm_order", orderId, version },
  ...over,
});

export const count = async (sql: string, ...params: unknown[]) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${sql}`).bind(...params).first<{ n: number }>())?.n ?? -1;

/** Every row the engine could have written for a store. */
export const footprint = async (businessId: string) => ({
  orders: await count(`orders WHERE business_id = ?`, businessId),
  versions: await count(`order_versions WHERE business_id = ?`, businessId),
  lines: await count(`order_lines WHERE business_id = ?`, businessId),
  operations: await count(`operations WHERE business_id = ?`, businessId),
  audit: await count(`audit_events WHERE business_id = ?`, businessId),
});

export async function placeFirstOrder(s: Awaited<ReturnType<typeof newStore>>, customerId: string = ids.customer, nowMs = T0) {
  const result = await engine.onBurst(s.context({ customerId, nowMs }), firstOrder, s.matches);
  if (result.outcome.type !== "readback") throw new Error(`expected readback, got ${result.outcome.type}`);
  await save(result);
  return result.outcome.order;
}
