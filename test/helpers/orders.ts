import { env } from "cloudflare:workers";
import type { CustomerContext, EngineResult, LineMatch, MemberContext } from "../../src/application/engine";
import { OrderEngine } from "../../src/application/engine/order-engine";
import { reviewKey } from "../../src/domain/change-request";
import type { ActionEnvelope, ConsoleAction, CustomerAction } from "../../src/domain/contract/actions";
import type { BurstReading } from "../../src/domain/contract/observation";
import type { OrderView } from "../../src/domain/contract/outcomes";
import { D1OrderStore } from "../../src/infrastructure/d1/order-store";
import { D1FactLedger } from "../../src/infrastructure/d1/fact-ledger";
import { guardedBatch } from "../../src/infrastructure/d1/fence";
import { confirmTap, firstOrder, firstOrderMatches, ids, pickup } from "../fixtures/contract";
import { newPhone, seedStore } from "./seed";

/** The order engine on local D1, shared by the engine's test files. */
export const T0 = Date.UTC(2026, 9, 31, 14);
export const store = new D1OrderStore(env.DB);
/** The agent id the shared engine stamps on customer facts (C11). Any 8 lowercase hex characters will do. */
export const AGENT_ID = "5e1d0c3a";
export const engine = new OrderEngine({ store, ids: { newId: () => crypto.randomUUID() }, ledger: new D1FactLedger(env.DB), agentId: AGENT_ID });

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

/**
 * The fixture's first order with "lo paso a traer" in the same burst (K13): an order is delivered only
 * once its fulfillment is known, so tests that take one to entregado place it this way. Appended last,
 * so the matches' observation indexes still point at the order's lines.
 */
export const firstPickupOrder: BurstReading = { ...firstOrder, observations: [...firstOrder.observations, ...pickup.observations] };

/** The same, with "me lo traen frente a la iglesia" instead (K13): a delivery order. */
export const firstDeliveryOrder: BurstReading = {
  ...firstOrder,
  observations: [
    ...firstOrder.observations,
    { kind: "fulfillment", mode: "delivery", pin: null, placeText: "frente a la iglesia, casa verde", sameAsBefore: false, issues: [] },
  ],
};

/** An order saved before confirm asked pickup or delivery: nothing recorded how it leaves the store. */
export const forgetFulfillment = (businessId: string, orderId: string) =>
  env.DB.prepare(`UPDATE order_versions SET fulfillment_mode = NULL WHERE business_id = ? AND order_id = ?`).bind(businessId, orderId).run();

export async function placeFirstOrder(
  s: Awaited<ReturnType<typeof newStore>>,
  customerId: string = ids.customer,
  nowMs = T0,
  reading: BurstReading = firstPickupOrder,
) {
  const result = await engine.onBurst(s.context({ customerId, nowMs }), reading, s.matches);
  if (result.outcome.type !== "readback") throw new Error(`expected readback, got ${result.outcome.type}`);
  await save(result);
  return result.outcome.order;
}

/** The store's member who answers change requests in these tests. */
export const reviewer = (s: Awaited<ReturnType<typeof newStore>>, nowMs = T0 + 50_000): MemberContext => ({
  businessId: s.businessId,
  memberId: ids.staff,
  role: "owner",
  canApproveFiado: false,
  nowMs,
});

/** The owner's answer to a change request, under the key the engine derives for it. */
export const reviewTap = (
  changeRequestId: string,
  decision: "approve" | "decline" = "approve",
  reason = "Sí hay, va",
): ActionEnvelope<ConsoleAction> => ({
  operationKey: reviewKey(changeRequestId),
  actor: { type: "member", memberId: ids.staff, role: "owner" },
  action: { type: "review_change", changeRequestId, decision, reason },
});

/**
 * K12: a customer's change after confirming, saved as a request, then approved and saved. Returns the
 * order as approved (the new version, in the state it was in).
 */
export async function changeAndApprove(
  s: Awaited<ReturnType<typeof newStore>>,
  reading: BurstReading,
  nowMs: number,
  customerId: string = ids.customer,
): Promise<OrderView> {
  const requested = await engine.onBurst(s.context({ customerId, nowMs }), reading, []);
  const request = requested.outcome.type === "order_status" ? requested.outcome.order?.openChangeRequest : null;
  if (request === null || request === undefined) throw new Error(`expected a change request, got ${requested.outcome.type}`);
  await save(requested);
  const approved = await engine.onConsoleAction(reviewer(s, nowMs + 1), reviewTap(request.id));
  if (approved.outcome.type !== "action_saved" || approved.outcome.order === null) {
    throw new Error(`expected the approval saved, got ${JSON.stringify(approved.outcome)}`);
  }
  await save(approved);
  return approved.outcome.order;
}
