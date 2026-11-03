/**
 * WhatsApp test commands (/new, /help) for testing as a brand-new customer from a real phone. Two
 * locks, both required, checked by code before any model call: TEST_COMMANDS is "1", and the
 * sender's phone is a member of the store that owns the number. Otherwise the text is an ordinary
 * customer message, with no hint that commands exist. Local D1, the real Worker, no network.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CustomerContext } from "../src/application/engine";
import type { ModelProvider, ModelRequest } from "../src/application/ports";
import { MemoryEngine, type PretendProduct } from "../src/infrastructure/memory/memory-engine";
import { harness, rows, testEnv } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const RESET = "Listo, empezás como cliente nuevo. Escribime como si fuera la primera vez.";
const WELCOME = "Te tomo el pedido y te aviso cuando esté listo. ¿Qué te mando?";
const CATALOG: readonly PretendProduct[] = [{ productId: "p-arroz", names: ["Arroz 1 lb"], aliases: [], barcode: null, price: 1800 }];

/** Reads anything as "other", and counts the calls: a command must never reach it. */
class CountingProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  async complete(request: ModelRequest) {
    this.requests.push(request);
    return { ok: true, json: { observations: [{ kind: "other", issues: [] }] }, latencyMs: 1, inputTokens: 1, outputTokens: 1 } as const;
  }
}

async function shop(options: { readonly flag: boolean; readonly member: "this" | "other" | "none" }) {
  const phone = newPhone();
  const store = await seedStore({ members: options.member === "this" ? [{ phone, role: "owner" }] : [] });
  if (options.member === "other") await seedStore({ members: [{ phone, role: "staff" }] });
  const engine = new MemoryEngine(() => [], { catalog: CATALOG });
  const provider = new CountingProvider();
  const h = harness({ engine, modelProvider: provider, env: testEnv((options.flag ? { TEST_COMMANDS: "1" } : {}) as unknown as Partial<Env>) });
  const tenant = { businessId: store.businessId };
  const say = async (body: string) => {
    h.clock.advance(1_000);
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body })] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
    return h.sentTo(phone).at(-1) ?? "";
  };
  const customer = async () =>
    (await rows<{ id: string; name: string | null; introduced_at_ms: number | null }>(
      `SELECT id, name, introduced_at_ms FROM customers WHERE business_id = ? AND phone = ?`,
      store.businessId,
      phone,
    ))[0]!;
  /** A known customer: introduced, named, with a saved place and a confirmed order on the list. */
  const regular = async () => {
    await say("Hola");
    const { id } = await customer();
    const [conversation] = await rows<{ id: string }>(`SELECT id FROM conversations WHERE business_id = ? AND customer_id = ?`, store.businessId, id);
    await env.DB.prepare(`UPDATE customers SET name = 'Ana', name_saved_at_ms = 1 WHERE id = ?`).bind(id).run();
    await env.DB.prepare(`INSERT INTO customer_places (id, business_id, customer_id, place_text, order_id, created_at_ms, last_used_at_ms) VALUES (?, ?, ?, 'frente a la iglesia', 'old-order', 1, 1)`)
      .bind(crypto.randomUUID(), store.businessId, id)
      .run();
    const context: CustomerContext = { businessId: store.businessId, conversationId: conversation!.id, customerId: id, jobId: "seed", nowMs: 1 };
    const evidence = { source: "text", message: 0, start: 0, end: 1 } as const;
    const readback = await engine.onBurst(
      context,
      {
        observations: [
          { kind: "customer_order", lines: [{ text: "2 arroz", name: "arroz", quantity: "2", unit: null, restrictedCategory: false, evidence }], issues: [] },
          { kind: "fulfillment", mode: "pickup", pin: null, placeText: null, sameAsBefore: false, issues: [] },
        ],
        calls: [],
      },
      [],
    );
    const order = (readback.outcome as { order: { orderId: string; version: number } }).order;
    await engine.onCustomerAction({ ...context, jobId: "seed-confirm", customerName: "Ana" } as CustomerContext, {
      action: { type: "confirm_order", orderId: order.orderId, version: order.version },
      actor: { type: "customer", customerId: id },
      operationKey: `confirm:${order.orderId}:v${order.version}`,
    });
    expect(await engine.preparationList(tenant)).toHaveLength(1);
    return id;
  };
  return { h, store, tenant, phone, engine, provider, say, customer, regular };
}

describe("/new for a member of the store, with TEST_COMMANDS on", () => {
  it("makes the sender a new customer: order cancelled, name and places gone, the next Hola gets the welcome", async () => {
    const s = await shop({ flag: true, member: "this" });
    const id = await s.regular();
    expect(await s.say("/new")).toBe(RESET);
    expect(s.provider.requests).toEqual([]);
    expect(await s.engine.preparationList(s.tenant)).toEqual([]);
    expect(await s.customer()).toMatchObject({ id, name: null, introduced_at_ms: null });
    expect(await rows(`SELECT 1 FROM customer_places WHERE business_id = ? AND customer_id = ?`, s.store.businessId, id)).toEqual([]);
    expect(await s.say("Hola")).toContain(WELCOME);
    expect(s.h.log.fields("test_command")).toEqual([expect.objectContaining({ businessId: s.store.businessId, reason: "new", outcome: "reset" })]);
  });

  it("twice: one reset, two harmless replies", async () => {
    const s = await shop({ flag: true, member: "this" });
    await s.regular();
    expect(await s.say("/new")).toBe(RESET);
    expect(await s.say("/nuevo")).toBe(RESET);
    expect(s.h.log.fields("test_command").map((f) => f.outcome)).toEqual(["reset", "already_new"]);
    expect(await s.say("Hola")).toContain(WELCOME);
  });

  it("/help lists the commands, one line each", async () => {
    const s = await shop({ flag: true, member: "this" });
    await s.say("Hola");
    const help = await s.say("/ayuda");
    expect(help.split("\n")).toEqual([
      "Comandos de prueba:",
      "/new (o /nuevo, /reset): empezás como cliente nuevo.",
      "/help (o /ayuda): esta lista.",
    ]);
    expect(s.provider.requests).toEqual([]);
  });
});

describe("without both locks, a command is an ordinary customer message", () => {
  it.each([
    ["a sender who isn't a member", { flag: true, member: "none" }],
    ["a member with TEST_COMMANDS off", { flag: false, member: "this" }],
    ["a member of another store", { flag: true, member: "other" }],
  ] as const)("%s: read like any message, nothing reset", async (_label, options) => {
    const s = await shop(options);
    const id = await s.regular();
    const before = s.provider.requests.length;
    const reply = await s.say("/new");
    expect(reply).not.toBe(RESET);
    expect(reply).not.toContain("Comandos");
    expect(s.provider.requests.length).toBe(before + 1);
    expect(await s.customer()).toMatchObject({ id, name: "Ana" });
    expect(await s.engine.preparationList(s.tenant)).toHaveLength(1);
    expect(s.h.log.fields("test_command")).toEqual([]);
  });
});
