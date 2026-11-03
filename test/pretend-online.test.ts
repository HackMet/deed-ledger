import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CustomerContext, EngineResult, LineMatch, MemberContext } from "../src/application/engine";
import { buildRuntime } from "../src/composition";
import type { ActionEnvelope, ConsoleAction } from "../src/domain/contract/actions";
import type { BurstReading } from "../src/domain/contract/observation";
import { renderNotice } from "../src/domain/replies";
import { guardedBatch } from "../src/infrastructure/d1/fence";
import { D1PretendEngine, PretendStateMovedError } from "../src/infrastructure/memory/d1-pretend-engine";
import { DEMO_CATALOG } from "../src/infrastructure/memory/demo-catalog";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";
import { csrfFor, login, send, storeWithStaff } from "./helpers/console";
import { harness, rows, testEnv } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const pretendEnv = (extra: Record<string, string> = {}) => testEnv({ PRETEND_ENGINE: "1", ...extra } as unknown as Partial<Env>);

/** Two engines over the same D1, as the queue consumer and the console in two isolates. */
const twoIsolates = () => [new D1PretendEngine(env.DB, { catalog: DEMO_CATALOG }), new D1PretendEngine(env.DB, { catalog: DEMO_CATALOG })] as const;

/** Saves a result's commits the way the job and the console batches do. */
async function save(result: EngineResult): Promise<EngineResult> {
  for (const commit of result.commits) await guardedBatch(env.DB, commit.guards, commit.statements);
  return result;
}

const evidence = { source: "text", message: 0, start: 0, end: 4 } as const;

/** "1 lb de arroz, lo paso a traer", matched to the demo rice. */
const RICE_PICKUP: BurstReading = {
  observations: [
    {
      kind: "customer_order",
      lines: [{ text: "1 lb arroz", name: "arroz", quantity: "1", unit: "libra", restrictedCategory: false, evidence }],
      issues: [],
    },
    { kind: "fulfillment", mode: "pickup", pin: null, placeText: null, sameAsBefore: false, evidence, issues: [] },
  ],
  calls: [],
} as unknown as BurstReading;
const RICE_MATCH: LineMatch[] = [{ observation: 0, line: 0, productId: "demo-arroz", how: "exact_name" }];

function customer(businessId: string, customerId: string): CustomerContext {
  return { businessId, customerId, conversationId: "c-1", jobId: crypto.randomUUID(), nowMs: 1_000, customerName: "Ana" } as CustomerContext;
}

function member(businessId: string): MemberContext {
  return { businessId, memberId: "m-staff", role: "staff", canApproveFiado: false, nowMs: 2_000 };
}

function tap(action: ConsoleAction, operationKey: string = crypto.randomUUID()): ActionEnvelope<ConsoleAction> {
  return { operationKey, actor: { type: "member", memberId: "m-staff", role: "staff" }, action };
}

/** A customer's order through `engine`: read back, then confirmed. Returns its ID. */
async function confirmedOrder(engine: D1PretendEngine, businessId: string, customerId: string): Promise<string> {
  const context = customer(businessId, customerId);
  const { outcome } = await save(await engine.onBurst(context, RICE_PICKUP, RICE_MATCH));
  expect(outcome).toMatchObject({ type: "readback", order: { version: 1, total: 1800 } });
  const orderId = outcome.type === "readback" ? outcome.order.orderId : "";
  const confirmed = await save(
    await engine.onCustomerAction(context, {
      operationKey: `confirm:${orderId}:v1`,
      actor: { type: "customer", customerId },
      action: { type: "confirm_order", orderId, version: 1 },
    }),
  );
  expect(confirmed.outcome).toMatchObject({ type: "order_confirmed" });
  return orderId;
}

describe("the pretend engine with its state in D1", () => {
  it("shares orders between isolates: the customer's order is on the other's list, and its listo tells the customer", async () => {
    const store = await seedStore({ members: [] });
    const [consumer, staffSide] = twoIsolates();
    const orderId = await confirmedOrder(consumer, store.businessId, "cust-1");

    const [card] = await staffSide.preparationList(store);
    expect(card).toMatchObject({ customerName: "Ana", order: { orderId, state: "confirmado", version: 1 } });

    const ready = await save(await staffSide.onConsoleAction(member(store.businessId), tap({ type: "mark_ready", orderId, version: 1 })));
    expect(ready.outcome).toMatchObject({ type: "action_saved", order: { state: "listo" } });
    expect(ready.notices).toMatchObject([{ customerId: "cust-1", notice: { type: "order_ready" } }]);
    expect(renderNotice(ready.notices[0]!.notice).body).toBe("¡Tu pedido #101 ya está listo! 🙌 Total: L 18. Ya podés pasar por él.");

    // The consumer's isolate sees the staff tap, for the claim check and for "¿ya está?".
    expect((await consumer.preparationList(store))[0]!.order.state).toBe("listo");
    expect(await consumer.verifyClaims(store, [{ type: "order_state", orderId, version: 1, state: "listo" }])).toEqual([true]);
  });

  it("starts empty, with the demo products' prices, and reads write nothing", async () => {
    const store = await seedStore({ members: [] });
    const [engine] = twoIsolates();
    expect(await engine.preparationList(store)).toEqual([]);
    expect((await engine.catalog(store)).map((product) => product.productId)).toContain("demo-arroz");
    expect(await rows(`SELECT 1 FROM pretend_engine_state WHERE business_id = ?`, store.businessId)).toEqual([]);
  });

  it("a retried job and a double tap save once: nothing to write the second time", async () => {
    const store = await seedStore({ members: [] });
    const [engine] = twoIsolates();
    const context = customer(store.businessId, "cust-1");
    const first = await save(await engine.onBurst(context, RICE_PICKUP, RICE_MATCH));
    const again = await engine.onBurst(context, RICE_PICKUP, RICE_MATCH);
    expect(again.outcome).toEqual(first.outcome);
    expect(again.commits).toEqual([]);
  });

  it("a lost race fails loudly and saves nothing; run again, both updates are kept", async () => {
    const store = await seedStore({ members: [] });
    const [a, b] = twoIsolates();
    const first = await confirmedOrder(a, store.businessId, "cust-1");
    const second = await confirmedOrder(a, store.businessId, "cust-2");
    const staff = member(store.businessId);

    // Both isolates read the same version, then both save.
    const startFirst = await a.onConsoleAction(staff, tap({ type: "start_preparing", orderId: first, version: 1 }));
    const startSecond = tap({ type: "start_preparing", orderId: second, version: 1 });
    const lost = await b.onConsoleAction(staff, startSecond);
    await save(startFirst);
    await expect(save(lost)).rejects.toBeInstanceOf(PretendStateMovedError);
    expect((await a.preparationList(store)).map((card) => card.order.state)).toEqual(["preparando", "confirmado"]);

    // The caller's retry reads the newer state and saves on top of it.
    await save(await b.onConsoleAction(staff, startSecond));
    expect((await a.preparationList(store)).map((card) => card.order.state)).toEqual(["preparando", "preparando"]);
  });

  it("two first writes for a new store: the second fails loudly instead of replacing the first", async () => {
    const store = await seedStore({ members: [] });
    const [a, b] = twoIsolates();
    const one = await a.onBurst(customer(store.businessId, "cust-1"), RICE_PICKUP, RICE_MATCH);
    const two = await b.onBurst(customer(store.businessId, "cust-2"), RICE_PICKUP, RICE_MATCH);
    await save(one);
    await expect(save(two)).rejects.toBeInstanceOf(PretendStateMovedError);
    const [row] = await rows<{ version: number }>(`SELECT version FROM pretend_engine_state WHERE business_id = ?`, store.businessId);
    expect(row!.version).toBe(1);
  });

  it("keeps each store's orders to itself", async () => {
    const storeA = await seedStore({ members: [] });
    const storeB = await seedStore({ members: [] });
    const [a, b] = twoIsolates();
    const orderId = await confirmedOrder(a, storeA.businessId, "cust-1");

    expect(await b.preparationList(storeB)).toEqual([]);
    expect(await b.verifyClaims(storeB, [{ type: "order_state", orderId, version: 1, state: "confirmado" }])).toEqual([false]);
    const foreign = await b.onConsoleAction(member(storeB.businessId), tap({ type: "mark_ready", orderId, version: 1 }));
    expect(foreign).toEqual({ outcome: { type: "rejected", reason: "not_found", order: null }, notices: [], commits: [] });
    expect(await rows(`SELECT 1 FROM pretend_engine_state WHERE business_id = ?`, storeB.businessId)).toEqual([]);
    expect((await a.preparationList(storeA)).map((card) => card.order.orderId)).toEqual([orderId]);
  });
});

describe("PRETEND_ENGINE in the Worker", () => {
  it("picks the engine: D1 with PRETEND_ENGINE (alone or with DEV_CONSOLE), memory with DEV_CONSOLE alone, none without either", () => {
    expect(buildRuntime(pretendEnv()).engine).toBeInstanceOf(D1PretendEngine);
    expect(buildRuntime(pretendEnv({ DEV_CONSOLE: "1" })).engine).toBeInstanceOf(D1PretendEngine);
    expect(buildRuntime(testEnv({ DEV_CONSOLE: "1" } as unknown as Partial<Env>)).engine).toBeInstanceOf(MemoryEngine);
    expect(buildRuntime(testEnv()).engine).toBeNull();
    expect(buildRuntime(pretendEnv()).config).toMatchObject({ pretendEngine: true, devConsole: false });
  });

  it("still asks for login on the console", async () => {
    const h = harness({ env: pretendEnv() });
    expect((await send(h, "/console/preparacion")).status).toBe(401);
    const tapped = await send(h, "/console/acciones", { method: "POST", form: { type: "mark_ready", orderId: "x", version: "1", operationKey: "k", csrf: "dev" } });
    expect(tapped.status).toBe(401);
  });

  it("a staff tap through the console reaches the customer for an order made in another isolate", async () => {
    const store = await storeWithStaff();
    const phone = newPhone();
    const h = harness({ env: pretendEnv() });
    // The customer writes once, so they have a conversation to be told in.
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body: "Hola" })] }));
    const [{ id: customerId }] = (await rows<{ id: string }>(`SELECT id FROM customers WHERE business_id = ?`, store.businessId)) as [{ id: string }];

    const [consumer] = twoIsolates();
    const orderId = await confirmedOrder(consumer, store.businessId, customerId);

    const cookie = await login(h, store.businessId, store.members[1]!.userId);
    const list = await (await send(h, "/console/preparacion", { cookie })).text();
    expect(list).toContain(orderId);
    const response = await send(h, "/console/acciones", {
      method: "POST",
      cookie,
      form: { type: "mark_ready", orderId, version: "1", operationKey: "k-ready", csrf: await csrfFor(h, cookie) },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).not.toContain("aviso=guardar");

    const READY = "¡Tu pedido #101 ya está listo! 🙌 Total: L 18. Ya podés pasar por él.";
    expect(await rows(`SELECT body_text FROM outbound_messages WHERE business_id = ? AND operation_key = 'k-ready'`, store.businessId)).toEqual([
      { body_text: READY },
    ]);
    expect((await consumer.preparationList(store))[0]!.order.state).toBe("listo");
  });
});
