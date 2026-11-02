/**
 * The Nov 2 conversation fixes, found by the scripted QA run (`npm run qa`): products found by the
 * customer's words, options to pick from, answers by number or words, the quantity asked when none
 * was said, "ok ya voy" changing nothing, pickup or delivery answered in plain words, the name
 * after an agreement, order numbers, the No hay notice's new total, and the owner answering from
 * Pendientes.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CustomerContext } from "../src/application/engine";
import { fulfillmentWords, optionNumber, quantityFrom } from "../src/domain/answer-words";
import { productWords, searchCatalog } from "../src/domain/catalog-search";
import { formatLempiras } from "../src/domain/contract/numbers";
import type { BurstReading, ItemLine, Observation } from "../src/domain/contract/observation";
import type { EngineOutcome } from "../src/domain/contract/outcomes";
import { nameFrom } from "../src/domain/customer-name";
import { firstName, renderNotice, renderOutcome } from "../src/domain/replies";
import { MemoryEngine, type PretendProduct } from "../src/infrastructure/memory/memory-engine";
import { csrfFor, login, send, storeWithStaff } from "./helpers/console";
import { harness, rows } from "./helpers/harness";
import { newPhone } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const CATALOG: readonly PretendProduct[] = [
  { productId: "p-arroz", names: ["Arroz 1 lb"], aliases: [], barcode: null, price: 1800 },
  { productId: "p-clover-1l", names: ["Aceite Clover 1 L"], aliases: [], barcode: null, price: 6000 },
  { productId: "p-clover-500", names: ["Aceite Clover 500 ml"], aliases: [], barcode: null, price: 3400 },
  { productId: "p-mazola", names: ["Aceite Mazola 1 L"], aliases: [], barcode: null, price: 6500 },
  { productId: "p-jabon", names: ["Jabón Xtra barra"], aliases: [], barcode: null, price: 3500 },
  { productId: "p-sal", names: ["Sal 1 lb"], aliases: [], barcode: null, price: 800 },
  { productId: "p-salsa", names: ["Salsa de tomate Naturas 400 g"], aliases: [], barcode: null, price: 2800 },
  { productId: "p-tortillas", names: ["Tortillas paquete 10"], aliases: [], barcode: null, price: 2000 },
  { productId: "p-detergente", names: ["Detergente Xedex 500 g"], aliases: [], barcode: null, price: 4200 },
];

const none = { issues: [] } as const;
const text = (message: number, length: number) => ({ source: "text", message, start: 0, end: length }) as const;
const line = (said: string, name: string, quantity: string | null, unit: string | null = null): ItemLine => ({
  text: said,
  name,
  quantity,
  unit,
  restrictedCategory: false,
  evidence: text(0, said.length),
});
const order = (...lines: ItemLine[]): Observation => ({ kind: "customer_order", lines, ...none });
const pickup: Observation = { kind: "fulfillment", mode: "pickup", pin: null, placeText: null, sameAsBefore: false, ...none };
const answer = (said: string): Observation => ({ kind: "clarification", answer: said, evidence: text(0, said.length), ...none });
const reading = (...observations: Observation[]): BurstReading => ({ observations, calls: [] });

/** One customer of a pretend store: each call is one burst, read as given. */
function customer(engine = new MemoryEngine(() => [], { catalog: CATALOG }), customerId = "cust-1") {
  let job = 0;
  const context = (): CustomerContext => ({ businessId: "store-1", conversationId: "conv-1", customerId, jobId: `job-${++job}`, nowMs: 1_000 * job });
  return {
    engine,
    burst: async (...observations: Observation[]): Promise<EngineOutcome> => (await engine.onBurst(context(), reading(...observations), [])).outcome,
    confirm: async (orderId: string, version: number) => {
      const ctx = { ...context(), customerName: "Ana" } as CustomerContext;
      return (await engine.onCustomerAction(ctx, { action: { type: "confirm_order", orderId, version }, actor: { type: "customer", customerId }, operationKey: `confirm:${orderId}:v${version}` })).outcome;
    },
  };
}

const orderOf = (outcome: EngineOutcome) => ("order" in outcome ? outcome.order : null)!;

describe("finding products by the customer's words", () => {
  it("matches whole words only, folds plurals and unit words, and keeps numbers exact", () => {
    const ids = (said: string) => searchCatalog(said, CATALOG).map((p) => p.productId);
    expect(ids("sal")).toEqual(["p-sal"]); // never "Salsa"
    expect(ids("jabones")).toEqual(["p-jabon"]);
    expect(ids("aceite")).toEqual(["p-clover-1l", "p-clover-500", "p-mazola"]);
    expect(ids("aceite de litro")).toEqual(["p-clover-1l", "p-mazola"]);
    expect(ids("clover de 500")).toEqual(["p-clover-500"]);
    expect(ids("coca cola de 3 litros")).toEqual([]);
    expect(productWords("el de la marca")).toEqual([]);
    expect(ids("de la")).toEqual([]);
  });
});

describe("short answers read by code", () => {
  it("reads an option's number, a quantity and pickup or delivery, and nothing unclear", () => {
    expect(["2", "el 2", "opción 3", "la segunda", "el primero"].map(optionNumber)).toEqual([2, 2, 3, 2, 1]);
    expect(["el de litro", "22", "dos"].map(optionNumber)).toEqual([null, null, null]);
    expect(["3", "2.5", "1,5", "dos", "media docena", "3 paquetes"].map(quantityFrom)).toEqual(["3", "2.5", "1.5", "2", "6", "3"]);
    expect(["muchos", "2 o 3", "0"].map(quantityFrom)).toEqual([null, null, null]);
    expect(["a domicilio", "me lo lleva", "lo recojo", "paso por el", "ya voy"].map(fulfillmentWords)).toEqual([
      "delivery",
      "delivery",
      "pickup",
      "pickup",
      "pickup",
    ]);
    expect(fulfillmentWords("no sé todavía")).toBeNull();
  });

  it("takes the name after an agreement, never the agreement alone", () => {
    expect(nameFrom("ta bien, Luis")).toBe("Luis");
    expect(nameFrom("ok, a nombre de Marta")).toBe("Marta");
    expect(nameFrom("si")).toBeNull();
    expect(nameFrom("¿para qué quiere mi nombre?")).toBeNull();
    expect(firstName("Maria Lopez")).toBe("Maria");
    expect(firstName("Doña Rosa")).toBe("Doña Rosa");
  });

  it("writes thousands with commas", () => {
    expect(formatLempiras(178_250)).toBe("L 1,782.50");
    expect(formatLempiras(1_800)).toBe("L 18");
  });
});

describe("the order, built from what the customer says", () => {
  it("offers the products that fit an unclear line, and the number picks one", async () => {
    const c = customer();
    const asked = await c.burst(order(line("un aceite", "aceite", "1"), line("2 jabones", "jabones", "2")));
    expect(asked).toMatchObject({ type: "ask", question: "ambiguous_product", line: 0 });
    expect(asked.type === "ask" && asked.options?.map((o) => o.name)).toEqual(["Aceite Clover 1 L", "Aceite Clover 500 ml", "Aceite Mazola 1 L"]);
    // The jabón line found its product by its words.
    expect(orderOf(asked).lines[1]).toMatchObject({ productId: "p-jabon", unitPrice: 3500 });
    expect(renderOutcome(asked, { customerId: "cust-1" })!.body).toBe(
      ["Anotado ✅ 2 × Jabón Xtra barra.", "Para un aceite tengo:", "1. Aceite Clover 1 L · L 60", "2. Aceite Clover 500 ml · L 34", "3. Aceite Mazola 1 L · L 65", "¿Cuál te mando? Respondé con el número."].join("\n"),
    );
    const next = await c.burst(answer("2"));
    expect(next).toMatchObject({ type: "ask", question: "pickup_or_delivery" });
    expect(orderOf(next).lines[0]).toMatchObject({ productId: "p-clover-500", unitPrice: 3400 });
  });

  it("settles an option by its words among the ones offered", async () => {
    const c = customer();
    await c.burst(order(line("un aceite", "aceite", "1")));
    const next = await c.burst(answer("el clover de litro"));
    expect(orderOf(next).lines[0]).toMatchObject({ productId: "p-clover-1l" });
  });

  it("asks how many when no quantity was said, and reads the answer", async () => {
    const c = customer();
    const asked = await c.burst(order(line("unas tortillas", "tortillas", null)));
    expect(asked).toMatchObject({ type: "ask", question: "quantity", line: 0 });
    const next = await c.burst(answer("dos"));
    expect(orderOf(next).lines[0]).toMatchObject({ quantity: "2", productId: "p-tortillas" });
    expect(next).toMatchObject({ type: "ask", question: "pickup_or_delivery" });
  });

  it("takes 'a domicilio' as the answer to pickup or delivery, then asks where", async () => {
    const c = customer();
    await c.burst(order(line("2 libras de arroz", "arroz", "2", "libra")));
    const next = await c.burst(answer("a domicilio"));
    expect(next).toMatchObject({ type: "ask", question: "delivery_place" });
    expect(orderOf(next).fulfillment).toMatchObject({ mode: "delivery" });
  });

  it("'ok ya voy' read as pickup again changes nothing on a ready order", async () => {
    const c = customer();
    await c.burst(order(line("2 libras de arroz", "arroz", "2", "libra")));
    const readback = await c.burst(pickup);
    expect(readback.type).toBe("readback");
    const { orderId, version } = orderOf(readback);
    await c.confirm(orderId, version);
    const member = { businessId: "store-1", userId: "u-1", role: "owner", canApproveFiado: true, nowMs: 9_000 } as never;
    await c.engine.onConsoleAction(member, { action: { type: "start_preparing", orderId, version }, actor: { type: "member", userId: "u-1" }, operationKey: "k1" } as never);
    await c.engine.onConsoleAction(member, { action: { type: "mark_ready", orderId, version }, actor: { type: "member", userId: "u-1" }, operationKey: "k2" } as never);
    const after = await c.burst(pickup);
    expect(after).toMatchObject({ type: "order_status", order: { state: "listo", version } });
  });

  it("answers '¿a cómo el aceite?' with each aceite and its price", async () => {
    const c = customer();
    const outcome = await c.burst({ kind: "question", topic: "price", products: ["el aceite"], ...none });
    expect(renderOutcome(outcome, { customerId: "cust-1" })!.body).toBe(
      ["Aceite Clover 1 L: L 60.", "Aceite Clover 500 ml: L 34.", "Aceite Mazola 1 L: L 65."].join("\n"),
    );
  });

  it("before a question about one line, echoes the others", async () => {
    const c = customer();
    const asked = await c.burst(order(line("3 libras de arroz", "arroz", "3", "libra"), line("unas tortillas", "tortillas", null)));
    expect(renderOutcome(asked, { customerId: "cust-1" })!.body).toBe("Anotado ✅ 3 × Arroz 1 lb.\n¿Cuánto querés de Tortillas paquete 10?");
  });

  it("removing a line already marked No hay changes nothing", async () => {
    const c = customer();
    await c.burst(order(line("2 libras de arroz", "arroz", "2", "libra"), line("1 detergente", "detergente", "1")));
    const readback = await c.burst(pickup);
    const { orderId, version, lines } = orderOf(readback);
    await c.confirm(orderId, version);
    const member = { businessId: "store-1", userId: "u-1", role: "owner", canApproveFiado: true, nowMs: 9_000 } as never;
    await c.engine.onConsoleAction(member, {
      action: { type: "mark_line", orderId, version, lineId: lines[1]!.lineId, mark: "no_hay", substituteProductId: null },
      actor: { type: "member", userId: "u-1" },
      operationKey: "k4",
    } as never);
    const after = await c.burst({ kind: "order_change", edits: [{ op: "remove", target: { ref: "L2", said: "detergente" }, evidence: text(0, 10) }], ...none } as never);
    expect(after).toMatchObject({ type: "order_status", order: { version, state: "preparando" } });
  });

  it("numbers orders per store, from 101", async () => {
    const engine = new MemoryEngine(() => [], { catalog: CATALOG });
    const first = await customer(engine, "a").burst(order(line("arroz", "arroz", "1")));
    const second = await customer(engine, "b").burst(order(line("sal", "sal", "1")));
    expect([orderOf(first).code, orderOf(second).code]).toEqual(["101", "102"]);
  });

  it("a No hay line leaves the total, and the notice says the new one", async () => {
    const c = customer();
    await c.burst(order(line("2 libras de arroz", "arroz", "2", "libra"), line("1 detergente", "detergente", "1")));
    const readback = await c.burst(pickup);
    const { orderId, version } = orderOf(readback);
    expect(orderOf(readback).total).toBe(7800);
    await c.confirm(orderId, version);
    const member = { businessId: "store-1", userId: "u-1", role: "owner", canApproveFiado: true, nowMs: 9_000 } as never;
    const lineId = orderOf(readback).lines[1]!.lineId;
    const marked = await c.engine.onConsoleAction(member, {
      action: { type: "mark_line", orderId, version, lineId, mark: "no_hay", substituteProductId: null },
      actor: { type: "member", userId: "u-1" },
      operationKey: "k3",
    } as never);
    const notice = marked.notices[0]!.notice;
    expect(notice.type === "line_unavailable" && notice.order.total).toBe(3600);
    expect(renderNotice(notice).body).toBe("Perdón, no nos queda Detergente Xedex 500 g 😔 Tu pedido queda en L 36. Si querés otra cosa en su lugar, decime.");
  });
});

describe("the owner answers from Pendientes", () => {
  it("shows what the customer wrote, sends the answer signed, takes the item off, and sends it once", async () => {
    const h = harness();
    const store = await storeWithStaff();
    const phone = newPhone();
    const say = async (body: string) => {
      h.clock.advance(1_000);
      await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body })] }));
      h.clock.advance(4_000);
      await h.deliver(h.takeRingsFor(store.businessId));
    };
    await say("Hola");
    await say("quiero hablar con una persona");
    const [item] = await rows<{ id: string }>(`SELECT id FROM conversation_pendientes WHERE business_id = ? AND done_at_ms IS NULL`, store.businessId);

    const owner = await login(h, store.businessId, store.members[0]!.userId);
    const csrf = await csrfFor(h, owner);
    const page = await (await send(h, "/console/pendientes", { cookie: owner })).text();
    expect(page).toContain("«Hola · quiero hablar con una persona»");
    expect(page).toContain('action="/console/pendientes/responder"');

    const answered = await send(h, "/console/pendientes/responder", { method: "POST", form: { csrf, pendiente: item!.id, respuesta: "Ya te atiendo, dame un minuto" }, cookie: owner });
    expect(answered.headers.get("location")).toContain("aviso=respondido");
    const sent = await rows<{ body_text: string }>(`SELECT body_text FROM outbound_messages WHERE business_id = ? AND dedupe_key LIKE 'owner_reply:%'`, store.businessId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body_text).toMatch(/^\*[^*]+:\* Ya te atiendo, dame un minuto$/u);
    expect(await rows(`SELECT 1 FROM conversation_pendientes WHERE business_id = ? AND done_at_ms IS NULL`, store.businessId)).toEqual([]);

    // The same answer again: the item is gone, nothing more is queued.
    const again = await send(h, "/console/pendientes/responder", { method: "POST", form: { csrf, pendiente: item!.id, respuesta: "Ya te atiendo, dame un minuto" }, cookie: owner });
    expect(again.headers.get("location")).toContain("aviso=falta");
    expect(await rows(`SELECT 1 FROM outbound_messages WHERE business_id = ? AND dedupe_key LIKE 'owner_reply:%'`, store.businessId)).toHaveLength(1);
  });

  it("is the owner's only, and refuses an empty answer", async () => {
    const h = harness();
    const store = await storeWithStaff();
    const staff = await login(h, store.businessId, store.members[1]!.userId);
    const staffCsrf = await csrfFor(h, staff);
    expect((await send(h, "/console/pendientes/responder", { method: "POST", form: { csrf: staffCsrf, pendiente: "x", respuesta: "hola" }, cookie: staff })).status).toBe(403);
    const owner = await login(h, store.businessId, store.members[0]!.userId);
    const csrf = await csrfFor(h, owner);
    const empty = await send(h, "/console/pendientes/responder", { method: "POST", form: { csrf, pendiente: "x", respuesta: "   " }, cookie: owner });
    expect(empty.headers.get("location")).toContain("aviso=vacio");
    void env;
  });
});
