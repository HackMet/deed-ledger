/**
 * A new demo store opens with a few days of made-up history (demo-history.ts): customers, orders in
 * every state, an invoice received and one to review, and the Deed's checks. All of it written by the
 * real engine, so what the ledger derives is what the screens show. None of it touches the visitor's
 * phone or its message limit.
 */
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_HISTORY, DEMO_HISTORY_ITEMS, type DemoHistoryMessage } from "../src/application/demo-history";
import { isDemoPhone } from "../src/domain/demo";
import { deriveOrderState } from "../src/domain/order-state";
import { D1DemoStoreRepository } from "../src/infrastructure/d1/demo-store-repository";
import { D1OrderStore } from "../src/infrastructure/d1/order-store";
import { env } from "cloudflare:workers";
import { type Harness, harness, rows, testEnv } from "./helpers/harness";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ORIGIN = "https://worker.test";

async function call(h: Harness, path: string, init: { method?: string; cookie?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "cf-connecting-ip": init.ip ?? `198.51.100.${Math.floor(Math.random() * 250)}` };
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(new IncomingRequest(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, redirect: "manual" }), h.env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** The pieces a store queued, as the queue holds them. */
class CaughtQueue {
  sent: { body: DemoHistoryMessage; delaySeconds?: number }[] = [];
  async sendBatch(messages: readonly { body: DemoHistoryMessage; delaySeconds?: number }[]) {
    this.sent.push(...messages);
  }
}

/** Hands queue messages to the Worker's consumer in one batch, as Cloudflare Queues would. */
async function deliver(h: Harness, bodies: readonly unknown[]) {
  const batch = createMessageBatch<unknown>(
    "store-assistant-jobs",
    bodies.map((body, n) => ({ id: `seed-${n}-${crypto.randomUUID()}`, timestamp: new Date(h.clock.now()), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await h.worker.queue(batch, h.env, ctx);
  return getQueueResult(batch, ctx);
}

/** Production runs the planner conversation (deploy.yml); the classic one is wrangler.jsonc's default. */
async function openDemo(conversation: "planner" | "classic" = "planner") {
  const queue = new CaughtQueue();
  const h = harness({ env: testEnv({ DEED_ENGINE: "1", CONVERSATION: conversation } as unknown as Partial<Env>), demoHistoryQueue: queue });
  const opened = await call(h, "/demo/empezar", { method: "POST" });
  expect(opened.status).toBe(303);
  const cookie = opened.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
  const [store] = await rows<{ business_id: string }>(`SELECT business_id FROM demo_stores ORDER BY created_at_ms DESC LIMIT 1`);
  return { h, queue, cookie, businessId: store!.business_id };
}

/** A store with every piece delivered, one batch each, each queuing the next as it finishes. */
async function openSeededDemo(conversation: "planner" | "classic" = "planner") {
  const opened = await openDemo(conversation);
  for (let n = 0; n < opened.queue.sent.length; n++) await deliver(opened.h, [opened.queue.sent[n]!.body]);
  return opened;
}

describe("a demo store's history", { timeout: 60_000 }, () => {
  it.each(["planner", "classic"] as const)("has every order the script names, in the state the script leaves it, as the ledger derives it (%s)", async (conversation) => {
    const { h, businessId } = await openSeededDemo(conversation);
    expect(h.log.lines.filter((l) => /demo_history_order_failed|demo_seed_step_failed|demo_history_invoice_failed/.test(l))).toEqual([]);

    const orders = await rows<{ id: string; state: string; current_version: number; name: string | null }>(
      `SELECT o.id, o.state, o.current_version, cu.name FROM orders o JOIN customers cu ON cu.id = o.customer_id AND cu.business_id = o.business_id
       WHERE o.business_id = ? ORDER BY o.created_at_ms`,
      businessId,
    );
    expect(orders.map((o) => [o.name, o.state])).toEqual([
      ["Marta", "entregado"],
      ["Carlos", "entregado"],
      [null, "cancelado"], // cancelled before the store asked his name
      ["Lupita", "entregado"],
      ["Rosa", "confirmado"],
      ["Kevin", "confirmado"],
      ["Yesenia", "preparando"],
      ["Mario", "listo"],
      ["Ana", "en_camino"],
    ]);
    expect(orders).toHaveLength(DEMO_HISTORY.length);
    const store = new D1OrderStore(env.DB);
    for (const order of orders) {
      const facts = await store.orderFacts({ businessId }, order.id);
      expect(deriveOrderState(facts, order.current_version, order.state as never)).toBe(order.state);
    }
  });

  it("leaves Rosa's change waiting for the owner", async () => {
    const { businessId } = await openSeededDemo();
    const kinds = await rows<{ kind: string }>(`SELECT kind FROM facts WHERE business_id = ? AND kind IN ('change_request', 'change_review')`, businessId);
    expect(kinds.map((k) => k.kind)).toEqual(["change_request"]);
  });

  it("answers Mario's tap on his first readback, after he added to it, with the order as it is now", async () => {
    const { businessId } = await openSeededDemo();
    const replies = await rows<{ body_text: string }>(`SELECT body_text FROM outbound_messages WHERE business_id = ? ORDER BY seq`, businessId);
    expect(replies.some((r) => r.body_text.startsWith("Tu pedido cambió desde ese mensaje"))).toBe(true);
    const passes = await rows<{ n: number }>(`SELECT count(*) AS n FROM deed_checks WHERE business_id = ? AND result = 'pass'`, businessId);
    expect(passes[0]!.n).toBeGreaterThan(0);
  });

  it("gives the Deed the classic engine's refusals of a stale and a repeated Confirmar", async () => {
    const { businessId } = await openSeededDemo("classic");
    const refusals = await rows<{ reason_code: string }>(
      `SELECT reason_code FROM deed_checks WHERE business_id = ? AND result = 'fail' AND source <> 'verify_claims'`,
      businessId,
    );
    expect(refusals.map((r) => r.reason_code)).toEqual(expect.arrayContaining(["stale_version", "duplicate"]));
  });

  it("dates the orders over the last days, with today's on the preparation list", async () => {
    const { h, businessId, cookie } = await openSeededDemo();
    const now = h.clock.now();
    const created = await rows<{ created_at_ms: number }>(`SELECT created_at_ms FROM orders WHERE business_id = ? ORDER BY created_at_ms`, businessId);
    expect(now - created[0]!.created_at_ms).toBeGreaterThan(3 * 24 * 3_600_000);
    expect(created.every((o) => o.created_at_ms < now)).toBe(true);
    const prep = await call(h, "/console/preparacion", { cookie });
    expect(prep.status).toBe(200);
    const page = await prep.text();
    for (const name of ["Rosa", "Kevin", "Yesenia", "Mario"]) expect(page).toContain(name);
  });

  it("receives one invoice into stock and leaves one to review, each with its photo", async () => {
    const { businessId, h, cookie } = await openSeededDemo();
    const drafts = await rows<{ state: string }>(`SELECT state FROM drafts WHERE business_id = ? AND kind = 'receipt' ORDER BY created_at_ms`, businessId);
    expect(drafts.map((d) => d.state)).toEqual(["committed", "pending"]);
    const receipts = await rows<{ n: number }>(`SELECT count(*) AS n FROM facts WHERE business_id = ? AND kind = 'receipt'`, businessId);
    expect(receipts[0]!.n).toBe(1);
    const list = await (await call(h, "/console/facturas", { cookie })).text();
    expect(list).toContain("Distribuidora Ejemplo");
    expect(list).toContain("Abarrotes Ejemplo");
    const [draft] = await rows<{ id: string }>(`SELECT id FROM drafts WHERE business_id = ? AND kind = 'receipt' AND state = 'pending'`, businessId);
    const photo = await call(h, `/console/facturas/${draft!.id}/imagen`, { cookie });
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/jpeg");
  });

  it("keeps the seeded customers off the visitor's phone and out of its message limit", async () => {
    const { h, businessId } = await openSeededDemo();
    const repo = new D1DemoStoreRepository(env.DB);
    const demo = await repo.find(businessId, h.clock.now());
    expect(demo).not.toBeNull();
    expect(await repo.messageCount(demo!)).toBe(0);
    expect(await repo.chat(demo!, 0)).toEqual([]);
    const phones = await rows<{ phone: string }>(`SELECT phone FROM customers WHERE business_id = ?`, businessId);
    expect(phones.length).toBe(DEMO_HISTORY.length);
    expect(phones.every((p) => isDemoPhone(p.phone) && p.phone !== demo!.customerPhone)).toBe(true);
    // The demo channel showed the replies; nothing was sent anywhere.
    expect(h.channel.sent).toEqual([]);
  });

  it("queues the first piece only, opens the store without waiting for it, and each piece queues the next", async () => {
    const { h, queue, businessId } = await openDemo();
    expect(queue.sent.map((m) => m.body)).toEqual([{ v: 1, kind: "demo_history", businessId, item: 0 }]);
    expect(await rows(`SELECT id FROM orders WHERE business_id = ?`, businessId)).toEqual([]);
    for (let n = 0; n < queue.sent.length; n++) await deliver(h, [queue.sent[n]!.body]);
    expect(queue.sent.map((m) => m.body.item)).toEqual(Array.from({ length: DEMO_HISTORY_ITEMS }, (_, n) => n));
  });

  it("seeds one piece per batch and sends the others back as fresh messages, so one invocation stays under D1's query limit", async () => {
    const { h, queue, businessId } = await openDemo();
    const other = { v: 1, kind: "demo_history", businessId, item: 1 } as const;
    const result = await deliver(h, [queue.sent[0]!.body, other]);
    expect(result.explicitAcks).toHaveLength(2);
    expect(result.retryMessages).toEqual([]);
    expect(await rows(`SELECT id FROM orders WHERE business_id = ?`, businessId)).toHaveLength(1);
    // The one put back, a moment later, and the next piece after the one that ran.
    expect(queue.sent.slice(1)).toEqual(expect.arrayContaining([{ body: other, delaySeconds: 2 }, { body: { ...other } }]));
  });

  it("seeds a piece delivered twice only once", async () => {
    const { h, queue, businessId } = await openDemo();
    await deliver(h, [queue.sent[0]!.body]);
    await deliver(h, [queue.sent[0]!.body]);
    expect(await rows(`SELECT id FROM orders WHERE business_id = ?`, businessId)).toHaveLength(1);
  });

  it("never seeds a real store, whatever the message says", async () => {
    const { h, queue } = await openDemo();
    const before = await rows<{ n: number }>(`SELECT count(*) AS n FROM orders`);
    await deliver(h, [{ v: 1, kind: "demo_history", businessId: "store-real", item: 1 }]);
    expect(await rows<{ n: number }>(`SELECT count(*) AS n FROM orders`)).toEqual(before);
    expect(queue.sent).toHaveLength(1); // only the store's own first piece: nothing chains for a store that isn't one
  });
});
