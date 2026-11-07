/**
 * A new demo store opens with a few days of made-up history (demo-history.ts): customers, orders in
 * every state, an invoice received and one to review, and the Deed's checks. All of it written by the
 * real engine, so what the ledger derives is what the screens show. None of it touches the visitor's
 * phone or its message limit.
 */
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_HISTORY, DEMO_HISTORY_ITEMS, DEMO_HISTORY_WAIT_MS, type DemoHistoryMessage } from "../src/application/demo-history";
import { HISTORY_LOADING, HISTORY_REFRESH_S } from "../src/interfaces/http/console/inicio";
import { DEMO_SEED_QUEUE } from "../src/interfaces/queue";
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
  failing = false;
  async sendBatch(messages: readonly { body: DemoHistoryMessage; delaySeconds?: number }[]) {
    if (this.failing) throw new Error("queue unavailable");
    this.sent.push(...messages);
  }
}

/** Hands queue messages to the Worker's consumer in one batch, as Cloudflare Queues would: the demo-seed queue unless named. */
async function deliver(h: Harness, bodies: readonly unknown[], queue = DEMO_SEED_QUEUE, attempts = 1) {
  const batch = createMessageBatch<unknown>(
    queue,
    bodies.map((body, n) => ({ id: `seed-${n}-${crypto.randomUUID()}`, timestamp: new Date(h.clock.now()), attempts, body })),
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

/**
 * A store with every piece delivered, one batch each: all at once, as the demo-seed queue runs
 * several invocations side by side, or one after another.
 */
async function openSeededDemo(conversation: "planner" | "classic" = "planner", together = true) {
  const opened = await openDemo(conversation);
  const pieces = opened.queue.sent.map((m) => m.body);
  if (together) await Promise.all(pieces.map((piece) => deliver(opened.h, [piece])));
  else for (const piece of pieces) await deliver(opened.h, [piece]);
  return opened;
}

/** The orders of a seeded store with their customer's name and state, oldest first. */
async function seededOrders(businessId: string) {
  return rows<{ id: string; state: string; current_version: number; name: string | null }>(
    `SELECT o.id, o.state, o.current_version, cu.name FROM orders o JOIN customers cu ON cu.id = o.customer_id AND cu.business_id = o.business_id
     WHERE o.business_id = ? ORDER BY o.created_at_ms`,
    businessId,
  );
}

const SCRIPTED_STATES = [
  ["Marta", "entregado"],
  ["Carlos", "entregado"],
  [null, "cancelado"], // cancelled before the store asked his name
  ["Lupita", "entregado"],
  ["Rosa", "confirmado"],
  ["Kevin", "confirmado"],
  ["Yesenia", "preparando"],
  ["Mario", "listo"],
  ["Ana", "en_camino"],
];

describe("a demo store's history", { timeout: 60_000 }, () => {
  it.each(["planner", "classic"] as const)("has every order the script names, in the state the script leaves it, as the ledger derives it (%s)", async (conversation) => {
    const { h, businessId } = await openSeededDemo(conversation);
    expect(h.log.lines.filter((l) => /demo_history_order_failed|demo_seed_step_failed|demo_history_invoice_failed/.test(l))).toEqual([]);

    const orders = await seededOrders(businessId);
    expect(orders.map((o) => [o.name, o.state])).toEqual(SCRIPTED_STATES);
    expect(orders).toHaveLength(DEMO_HISTORY.length);
    const store = new D1OrderStore(env.DB);
    for (const order of orders) {
      const facts = await store.orderFacts({ businessId }, order.id);
      expect(deriveOrderState(facts, order.current_version, order.state as never)).toBe(order.state);
    }
  });

  it.each(["planner", "classic"] as const)("backs every claim its replies made: a normal order raises no false alarm (%s)", async (conversation) => {
    const { businessId } = await openSeededDemo(conversation);
    const claims = await rows<{ result: string; n: number }>(
      `SELECT result, count(*) AS n FROM deed_checks WHERE business_id = ? AND source = 'verify_claims' GROUP BY result ORDER BY result`,
      businessId,
    );
    expect(claims.map((c) => c.result)).toEqual(["pass"]);
    expect(claims[0]!.n).toBeGreaterThan(0);
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

  it("seeds the same store whether the pieces run side by side or one after another", async () => {
    const { h, businessId } = await openSeededDemo("planner", false);
    expect(h.log.lines.filter((l) => /demo_history_failed/.test(l))).toEqual([]);
    expect((await seededOrders(businessId)).map((o) => [o.name, o.state])).toEqual(SCRIPTED_STATES);
  });

  it("queues every piece at once, on the demo-seed queue, and opens the store without waiting for them", async () => {
    const { h, queue, businessId } = await openDemo();
    expect(queue.sent.map((m) => m.body)).toEqual(Array.from({ length: DEMO_HISTORY_ITEMS }, (_, item) => ({ v: 1, kind: "demo_history", businessId, item })));
    expect(await rows(`SELECT id FROM orders WHERE business_id = ?`, businessId)).toEqual([]);
    // Running a piece queues nothing more: no chain to wait on.
    await deliver(h, [queue.sent[0]!.body]);
    expect(queue.sent).toHaveLength(DEMO_HISTORY_ITEMS);
  });

  it("seeds one piece per batch and sends the others back as fresh messages, so one invocation stays under D1's query limit", async () => {
    const { h, queue, businessId } = await openDemo();
    const result = await deliver(h, [queue.sent[0]!.body, queue.sent[1]!.body]);
    expect(result.explicitAcks).toHaveLength(2);
    expect(result.retryMessages).toEqual([]);
    expect(await rows(`SELECT id FROM orders WHERE business_id = ?`, businessId)).toHaveLength(1);
    expect(queue.sent.slice(DEMO_HISTORY_ITEMS)).toEqual([{ body: queue.sent[1]!.body, delaySeconds: 2 }]);
  });

  it("never runs a piece in a doorbell batch: one found on the jobs queue moves to the demo-seed queue with every piece after it", async () => {
    const { h, queue, businessId } = await openDemo();
    // The chaining version queued piece 3; the pieces after it existed only as its successors.
    const legacy = queue.sent[3]!.body;
    const result = await deliver(h, [legacy], "store-assistant-jobs");
    expect(result.explicitAcks).toHaveLength(1);
    expect(await rows(`SELECT id FROM orders WHERE business_id = ?`, businessId)).toEqual([]);
    const moved = queue.sent.slice(DEMO_HISTORY_ITEMS);
    expect(moved.map((m) => m.body)).toEqual([...queue.sent.slice(4, DEMO_HISTORY_ITEMS).map((m) => m.body), legacy]);
    expect(moved.every((m) => m.delaySeconds === 2)).toBe(true);
  });

  it("retries a piece it couldn't put back, then logs it and stops instead of letting the queue drop it", async () => {
    const { h, queue } = await openDemo();
    const piece = queue.sent[1]!.body;
    queue.failing = true;
    const early = await deliver(h, [queue.sent[0]!.body, piece], DEMO_SEED_QUEUE, 1);
    expect(early.retryMessages.map((m) => m.msgId)).toHaveLength(1);
    const last = await deliver(h, [queue.sent[0]!.body, piece], DEMO_SEED_QUEUE, 3);
    expect(last.retryMessages).toEqual([]);
    expect(last.explicitAcks).toHaveLength(2);
    expect(h.log.lines.some((l) => l.includes("demo_history_dropped") && l.includes("item 1"))).toBe(true);
  });

  it("tells Inicio the history is loading until every piece is in, and refreshes it only meanwhile", async () => {
    const { h, queue, cookie } = await openDemo();
    const before = await (await call(h, "/console/inicio", { cookie })).text();
    expect(before).toContain(HISTORY_LOADING);
    expect(before).toContain(`<meta http-equiv="refresh" content="${HISTORY_REFRESH_S};url=/console/inicio">`);
    expect(before).not.toContain("Hoy todavía no hay pedidos.");
    await Promise.all(queue.sent.slice(0, DEMO_HISTORY_ITEMS - 1).map((m) => deliver(h, [m.body])));
    expect(await (await call(h, "/console/inicio", { cookie })).text()).toContain(HISTORY_LOADING); // the invoices are still to come
    await deliver(h, [queue.sent[DEMO_HISTORY_ITEMS - 1]!.body]);
    const after = await (await call(h, "/console/inicio", { cookie })).text();
    expect(after).not.toContain(HISTORY_LOADING);
    expect(after).not.toContain('http-equiv="refresh"');
  });

  it("stops waiting for a history that never completes", async () => {
    const { h, cookie } = await openDemo();
    h.clock.advance(DEMO_HISTORY_WAIT_MS + 1);
    const page = await (await call(h, "/console/inicio", { cookie })).text();
    expect(page).not.toContain(HISTORY_LOADING);
    expect(page).not.toContain('http-equiv="refresh"');
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
    expect(queue.sent).toHaveLength(DEMO_HISTORY_ITEMS); // only the store's own pieces
  });
});
