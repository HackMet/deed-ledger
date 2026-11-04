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
import { validateReading } from "../src/domain/perception/validate";
import { formatLempiras } from "../src/domain/contract/numbers";
import type { BurstReading, ItemLine, Observation } from "../src/domain/contract/observation";
import type { EngineOutcome } from "../src/domain/contract/outcomes";
import { nameFrom } from "../src/domain/customer-name";
import { firstName, renderNotice, renderOutcome } from "../src/domain/replies";
import { MemoryEngine, type PretendProduct } from "../src/infrastructure/memory/memory-engine";
import { SimMediaSource } from "../src/infrastructure/sim-media-source";
import { buildRuntime } from "../src/composition";
import { orderLabel } from "../src/interfaces/http/console/preparacion";
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
  { productId: "p-papel", names: ["Papel higiénico 4 rollos"], aliases: [], barcode: null, price: 4800 },
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
    // One slip in a long word, only when nothing fits as written; never in short words or numbers.
    expect(ids("un aciete")).toEqual(["p-clover-1l", "p-clover-500", "p-mazola"]);
    expect(ids("detergete")).toEqual(["p-detergente"]);
    expect(ids("sall")).toEqual([]);
    expect(ids("clover de 50")).toEqual([]);
    // A short word one letter from another is a different word: "pollo" is never "rollos".
    expect(ids("pollo")).toEqual([]);
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
      ["Anotado ✅", "• 2 Jabón Xtra barra", "", "Para un aceite tengo:", "1. Aceite Clover 1 L · L 60", "2. Aceite Clover 500 ml · L 34", "3. Aceite Mazola 1 L · L 65", "¿Cuál te mando? Respondé con el número."].join("\n"),
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

  it("tells perception the options it offered, and takes perception's pick among them", async () => {
    const c = customer();
    await c.burst(order(line("un aceite", "aceite", "1")));
    const context = await c.engine.perceptionContext({ businessId: "store-1", conversationId: "conv-1", customerId: "cust-1", jobId: "j", nowMs: 1 });
    expect(context.pendingOptions).toEqual([
      { label: "O1", text: "Aceite Clover 1 L · L 60" },
      { label: "O2", text: "Aceite Clover 500 ml · L 34" },
      { label: "O3", text: "Aceite Mazola 1 L · L 65" },
    ]);
    // "Esa grande de 65": no rule reads that, perception's pick does.
    const next = await c.burst({ kind: "clarification", answer: "esa grande de 65", pick: "O3", evidence: text(0, 16), ...none });
    expect(orderOf(next).lines[0]).toMatchObject({ productId: "p-mazola" });
  });

  it("drops a pick that isn't one of the options offered", () => {
    const messages = [{ type: "text", text: "la quinta" }] as const;
    const context = { openOrder: null, pendingQuestion: "ambiguous_product", pendingOptions: [{ label: "O1", text: "A" }, { label: "O2", text: "B" }], catalogLabels: [] } as const;
    const raw = { observations: [{ kind: "clarification", answer: "la quinta", pick: "O5", quantity: null, evidence: { message: 0, quote: "la quinta", box: null }, issues: [] }] };
    const read = validateReading(raw, "customer", messages, context);
    expect(read.ok && read.observations[0]).toMatchObject({ kind: "clarification", pick: null });
  });

  it("settles an option by a word only one option holds, with filler around it", async () => {
    const c = customer();
    await c.burst(order(line("un aceite", "aceite", "1")));
    const next = await c.burst(answer("mazola porfavor"));
    expect(orderOf(next).lines[0]).toMatchObject({ productId: "p-mazola" });
  });

  it("'¿ya anotaste…?' while the order is built gets the open question with what's noted", async () => {
    const c = customer();
    await c.burst(order(line("2 libras de arroz", "arroz", "2", "libra")));
    const again = await c.burst({ kind: "question", topic: "order_status", products: [], ...none });
    expect(again).toMatchObject({ type: "ask", question: "pickup_or_delivery" });
    expect(renderOutcome(again, { customerId: "cust-1" })!.body).toBe("Anotado ✅\n• 2 Arroz 1 lb\n\n¿Lo recogés en la tienda o te lo llevamos?");
    // Without the question, the same burst repeats nothing: only the open question.
    const ok = await c.burst();
    expect(renderOutcome(ok, { customerId: "cust-1" })!.body).toBe("¿Lo recogés en la tienda o te lo llevamos?");
  });

  it("takes perception's quantity, and never a number that is the product's own name", async () => {
    const byPerception = customer();
    await byPerception.burst(order(line("unas tortillas", "tortillas", null)));
    const read = await byPerception.burst({ kind: "clarification", answer: "si el paquete de 10 gracias", pick: null, quantity: "1", evidence: text(0, 27), ...none });
    expect(orderOf(read).lines[0]).toMatchObject({ quantity: "1" });
    // Without perception's reading, code leaves the 10 of "paquete 10" out: no quantity, never ten.
    const byCode = customer();
    await byCode.burst(order(line("unas tortillas", "tortillas", null)));
    const fallback = await byCode.burst(answer("si el paquete de 10 gracias"));
    expect(orderOf(fallback).lines[0]!.quantity).toBeNull();
    // Still no quantity: asked once more, then the order moves on.
    expect(fallback).toMatchObject({ type: "ask", question: "quantity", line: 0 });
    expect(await byCode.burst(answer("no se"))).toMatchObject({ type: "ask", question: "pickup_or_delivery" });
  });

  it("asks once for several missing quantities, reads the answer, asks once more for the rest, then moves on", async () => {
    const c = customer();
    const asked = await c.burst(order(line("platanos", "platanos", null), line("piña", "piña", null), line("sal", "sal", null)));
    expect(asked).toMatchObject({ type: "ask", question: "quantities" });
    expect(renderOutcome(asked, { customerId: "cust-1" })!.body).toBe(
      // Every item is named once, in the question itself: nothing known yet to echo.
      ["¿Cuántos querés de cada uno?", "• Platanos", "• Piña", "• Sal 1 lb", "Escribime, por ejemplo: «2 platanos, 1 piña»."].join("\n"),
    );
    // Read by code when perception passed it as one answer: two of three settled, asked again for one.
    const again = await c.burst(answer("6 platanos y una piña"));
    expect(orderOf(again).lines.map((l) => l.quantity)).toEqual(["6", "1", null]);
    expect(again).toMatchObject({ type: "ask", question: "quantities" });
    expect(renderOutcome(again, { customerId: "cust-1" })!.body).toContain("• Sal 1 lb");
    // No quantity again: the order moves on; the quantity stays unknown, never made up.
    const moved = await c.burst(answer("eso"));
    expect(moved).toMatchObject({ type: "ask", question: "pickup_or_delivery" });
    expect(orderOf(moved).lines[2]!.quantity).toBeNull();
  });

  it("takes the quantities perception set line by line", async () => {
    const c = customer();
    await c.burst(order(line("platanos", "platanos", null), line("piña", "piña", null)));
    const set = (ref: string, quantity: string) => ({ op: "set_quantity", target: { ref, said: ref }, quantity, evidence: text(0, 5) });
    const next = await c.burst({ kind: "order_change", edits: [set("L1", "6"), set("L2", "1")], ...none } as never);
    expect(orderOf(next).lines.map((l) => l.quantity)).toEqual(["6", "1"]);
    expect(next).toMatchObject({ type: "ask", question: "pickup_or_delivery" });
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
    expect(renderOutcome(asked, { customerId: "cust-1" })!.body).toBe("Anotado ✅\n• 3 Arroz 1 lb\n\n¿Cuánto querés de Tortillas paquete 10?");
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
    expect(renderNotice(notice).body).toBe("Perdón, ahorita no hay Detergente Xedex 500 g 😔 Tu pedido queda en L 36. Si querés otra cosa en su lugar, decime.");
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

describe("the simulator's photos and voice notes, and the order number on the console", () => {
  it("keeps an upload and serves it back by its ID; refuses other types, sizes and IDs", async () => {
    const sim = new SimMediaSource(env.MEDIA);
    const bytes = new TextEncoder().encode("not really a jpeg").buffer as ArrayBuffer;
    const id = await sim.upload("image/jpeg", bytes);
    expect(id).toMatch(/^sim-[0-9a-f-]{36}$/u);
    const back = await sim.fetch({ providerMediaId: id! });
    expect(back?.contentType).toBe("image/jpeg");
    expect(new TextDecoder().decode(back!.bytes)).toBe("not really a jpeg");
    expect(await sim.upload("text/html", bytes)).toBeNull();
    expect(await sim.upload("image/jpeg", new ArrayBuffer(0))).toBeNull();
    // A WhatsApp media ID, or a path out of the uploads: nothing.
    expect(await sim.fetch({ providerMediaId: "1234567890" })).toBeNull();
    expect(await sim.fetch({ providerMediaId: "../stores/x" })).toBeNull();
  });

  it("serves uploads only in the simulator: dev console on and no WhatsApp token", () => {
    const runtime = (vars: Record<string, string>) => buildRuntime({ ...env, ...vars } as Env);
    expect(runtime({ DEV_CONSOLE: "", WHATSAPP_TOKEN: "" }).simMedia).toBeNull();
    expect(runtime({ DEV_CONSOLE: "1", WHATSAPP_TOKEN: "a-real-token" }).simMedia).toBeNull();
    expect(runtime({ DEV_CONSOLE: "1", WHATSAPP_TOKEN: "" }).simMedia).not.toBeNull();
  });

  it("puts the order number before the customer's name on the console", () => {
    expect(orderLabel({ code: "101" } as never)).toBe("#101 · ");
    expect(orderLabel({} as never)).toBe("");
  });
});
