import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { consoleNoticeDedupeKey, runConsoleAction } from "../src/application/console-actions";
import { dispatchOutbox } from "../src/application/dispatch";
import type { MemberContext } from "../src/application/engine";
import type { Pendientes, Tenant } from "../src/application/ports";
import type { ActionEnvelope, ConsoleAction } from "../src/domain/contract/actions";
import type { CustomerNotice, OrderLineView, OrderView } from "../src/domain/contract/outcomes";
import { CUSTOMER_SERVICE_WINDOW_MS } from "../src/domain/outbox";
import { MemoryEngine, type StoredOrder } from "../src/infrastructure/memory/memory-engine";
import { csrfFor, login, send, storeWithStaff } from "./helpers/console";
import { CommitEngine, ensureLinesTable, StaleOrderError, savedLines } from "./helpers/engines";
import { harness, rows } from "./helpers/harness";
import { newPhone, type SeededStore, seedCustomer } from "./helpers/seed";

const READY = "¡Tu pedido ya está listo! 🙌 Total: L 90. Ya podés pasar a traerlo.";

class RecordingPendientes implements Pendientes {
  readonly items: Parameters<Pendientes["raise"]>[1][] = [];
  async raise(_tenant: Tenant, item: Parameters<Pendientes["raise"]>[1]): Promise<void> {
    this.items.push(item);
  }
}

function line(lineId: string, over: Partial<OrderLineView> = {}): OrderLineView {
  return {
    lineId,
    text: "3 lb arroz",
    productId: "p-arroz",
    productName: "Arroz 1 lb",
    quantity: "3",
    unit: "libra",
    unitPrice: 3000,
    availability: "hay",
    restricted: false,
    mark: null,
    substitute: null,
    ...over,
  };
}

function orderView(over: Partial<OrderView> = {}): OrderView {
  return {
    orderId: `order-${crypto.randomUUID()}`,
    version: 1,
    state: "preparando",
    fulfillment: { mode: "pickup" },
    total: 9000,
    queuePosition: 1,
    lines: [line("l1")],
    ...over,
  };
}

/** A customer whose last message reached the store at `lastInboundAtMs`, with their conversation. */
async function customerWithConversation(store: SeededStore, lastInboundAtMs: number) {
  const phone = newPhone();
  const customerId = await seedCustomer(store, phone);
  const conversationId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO conversations (id, business_id, channel_account_id, customer_id, last_inbound_at_ms, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(conversationId, store.businessId, store.channelAccountId, customerId, lastInboundAtMs, lastInboundAtMs)
    .run();
  return { phone, customerId, conversationId };
}

async function setup(options: { lastInboundAgoMs?: number; engine?: "memory" | "commit" } = {}) {
  const store = await storeWithStaff();
  const pendientes = new RecordingPendientes();
  const memory = new MemoryEngine((tenant) => (tenant.businessId === store.businessId ? seeded : []));
  const commit = new CommitEngine();
  const engine = options.engine === "commit" ? commit : memory;
  const h = harness({ engine, pendientes });
  const customer = await customerWithConversation(store, h.clock.now() - (options.lastInboundAgoMs ?? 60_000));
  const order = orderView();
  const seeded: StoredOrder[] = [
    { customerId: customer.customerId, customerName: "Carla", confirmedAtMs: h.clock.now(), changedLineIds: [], order },
  ];
  const member: MemberContext = {
    businessId: store.businessId,
    memberId: store.members[1]!.userId,
    role: "staff",
    canApproveFiado: false,
    nowMs: h.clock.now(),
  };
  const tap = (action: ConsoleAction, operationKey = crypto.randomUUID()): ActionEnvelope<ConsoleAction> => ({
    operationKey,
    actor: { type: "member", memberId: member.memberId, role: member.role },
    action,
  });
  const run = (envelope: ActionEnvelope<ConsoleAction>) => runConsoleAction(h.deps, engine, member, envelope);
  const outbox = () =>
    rows<{ id: string; conversation_id: string; job_id: string | null; operation_key: string | null; body_text: string; status: string; dedupe_key: string; claims_json: string | null }>(
      `SELECT id, conversation_id, job_id, operation_key, body_text, status, dedupe_key, claims_json
       FROM outbound_messages WHERE business_id = ? ORDER BY seq`,
      store.businessId,
    );
  return { store, h, engine, memory, commit, pendientes, customer, order, member, tap, run, outbox };
}

beforeAll(async () => {
  await ensureLinesTable();
});

describe("console taps save with their customer messages", () => {
  it("Listo queues one notice in the customer's conversation, grouped by the operation key, and it is sent", async () => {
    const t = await setup();
    const envelope = t.tap({ type: "mark_ready", orderId: t.order.orderId, version: 1 }, "k-listo");
    const result = await t.run(envelope);

    expect(result.outcome.type).toBe("action_saved");
    const outbox = await t.outbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      conversation_id: t.customer.conversationId,
      job_id: null,
      operation_key: "k-listo",
      body_text: READY,
      status: "pending",
      dedupe_key: consoleNoticeDedupeKey(t.store.businessId, "k-listo", 0, 0),
    });
    // The claim travels with the row, so the second check runs at send time.
    expect(JSON.parse(outbox[0]!.claims_json!)).toEqual([
      { anyOf: [{ type: "order_state", orderId: t.order.orderId, version: 1, state: "listo" }] },
      { anyOf: [{ type: "order_total", orderId: t.order.orderId, version: 1, total: 9000 }] },
    ]);
    expect(result.dispatch).toEqual([{ businessId: t.store.businessId, conversationId: t.customer.conversationId }]);

    await dispatchOutbox(t.h.deps, { limit: 10, conversation: result.dispatch[0]! });
    expect(t.h.sentTo(t.customer.phone)).toEqual([READY]);
    expect(t.pendientes.items).toEqual([]);
  });

  it("a double tap (same operation key) queues one message", async () => {
    const t = await setup();
    const envelope = t.tap({ type: "mark_ready", orderId: t.order.orderId, version: 1 }, "k-double");
    await t.run(envelope);
    const second = await t.run(envelope);

    expect(second.outcome.type).toBe("duplicate");
    expect(await t.outbox()).toHaveLength(1);
  });

  it("an engine that returns the same notice twice still queues one: the dedupe key is the store and the operation key", async () => {
    const t = await setup({ engine: "commit" });
    t.commit.notices = [{ customerId: t.customer.customerId, notice: { type: "order_ready", order: { ...t.order, state: "listo" } } }];
    const envelope = t.tap({ type: "mark_ready", orderId: t.order.orderId, version: 1 }, "k-again");
    await t.run(envelope);
    await t.run(envelope);
    expect((await t.outbox()).map((row) => row.body_text)).toEqual([READY]);
  });

  it("a stale version queues nothing", async () => {
    const t = await setup();
    const result = await t.run(t.tap({ type: "mark_ready", orderId: t.order.orderId, version: 2 }));
    expect(result.outcome).toMatchObject({ type: "rejected", reason: "stale_version" });
    expect(result.dispatch).toEqual([]);
    expect(await t.outbox()).toEqual([]);
  });

  it("saves the engine's commits and the notice together", async () => {
    const t = await setup({ engine: "commit" });
    t.commit.notices = [{ customerId: t.customer.customerId, notice: { type: "order_ready", order: { ...t.order, state: "listo" } } }];
    await t.run(t.tap({ type: "mark_ready", orderId: t.order.orderId, version: 1 }, "k-commit"));
    expect(await savedLines(t.store.businessId)).toEqual(["mark_ready"]);
    expect(await t.outbox()).toHaveLength(1);
  });

  it("a commit guard that fails saves nothing at all: no engine change, no outbox row", async () => {
    const t = await setup({ engine: "commit" });
    t.commit.notices = [{ customerId: t.customer.customerId, notice: { type: "order_ready", order: { ...t.order, state: "listo" } } }];
    t.commit.failGuard = true;

    await expect(t.run(t.tap({ type: "mark_ready", orderId: t.order.orderId, version: 1 }))).rejects.toBeInstanceOf(
      StaleOrderError,
    );
    expect(await savedLines(t.store.businessId)).toEqual([]);
    expect(await t.outbox()).toEqual([]);
    expect(await rows(`SELECT * FROM batch_guards`)).toEqual([]);
  });

  it("through the route, a refused save tells the staff on the order's page and queues nothing", async () => {
    const t = await setup({ engine: "commit" });
    t.commit.notices = [{ customerId: t.customer.customerId, notice: { type: "order_ready", order: { ...t.order, state: "listo" } } }];
    t.commit.failGuard = true;
    const cookie = await login(t.h, t.store.businessId, t.store.members[1]!.userId);
    const response = await send(t.h, "/console/acciones", {
      method: "POST",
      cookie,
      form: { type: "mark_ready", orderId: t.order.orderId, version: "1", operationKey: "k-route", csrf: await csrfFor(t.h, cookie) },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/console/preparacion/${t.order.orderId}?aviso=guardar`);
    expect(await t.outbox()).toEqual([]);
    expect(t.h.channel.sent).toEqual([]);
  });

  it("outside the 24-hour window the notice waits and raises a Pendientes item; it goes out when the customer writes", async () => {
    const t = await setup({ lastInboundAgoMs: CUSTOMER_SERVICE_WINDOW_MS + 60_000 });
    const result = await t.run(t.tap({ type: "mark_ready", orderId: t.order.orderId, version: 1 }));

    const [row] = await t.outbox();
    expect(row).toMatchObject({ status: "waiting_window", body_text: READY });
    expect(result.dispatch).toEqual([]);
    expect(t.pendientes.items).toEqual([
      { kind: "notice_waiting_window", conversationId: t.customer.conversationId, outboxId: row!.id, notice: "order_ready" },
    ]);
    const conversation = { businessId: t.store.businessId, conversationId: t.customer.conversationId };
    await dispatchOutbox(t.h.deps, { limit: 10, conversation });
    expect(t.h.sentTo(t.customer.phone)).toEqual([]);

    // The customer writes: the window opens and the waiting notice goes out once.
    await env.DB.prepare(`UPDATE conversations SET last_inbound_at_ms = ? WHERE id = ?`)
      .bind(t.h.clock.now(), t.customer.conversationId)
      .run();
    await dispatchOutbox(t.h.deps, { limit: 10, conversation });
    await dispatchOutbox(t.h.deps, { limit: 10, conversation });
    expect(t.h.sentTo(t.customer.phone)).toEqual([READY]);
  });

  it("another store's order can't be targeted from this store's session", async () => {
    const a = await setup();
    const other = await storeWithStaff();
    const h = harness({ engine: a.memory });
    const cookie = await login(h, other.businessId, other.members[1]!.userId);
    const response = await send(h, "/console/acciones", {
      method: "POST",
      cookie,
      form: { type: "mark_ready", orderId: a.order.orderId, version: "1", operationKey: "k-cross", csrf: await csrfFor(h, cookie) },
    });

    expect(response.headers.get("location")).toBe("/console/preparacion?aviso=falta");
    expect(await a.outbox()).toEqual([]);
    expect(await rows(`SELECT id FROM outbound_messages WHERE business_id = ?`, other.businessId)).toEqual([]);
    expect((await a.memory.preparationList({ businessId: a.store.businessId }))[0]!.order.state).toBe("preparando");
  });

  it("a notice naming another store's customer is never queued", async () => {
    const t = await setup({ engine: "commit" });
    const elsewhere = await storeWithStaff();
    const stranger = await customerWithConversation(elsewhere, t.h.clock.now());
    t.commit.notices = [{ customerId: stranger.customerId, notice: { type: "order_ready", order: { ...t.order, state: "listo" } } }];

    await t.run(t.tap({ type: "mark_ready", orderId: t.order.orderId, version: 1 }));
    expect(await t.outbox()).toEqual([]);
    expect(await rows(`SELECT id FROM outbound_messages WHERE business_id = ?`, elsewhere.businessId)).toEqual([]);
  });

  it("a notice row that ends unsent stops the rest of its action's group, and nothing else", async () => {
    const t = await setup({ engine: "commit" });
    const listo = { ...t.order, state: "listo" } as const;
    t.commit.notices = [
      { customerId: t.customer.customerId, notice: { type: "line_unavailable", order: t.order, lineId: "l1" } },
      { customerId: t.customer.customerId, notice: { type: "order_ready", order: listo } },
    ] satisfies CustomerNotice[];
    await t.run(t.tap({ type: "mark_ready", orderId: t.order.orderId, version: 1 }, "k-group"));
    // A second action's notice in the same conversation is another group.
    t.commit.notices = [{ customerId: t.customer.customerId, notice: { type: "order_ready", order: listo } }];
    await t.run(t.tap({ type: "mark_ready", orderId: t.order.orderId, version: 1 }, "k-other"));

    const [first] = await t.outbox();
    await env.DB.prepare(`UPDATE outbound_messages SET status = 'failed' WHERE id = ?`).bind(first!.id).run();
    await t.h.deps.outbox.maintain(t.h.clock.now());

    expect((await t.outbox()).map((row) => [row.operation_key, row.status])).toEqual([
      ["k-group", "failed"],
      ["k-group", "failed"],
      ["k-other", "pending"],
    ]);
  });

  it("logs IDs only", async () => {
    const t = await setup();
    await t.run(t.tap({ type: "mark_ready", orderId: t.order.orderId, version: 1 }));
    expect(t.h.log.lines.join("\n")).not.toMatch(/listo\. Total|Carla|arroz/i);
    expect(t.h.log.lines.join("\n")).not.toContain(t.customer.phone);
  });
});
