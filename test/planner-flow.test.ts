/**
 * The planner path end to end: the pretend engine applying a validated plan, the reply blocks, and
 * the whole trip on local D1 with recorded model answers (no network): a photo of a list with no
 * quantities → one quantities question → the answer → the readback with "(te puse 1)" → Confirmar
 * saves once. A planner that fails leaves the burst to the classic path, and says so in the logs.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CustomerContext } from "../src/application/engine";
import type { BurstMediaResolver } from "../src/application/order-reading";
import { planTurn } from "../src/application/planner/plan-turn";
import type { ModelProvider, ModelRequest } from "../src/application/ports";
import type { BurstReading, ItemLine, Observation } from "../src/domain/contract/observation";
import type { EngineOutcome, OrderLineView, OrderView } from "../src/domain/contract/outcomes";
import { orderBasis } from "../src/domain/planner/frame";
import type { TurnPlan } from "../src/domain/planner/types";
import { echoBlock, firstCheck, renderOutcome } from "../src/domain/replies";
import { D1RetrievalRepository } from "../src/infrastructure/d1/retrieval-repository";
import { D1StoreSetupRepository } from "../src/infrastructure/d1/store-setup-repository";
import { D1PretendEngine } from "../src/infrastructure/memory/d1-pretend-engine";
import { MemoryEngine, type PretendProduct } from "../src/infrastructure/memory/memory-engine";
import { box, line as wireLine, photo, quote } from "./fixtures/model/recorded";
import { RecordingLogger } from "./helpers/fakes";
import { harness, rows, testEnv } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { buttonReply, imageMessage, textMessage, wamid, webhook } from "./helpers/whatsapp";

const CATALOG: readonly PretendProduct[] = [
  { productId: "p-arroz", names: ["Arroz 1 lb"], aliases: [], barcode: null, price: 1800 },
  { productId: "p-salsa", names: ["Salsa de tomate Naturas 400 g"], aliases: [], barcode: null, price: 2800 },
  { productId: "p-tomate", names: ["Tomate"], aliases: [], barcode: null, price: 500 },
  { productId: "p-papel", names: ["Papel higiénico 4 rollos"], aliases: [], barcode: null, price: 4800 },
  { productId: "p-clover", names: ["Aceite Clover 1 L"], aliases: [], barcode: null, price: 6000 },
  { productId: "p-mazola", names: ["Aceite Mazola 1 L"], aliases: [], barcode: null, price: 6500 },
  { productId: "p-pollo", names: ["Pollo entero"], aliases: [], barcode: null, price: 4500, soldBy: "weight" },
];

const evidence = { source: "text", message: 0, start: 0, end: 1 } as const;
const item = (name: string, quantity: string | null = null, unit: string | null = null): ItemLine => ({
  text: name,
  name,
  quantity,
  unit,
  restrictedCategory: false,
  evidence,
});
const order = (...lines: ItemLine[]): Observation => ({ kind: "customer_order", lines, issues: [] });
const pickup: Observation = { kind: "fulfillment", mode: "pickup", pin: null, placeText: null, sameAsBefore: false, issues: [] };
const answer = (said: string): Observation => ({ kind: "clarification", answer: said, evidence, issues: [] });
/** A plan for the customer's next burst; `basis` is filled with the open order as it is then. */
const plan = (more: Partial<TurnPlan>): Omit<TurnPlan, "basis"> & { basis?: string | null } => ({ move: "ask", ask: null, assumed: [], say: "", ...more });

function customer(engine = new MemoryEngine(() => [], { catalog: CATALOG })) {
  let job = 0;
  const context = (): CustomerContext => ({ businessId: "store-1", conversationId: "conv-1", customerId: "cust-1", jobId: `job-${++job}`, nowMs: 1_000 * job });
  return {
    engine,
    burst: async (observations: Observation[], turn?: ReturnType<typeof plan>): Promise<EngineOutcome> => {
      const reading: BurstReading = { observations, calls: [] };
      if (turn === undefined) return (await engine.onBurst(context(), reading, [])).outcome;
      const basis = turn.basis !== undefined ? turn.basis : orderBasis((await engine.plannerContext(context())).order);
      return (await engine.onBurst(context(), reading, [], { ...turn, basis })).outcome;
    },
    confirm: async (orderId: string, version: number) =>
      (
        await engine.onCustomerAction({ ...context(), customerName: "Ana" } as CustomerContext, {
          action: { type: "confirm_order", orderId, version },
          actor: { type: "customer", customerId: "cust-1" },
          operationKey: `confirm:${orderId}:v${version}`,
        })
      ).outcome,
  };
}

const orderOf = (outcome: EngineOutcome): OrderView => ("order" in outcome ? outcome.order : null)!;
const body = (outcome: EngineOutcome) => renderOutcome(outcome, { customerId: "cust-1" })!.body;

describe("the pretend engine with a plan", () => {
  it("skips its own questions and catalog search: a typo or a few fits stay unmatched, and the plan's question is asked", async () => {
    const c = customer();
    const asked = await c.burst([order(item("pollo"), item("aciete"), item("tomates"))], plan({ ask: { kind: "quantities", lineRefs: ["N1", "N3"] } }));
    const lines = orderOf(asked).lines;
    expect(lines.map((l) => l.productId)).toEqual([null, null, null]);
    expect(asked).toMatchObject({ type: "ask", question: "quantities", questions: { kind: "quantities", lineIds: [lines[0]!.lineId, lines[2]!.lineId] } });
  });

  it("takes the planner's pick for a new item, as a match", async () => {
    const c = customer();
    const reading: BurstReading = { observations: [order(item("tomates", "4")), pickup], calls: [] };
    const result = await c.engine.onBurst(
      { businessId: "store-1", conversationId: "conv-1", customerId: "cust-1", jobId: "j1", nowMs: 1 },
      reading,
      [{ observation: 0, line: 0, productId: "p-tomate", how: "planner_pick" }],
      { ...plan({ move: "readback" }), basis: null },
    );
    expect(result.outcome).toMatchObject({ type: "readback", order: { state: "por_confirmar", lines: [{ productId: "p-tomate", unitPrice: 500 }], total: 2000 } });
  });

  it("reads back a quantity in pounds for a product sold by weight, or a weight the customer said", async () => {
    const c = customer();
    const readback = await c.burst(
      [order(item("pollo", "2"), item("chuleta", "1.5", "libras"), item("arroz", "3", "libra")), pickup],
      plan({ move: "readback", changes: [{ lineRef: "N1", productId: "p-pollo" }] }),
    );
    expect(body(readback)).toContain("• 2 libras de Pollo entero · L 90");
    expect(body(readback)).toContain("• 1.5 libras de chuleta: te confirmo si hay y el precio.");
    expect(body(readback)).toContain("• 3 libras de arroz: te confirmo si hay y el precio.");
    // Classic: a count, as before.
    const classic = customer();
    await classic.burst([order(item("Pollo entero", "2")), pickup]);
    expect(body(await classic.burst([]))).toContain("• 2 × Pollo entero · L 90");
  });

  it("keeps the last word on readiness: a readback with pickup or delivery unknown asks it", async () => {
    const c = customer();
    const asked = await c.burst([order(item("arroz", "2"))], plan({ move: "readback" }));
    expect(asked).toMatchObject({ type: "ask", question: "pickup_or_delivery", questions: { kind: "fulfillment", lineIds: [] } });
    expect(body(asked)).toBe("Anotado ✅ 2 × arroz.\n¿Lo recogés en la tienda o te lo llevamos?");
  });

  it("applies an assumed 1 openly, restates its question with no plan, and moves on after asking twice", async () => {
    const c = customer();
    const asked = await c.burst(
      [order(item("piña"), item("platanos")), pickup],
      plan({ ask: { kind: "quantities", lineRefs: ["N2"] }, assumed: [{ lineRef: "N1", quantity: "1", source: "suggested" }] }),
    );
    const [pina, platanos] = orderOf(asked).lines;
    expect(pina).toMatchObject({ quantity: "1", quantitySource: "suggested" });
    expect(asked).toMatchObject({ question: "quantity", assumed: [pina!.lineId] });
    expect(body(asked)).toBe("Te puse 1 de piña. Si querés más, decime.\n¿Cuánto querés de platanos?");
    // "ok" (no plan): the same question again, never the classic queue's.
    const again = await c.burst([]);
    expect(again).toMatchObject({ type: "ask", questions: { kind: "quantities", lineIds: [platanos!.lineId] } });
    // Asked twice: the order moves on, the quantity unknown, never made up.
    const readback = await c.burst([]);
    expect(readback.type).toBe("readback");
    expect(body(readback)).toContain("• 1 × piña (te puse 1): te confirmo si hay y el precio.");
    expect(body(readback)).toContain("• platanos: falta la cantidad.");
    const confirmed = await c.confirm(orderOf(readback).orderId, orderOf(readback).version);
    expect(orderOf(confirmed).lines[0]).toEqual(expect.not.objectContaining({ quantitySource: expect.anything() }));
    expect(orderOf(confirmed).lines[0]!.quantity).toBe("1");
  });

  it("asks which one with the plan's products, then takes a pick and a quantity for an order line", async () => {
    const c = customer();
    const asked = await c.burst([order(item("aceite")), pickup], plan({ ask: { kind: "options", lineRefs: ["N1"] }, options: [{ lineRef: "N1", productIds: ["p-clover", "p-mazola"] }] }));
    expect(body(asked)).toBe(["Para aceite tengo:", "1. Aceite Clover 1 L · L 60", "2. Aceite Mazola 1 L · L 65", "¿Cuál te mando? Respondé con el número o el nombre."].join("\n"));
    const picked = await c.burst([answer("el 2")], plan({ changes: [{ lineRef: "L1", productId: "p-mazola" }], ask: { kind: "quantities", lineRefs: ["L1"] } }));
    expect(orderOf(picked).lines[0]).toMatchObject({ productId: "p-mazola", productName: "Aceite Mazola 1 L", unitPrice: 6500 });
    expect(body(picked)).toBe("¿Cuánto querés de Aceite Mazola 1 L?");
    const readback = await c.burst([answer("dos")], plan({ move: "readback", changes: [{ lineRef: "L1", quantity: "2" }] }));
    expect(readback).toMatchObject({ type: "readback", order: { total: 13000, lines: [{ quantity: "2" }] } });
  });

  it("removes an order line the plan removes; with none left, asks what to order", async () => {
    const c = customer();
    await c.burst([order(item("arroz", "2")), pickup], plan({ move: "readback" }));
    const empty = await c.burst([answer("quitame el arroz")], plan({ move: "readback", changes: [{ lineRef: "L1", remove: true }] }));
    expect(empty).toMatchObject({ type: "ask", question: "what_to_order", order: { lines: [] } });
  });

  it("hands off to the owner, keeping what the burst added for after", async () => {
    const c = customer();
    const handed = await c.burst([order(item("arroz", "2"))], plan({ move: "handoff" }));
    expect(handed).toEqual({ type: "handoff" });
    const context = await c.engine.plannerContext({ businessId: "store-1", conversationId: "conv-1", customerId: "cust-1", jobId: "x", nowMs: 1 });
    expect(context.order).toMatchObject({ state: "armando", lines: [{ text: "arroz", quantity: "2" }] });
  });

  it("without a plan, a draft that never had one keeps the classic shape: no planner marks in its state", async () => {
    const c = customer();
    await c.burst([order(item("aceite", "1"))]);
    const json = JSON.stringify(c.engine.exportStore({ businessId: "store-1" }));
    expect(json).not.toContain("planned");
    expect(json).not.toContain("quantitySource");
  });
});

// ---------------------------------------------------------------------------------------------

const view = (lineId: string, text: string, more: Partial<OrderLineView> = {}): OrderLineView => ({
  lineId,
  text,
  productId: null,
  productName: null,
  quantity: null,
  unit: null,
  unitPrice: null,
  availability: "no_se",
  restricted: false,
  mark: null,
  substitute: null,
  ...more,
});
const building = (lines: OrderLineView[]): OrderView => ({ orderId: "o-1", version: 1, state: "armando", lines, fulfillment: null, total: null, queuePosition: null });

describe("reply blocks (planner path)", () => {
  it("echoes up to four names, then counts the rest: never 'tus N productos'", () => {
    const lines = ["Plátanos", "Piña", "Sandía", "Catsup", "Arroz", "Sal"].map((name, n) => view(`l${n}`, name));
    expect(echoBlock(lines)).toBe("Anotado ✅ Plátanos, Piña, Sandía, Catsup y 2 más.");
    expect(echoBlock(lines.slice(0, 2))).toBe("Anotado ✅ Plátanos, Piña.");
  });

  it("accounts for every item once: the one being asked about is named in the question, not dropped from a count", () => {
    const names = ["arroz", "frijoles", "azucar", "cafe", "leche", "huevos", "jabon", "pan", "aceite", "cebolla", "sal"];
    const order = building(names.map((name, n) => view(`l${n}`, name, { quantity: "1" })));
    const outcome: EngineOutcome = { type: "ask", question: "illegible", line: 10, order, questions: { kind: "unreadable", lineIds: ["l10"] } };
    expect(body(outcome)).toBe("Anotado ✅ 1 × arroz, 1 × frijoles, 1 × azucar, 1 × cafe y 6 más.\nNo alcancé a leer bien sal. ¿Me lo escribís?");
  });

  it("asks every missing quantity in one message, weighed ones in pounds", () => {
    const order = building([view("a", "plátanos"), view("b", "pollo"), view("c", "tomates"), view("d", "Arroz 1 lb", { quantity: "2", productName: "Arroz 1 lb", productId: "p-arroz", unitPrice: 1800 })]);
    const outcome: EngineOutcome = { type: "ask", question: "quantities", line: 0, order, questions: { kind: "quantities", lineIds: ["a", "b", "c"], byWeight: ["b"] } };
    expect(body(outcome)).toBe(
      [
        "Anotado ✅ 2 × Arroz 1 lb.",
        "¿Cuántos querés de estos?",
        "• plátanos",
        "• pollo (¿cuántas libras?)",
        "• tomates",
        "Escribime todo junto, por ejemplo: «2 plátanos, 1 libra de pollo».",
      ].join("\n"),
    );
  });

  it("asks every 'which one' in one message, numbered on from line to line, each price a backed claim", () => {
    const order = building([view("a", "aceite"), view("b", "salsa")]);
    const outcome: EngineOutcome = {
      type: "ask",
      question: "ambiguous_product",
      line: 0,
      order,
      questions: {
        kind: "options",
        lineIds: ["a", "b"],
        options: {
          a: [
            { productId: "p-clover", name: "Aceite Clover 1 L", unitPrice: 6000 },
            { productId: "p-mazola", name: "Aceite Mazola 1 L", unitPrice: 6500 },
          ],
          b: [
            { productId: "p-salsa", name: "Salsa de tomate Naturas 400 g", unitPrice: 2800 },
            { productId: "p-salsa-2", name: "Salsa de tomate Naturas 200 g", unitPrice: null },
          ],
        },
      },
    };
    const rendered = renderOutcome(outcome, { customerId: "cust-1" })!;
    expect(rendered.body).toBe(
      [
        "Para aceite tengo:",
        "1. Aceite Clover 1 L · L 60",
        "2. Aceite Mazola 1 L · L 65",
        "Para salsa tengo:",
        "3. Salsa de tomate Naturas 400 g · L 28",
        "4. Salsa de tomate Naturas 200 g",
        "¿Cuál te mando? Respondé con el número o el nombre.",
      ].join("\n"),
    );
    expect(rendered.claims).toHaveLength(4);
    expect(firstCheck(rendered.claims, { kind: "outcome", outcome, customerId: "cust-1" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The whole trip on local D1

const LIST_PHOTO = "lista";
/** Planner mode: the reader proposes other names for each item; none here. */
const NONE = { other_names: [] };
const said = (index: number) => box(0, [0.1, 0.1 + index * 0.08, 0.6, 0.16 + index * 0.08]);
const READINGS = {
  list: {
    observations: [
      {
        kind: "customer_order",
        lines: [
          wireLine("platanos", "platanos", null, null, said(0), NONE),
          wireLine("pollo", "pollo", null, null, said(1), NONE),
          wireLine("tomates", "tomates", null, null, said(2), NONE),
          wireLine("1 lb arroz", "arroz", "1", "libra", said(3), NONE),
          wireLine("piña", "piña", null, null, said(4), NONE),
          wireLine("salsa", "salsa", null, null, said(5), NONE),
        ],
        issues: [],
      },
      { kind: "fulfillment", mode: "pickup", place_text: null, same_as_before: false, issues: [] },
    ],
  },
  quantities: {
    observations: [{ kind: "clarification", answer: "6 platanos, 2 libras de pollo y 4 tomates", pick: null, quantity: null, evidence: quote(0, "6 platanos, 2 libras de pollo y 4 tomates"), issues: [] }],
  },
};
const op = (kind: string, line: string, product: string | null = null, quantity: string | null = null, suggested: string | null = null) => ({
  op: kind,
  line,
  product,
  quantity,
  suggested_quantity: suggested,
});
// L1's retrieval offers, in order: N2 pollo → P1 Pollo entero (all words); N3 tomates → P2 Tomate (its name,
// standing alone); N4 arroz → P3 Arroz 1 lb; N6 salsa → P4 Salsa (all words, the only one, so 1 may be suggested).
// Platanos and piña find nothing.
const PLANS = {
  list: {
    ops: [op("add", "N1"), op("add", "N2", "P1"), op("add", "N3", "P2"), op("add", "N4", "P3", "1"), op("add", "N5", null, null, "1"), op("add", "N6", "P4", null, "1")],
    move: "ask",
    ask: { kind: "quantities", lines: ["N1", "N2", "N3"] },
    say: "Ya vi tu lista 👍",
  },
  quantities: {
    ops: [op("set_quantity", "L1", null, "6"), op("set_quantity", "L2", null, "2"), op("set_quantity", "L3", null, "4")],
    move: "readback",
    ask: { kind: "none", lines: [] },
    say: "Va 👍",
  },
};

/** Muse Spark's place: readings for the reader's calls, plans for the planner's. Never the network. */
class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  constructor(
    private readonly readings: unknown[],
    private readonly plans: unknown[],
  ) {}
  async complete(request: ModelRequest) {
    this.requests.push(request);
    const json = (request.schemaName === "TurnProposal" ? this.plans : this.readings).shift();
    if (json === undefined) throw new Error(`no recorded ${request.schemaName} left`);
    return { ok: true, json, latencyMs: 4_000, inputTokens: 3_000, outputTokens: 900 } as const;
  }
  textOf(n: number): string {
    return this.requests[n]!.user.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  }
}

const media: BurstMediaResolver = { async resolve() { return photo(); } };

/** The store's own products, as the owner sets them up in Tienda: names, prices, how each is sold. */
const STORE: readonly { name: string; price: number; soldBy?: "unit" | "weight" }[] = [
  { name: "Arroz 1 lb", price: 1800, soldBy: "unit" },
  { name: "Salsa de tomate Naturas 400 g", price: 2800 },
  { name: "Tomate", price: 500 },
  { name: "Papel higiénico 4 rollos", price: 4800 },
  { name: "Pollo entero", price: 4500, soldBy: "weight" },
];

async function plannerTrip(readings: unknown[], plans: unknown[]) {
  const owner = newPhone();
  const store = await seedStore({ members: [{ phone: owner, role: "owner" }] });
  const tenant = { businessId: store.businessId };
  const phone = newPhone();
  const customerId = crypto.randomUUID();
  // Introduced, and the name was asked on an earlier order: Confirmar confirms at once.
  await env.DB.prepare(`INSERT INTO customers (id, business_id, phone, created_at_ms, introduced_at_ms, name_asked_at_ms) VALUES (?, ?, ?, 0, 1, 1)`)
    .bind(customerId, store.businessId, phone)
    .run();
  const setup = new D1StoreSetupRepository(env.DB);
  for (const product of STORE) await setup.addProduct(tenant, { name: product.name, otherNames: [], price: product.price }, 1);
  const products = await setup.listProducts(tenant);
  for (const product of STORE.filter((p) => p.soldBy !== undefined)) {
    const saved = products.find((p) => p.name === product.name)!;
    await setup.updateProduct(tenant, saved.productId, { name: saved.name, otherNames: [], price: saved.price }, 2, { soldBy: product.soldBy!, usualQuantity: null });
  }
  const engine = new D1PretendEngine(env.DB, { setup });
  const provider = new RecordedProvider(readings, plans);
  const h = harness({ engine, modelProvider: provider, burstMedia: media, env: testEnv({ CONVERSATION: "planner", PLANNER_FAST_TEXT: "0" } as unknown as Partial<Env>) });
  const at = () => ({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000) });
  const burst = async (...messages: unknown[]) => {
    h.clock.advance(1_000);
    for (const message of messages) {
      h.clock.advance(200);
      await h.post(webhook(store.phoneNumberId, { messages: [message] }));
    }
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
  };
  return { h, store, phone, customerId, engine, provider, at, burst, tenant, productIds: products.map((p) => p.productId) };
}

const aliasesOf = (businessId: string) =>
  rows<{ said: string; name: string; state: string; source: string; source_order_id: string | null }>(
    `SELECT a.said, p.name, a.state, a.source, a.source_order_id FROM store_aliases a
     JOIN store_products p ON p.business_id = a.business_id AND p.id = a.product_id WHERE a.business_id = ? ORDER BY a.said`,
    businessId,
  );

describe("the planner path on local D1, from a photo of a list to one confirmed order", () => {
  it("asks every quantity at once, reads back what it assumed, and Confirmar saves once", async () => {
    const t = await plannerTrip([READINGS.list, READINGS.quantities], [PLANS.list, PLANS.quantities]);

    await t.burst(imageMessage({ ...t.at(), mediaId: LIST_PHOTO }), textMessage({ ...t.at(), body: "lo paso a traer" }));
    expect(t.h.sentTo(t.phone)).toEqual([
      [
        "Ya vi tu lista 👍",
        "Anotado ✅ 1 × Arroz 1 lb.",
        "Te puse 1 de piña y Salsa de tomate Naturas 400 g. Si querés más, decime.",
        "¿Cuántos querés de estos?",
        "• platanos",
        "• Pollo entero (¿cuántas libras?)",
        "• Tomate",
        "Escribime todo junto, por ejemplo: «2 platanos, 1 libra de pollo entero».",
      ].join("\n"),
    ]);

    await t.burst(textMessage({ ...t.at(), body: "6 platanos, 2 libras de pollo y 4 tomates" }));
    const readback = t.h.channel.sent.filter((sent) => sent.toPhone === t.phone).at(-1)!;
    expect(readback.body).toBe(
      [
        "Va 👍",
        "Tu pedido:",
        "• 6 × platanos: te confirmo si hay y el precio.",
        "• 2 libras de Pollo entero · L 90",
        "• 4 × Tomate · L 20",
        "• 1 × Arroz 1 lb · L 18",
        "• 1 × piña (te puse 1): te confirmo si hay y el precio.",
        "• 1 × Salsa de tomate Naturas 400 g (te puse 1) · L 28",
        "Lo recogés en la tienda.",
        "El total te lo confirmo.",
        "Pagás cuando lo recogés.",
        "¿Te lo preparo así?",
        "_O escribí: confirmar, corregir o cancelar._",
      ].join("\n"),
    );
    const confirm = readback.buttons!.find((button) => button.title === "Confirmar")!;
    expect(await t.engine.preparationList(t.tenant)).toEqual([]);

    await t.burst(buttonReply({ ...t.at(), replyId: confirm.id, title: "Confirmar" }));
    await t.burst(buttonReply({ ...t.at(), replyId: confirm.id, title: "Confirmar" }));
    const list = await t.engine.preparationList(t.tenant);
    expect(list).toHaveLength(1);
    expect(list[0]!.order).toMatchObject({ state: "confirmado", version: 1 });
    expect(list[0]!.order.lines.map((l) => [l.productName, l.quantity, l.quantitySource])).toEqual([
      [null, "6", undefined],
      ["Pollo entero", "2", undefined],
      ["Tomate", "4", undefined],
      ["Arroz 1 lb", "1", undefined],
      [null, "1", undefined],
      ["Salsa de tomate Naturas 400 g", "1", undefined],
    ]);
    const sent = t.h.sentTo(t.phone);
    expect(sent.filter((b) => b.startsWith("Listo 🙌 Tu pedido #101 quedó anotado."))).toHaveLength(1);
    expect(sent.at(-1)).toBe("¡A la orden! 🙌");

    // Two calls per burst, reader then planner; the taps needed none.
    expect(t.provider.requests.map((r) => r.schemaName)).toEqual(["BurstReading", "TurnProposal", "BurstReading", "TurnProposal"]);
    // The planner saw labels, never IDs or prices; the reader saw no catalog.
    for (const n of [1, 3]) {
      for (const secret of [...t.productIds, "1800", "2800", "4500", "order-"]) expect(t.provider.textOf(n)).not.toContain(secret);
    }
    expect(t.provider.textOf(0)).not.toContain("CATALOGO");
    expect(t.h.log.fields("planner.planned")).toEqual([
      expect.objectContaining({ outcome: "ask", reason: "quantities", count: 2 }),
      expect.objectContaining({ outcome: "readback", reason: "none" }),
    ]);
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ? AND job_state <> 'done'`, t.store.businessId)).toEqual([]);

    // Confirmed: each line the planner matched by weaker evidence proposes the customer's words as
    // an alias, once (the second tap added none). "tomates" found Tomate by its own name: nothing to learn.
    const orderId = list[0]!.order.orderId;
    expect(await aliasesOf(t.store.businessId)).toEqual([
      { said: "arroz", name: "Arroz 1 lb", state: "proposed", source: "order", source_order_id: orderId },
      { said: "pollo", name: "Pollo entero", state: "proposed", source: "order", source_order_id: orderId },
      { said: "salsa", name: "Salsa de tomate Naturas 400 g", state: "proposed", source: "order", source_order_id: orderId },
    ]);

    // The customer asks to delete their data: proposals from their orders go; one the owner already
    // approved stays as the store's, no longer linked to their order.
    const book = new D1RetrievalRepository(env.DB);
    const pollo = (await book.listProposed(t.tenant)).find((a) => a.said === "pollo")!;
    expect(await book.approveAlias(t.tenant, pollo.id, t.store.members[0]!.userId, t.h.clock.now())).toBe(true);
    await env.DB.prepare(`UPDATE customers SET deletion_requested_at_ms = ? WHERE id = ?`).bind(t.h.clock.now(), t.customerId).run();
    expect(await t.h.deps.customerControls.purge(t.tenant, t.customerId, null, t.h.clock.now())).toBe(true);
    expect(await aliasesOf(t.store.businessId)).toEqual([{ said: "pollo", name: "Pollo entero", state: "approved", source: "order", source_order_id: null }]);
    expect(await book.listApprovedAliases(t.tenant)).toEqual([{ words: "pollo", productId: expect.any(String) }]);
  }, 30_000);

  /** The trip up to the readback: the list, then the quantities. Returns the Confirmar button. */
  async function toReadback() {
    const t = await plannerTrip([READINGS.list, READINGS.quantities], [PLANS.list, PLANS.quantities]);
    await t.burst(imageMessage({ ...t.at(), mediaId: LIST_PHOTO }), textMessage({ ...t.at(), body: "lo paso a traer" }));
    await t.burst(textMessage({ ...t.at(), body: "6 platanos, 2 libras de pollo y 4 tomates" }));
    const readback = t.h.channel.sent.filter((sent) => sent.toPhone === t.phone).at(-1)!;
    return { t, confirm: readback.buttons!.find((button) => button.title === "Confirmar")! };
  }

  it("finding 5: a confirmation that doesn't save leaves no alias proposal", async () => {
    const { t, confirm } = await toReadback();
    // Another write lands between the engine's read and the job's batch, every time: the
    // confirmation's guard fails and nothing of the batch is saved.
    const onCustomerAction = t.engine.onCustomerAction.bind(t.engine);
    t.engine.onCustomerAction = async (context, envelope) => {
      const result = await onCustomerAction(context, envelope);
      await env.DB.prepare(`UPDATE pretend_engine_state SET version = version + 1 WHERE business_id = ?`).bind(t.store.businessId).run();
      return result;
    };
    await t.burst(buttonReply({ ...t.at(), replyId: confirm.id, title: "Confirmar" }));
    expect(await t.engine.preparationList(t.tenant)).toEqual([]);
    expect(await aliasesOf(t.store.businessId)).toEqual([]);
  }, 30_000);

  it("finding 5: a deletion requested while the confirmation runs leaves no alias proposal", async () => {
    const { t, confirm } = await toReadback();
    const onCustomerAction = t.engine.onCustomerAction.bind(t.engine);
    t.engine.onCustomerAction = async (context, envelope) => {
      const result = await onCustomerAction(context, envelope);
      await env.DB.prepare(`UPDATE customers SET deletion_requested_at_ms = ? WHERE id = ?`).bind(t.h.clock.now(), t.customerId).run();
      return result;
    };
    await t.burst(buttonReply({ ...t.at(), replyId: confirm.id, title: "Confirmar" }));
    expect(await aliasesOf(t.store.businessId)).toEqual([]);
  }, 30_000);

  it("a planner answer that isn't the schema leaves the burst to the classic path, and the logs say so", async () => {
    const t = await plannerTrip([READINGS.list], [{ ops: "everything", move: "readback" }]);
    await t.burst(imageMessage({ ...t.at(), mediaId: LIST_PHOTO }), textMessage({ ...t.at(), body: "lo paso a traer" }));
    const [reply] = t.h.sentTo(t.phone);
    // The classic engine's own question: which tomatoes, by its own search.
    expect(reply).toContain("Para tomates tengo:");
    expect(t.h.log.fields("planner.fallback")).toEqual([expect.objectContaining({ businessId: t.store.businessId, reason: "invalid_output" })]);
  });

  it("a planner that can't be called (spend cap, timeout) returns no plan, logged", async () => {
    const engine = new MemoryEngine(() => [], { catalog: CATALOG });
    const log = new RecordingLogger();
    const planned = await planTurn(
      {
        model: { propose: async () => ({ ok: false, reason: "spend_cap", calls: [] }) },
        retrieval: { listProducts: async () => [], listApprovedAliases: async () => [] },
        source: engine,
        log,
      },
      {
        context: { businessId: "b", conversationId: "c", customerId: "u", jobId: "j", nowMs: 1, customerName: null, customerNameAsked: false, savedPlace: null },
        reading: { observations: [order(item("arroz"))], calls: [] },
        matches: [],
        messages: [{ type: "text", text: "arroz" }],
      },
    );
    expect(planned).toBeNull();
    expect(log.fields("planner.fallback")).toEqual([expect.objectContaining({ reason: "spend_cap" })]);
  });
});
