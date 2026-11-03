/**
 * Delivery to a saved place (#29): every order asks pickup or delivery; a pin (from the webhook) or
 * a place in words is used for delivery only and saved when the order is confirmed; the next
 * delivery order offers it as a question with Sí / Otro lugar, never applied silently; a fee shows
 * only if the store set one. Synthetic data only: invented phones, coordinates in open sea, made-up
 * places.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Engine } from "../src/application/engine";
import type { OrderReadingSource } from "../src/application/order-reading";
import { withSharedPin } from "../src/application/order-reading";
import type { ModelProvider, ModelRequest } from "../src/application/ports";
import type { OrderView } from "../src/domain/contract/outcomes";
import { isYes, parsePin } from "../src/domain/place";
import { actionFromButtonId, COPY, placeChoiceKey, renderOutcome } from "../src/domain/replies";
import { D1CustomerPlaceRepository } from "../src/infrastructure/d1/customer-place-repository";
import { D1PretendEngine } from "../src/infrastructure/memory/d1-pretend-engine";
import { MemoryEngine, type PretendProduct, type PretendStoreSnapshot } from "../src/infrastructure/memory/memory-engine";
import { parseWebhookPayload } from "../src/integrations/whatsapp/payload";
import { line, quote } from "./fixtures/model/recorded";
import { type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedCustomer, seedIntroducedCustomer, seedStore } from "./helpers/seed";
import { buttonReply, locationMessage, textMessage, wamid, webhook } from "./helpers/whatsapp";

const SETTLED_MS = 4_000;
const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

/** Open sea, nowhere near a real store or home. */
const PIN = { latitude: 10.123456, longitude: -80.654321 };
const PLACE_TEXT = "frente a la iglesia, casa verde";

const CATALOG: readonly PretendProduct[] = [
  { productId: "p-arroz", names: ["Arroz 1 lb", "Arroz"], aliases: [], barcode: null, price: 3000 },
  { productId: "p-jabon", names: ["Jabón Xtra"], aliases: ["jabon xtra"], barcode: null, price: 3500 },
];

const none = { issues: [] };
const READ = {
  arroz: { observations: [{ kind: "customer_order", lines: [line("2 libras de arroz", "arroz", "2", "libra", quote(0, "2 libras de arroz"))], ...none }] },
  jabon: { observations: [{ kind: "customer_order", lines: [line("1 jabon xtra", "jabon xtra", "1", null, quote(0, "1 jabon xtra"))], ...none }] },
  delivery: { observations: [{ kind: "fulfillment", mode: "delivery", place_text: null, same_as_before: false, ...none }] },
  pickup: { observations: [{ kind: "fulfillment", mode: "pickup", place_text: null, same_as_before: false, ...none }] },
  placeAnswer: { observations: [{ kind: "clarification", answer: PLACE_TEXT, pick: null, quantity: null, evidence: quote(0, PLACE_TEXT), ...none }] },
  yes: { observations: [{ kind: "clarification", answer: "Sí", pick: null, quantity: null, evidence: quote(0, "Sí"), ...none }] },
} as const;

const NOTED_ARROZ = "Anotado ✅\n• 2 Arroz 1 lb";
const ASK_HOW = `${NOTED_ARROZ}\n\n¿Lo recogés en la tienda o te lo llevamos?`;
/** Asked after "a domicilio": nothing new in the order, so nothing echoed again. */
const ASK_WHERE = "¿A dónde te lo llevamos? Mandame tu ubicación o escribime la dirección.";
/** The summary's place line for PLACE_TEXT, first letter up. */
const TO_PLACE = "📍 Te lo llevamos a: Frente a la iglesia, casa verde";

/** Muse Spark's place: each call gets the next recorded reading. Never the network. */
class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  constructor(private readonly readings: unknown[]) {}
  async complete(request: ModelRequest) {
    this.requests.push(request);
    const json = this.readings.shift();
    if (json === undefined) throw new Error("no recorded reading left");
    return { ok: true, json, latencyMs: 5_000, inputTokens: 3_000, outputTokens: 500 } as const;
  }
  textOf(n: number): string {
    return this.requests[n]!.user.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  }
}

type PretendEngine = Engine & OrderReadingSource;
const ENGINES = [
  ["in memory", (): PretendEngine => new MemoryEngine(() => [], { catalog: CATALOG })],
  ["with its state in D1", (): PretendEngine => new D1PretendEngine(env.DB, { catalog: CATALOG })],
] as const;

/** A returning customer, named and introduced, on a pretend engine with recorded readings. */
async function customer(readings: unknown[], makeEngine: () => PretendEngine = ENGINES[0][1]) {
  const store = await seedStore({ members: [] });
  const phone = newPhone();
  const customerId = await seedIntroducedCustomer(store, phone);
  await env.DB.prepare(`UPDATE customers SET name = 'Ana', name_saved_at_ms = 1 WHERE id = ?`).bind(customerId).run();
  const engine = makeEngine();
  const provider = new RecordedProvider(readings);
  const h = harness({ engine, modelProvider: provider });
  const tenant = { businessId: store.businessId };
  const at = () => ({ from: phone, id: wamid(), timestampS: nowS(h) });

  const burst = async (...messages: readonly unknown[]) => {
    h.clock.advance(1_000);
    for (const message of messages) {
      h.clock.advance(200);
      await h.post(webhook(store.phoneNumberId, { messages: [message] }));
    }
    h.clock.advance(SETTLED_MS);
    await h.deliver(h.takeRingsFor(store.businessId));
  };
  const lastSent = () => h.channel.sent.filter((sent) => sent.toPhone === phone).at(-1)!;
  /** Taps the last reply's button with this title. */
  const tap = async (title: string) => {
    const button = lastSent().buttons?.find((b) => b.title === title);
    if (button === undefined) throw new Error(`no ${title} button on the last reply`);
    await burst(buttonReply({ ...at(), replyId: button.id, title }));
  };
  /** The customer's open order as the engine keeps it. */
  const openOrder = async (): Promise<OrderView | null> => {
    let snapshot: PretendStoreSnapshot;
    if (engine instanceof MemoryEngine) snapshot = engine.exportStore(tenant);
    else {
      const row = await env.DB.prepare(`SELECT state_json FROM pretend_engine_state WHERE business_id = ?`).bind(store.businessId).first<{ state_json: string }>();
      snapshot = JSON.parse(row!.state_json) as PretendStoreSnapshot;
    }
    const open = snapshot.orders.map(([, stored]) => stored.order).filter((o) => o.state !== "entregado" && o.state !== "cancelado");
    return open.at(-1) ?? null;
  };
  /** Staff pack, finish and hand over the order on the list, so the customer can order again. */
  const handOver = async () => {
    for (const type of ["start_preparing", "mark_ready", "mark_delivered"] as const) {
      const order = (await engine.preparationList(tenant))[0]!.order;
      const result = await engine.onConsoleAction(
        { businessId: store.businessId, memberId: "m-owner", role: "owner", canApproveFiado: true, nowMs: h.clock.now() },
        {
          operationKey: `k-${type}-${order.orderId}`,
          actor: { type: "member", memberId: "m-owner", role: "owner" },
          action: { type, orderId: order.orderId, version: order.version },
        },
      );
      for (const commit of result.commits) await env.DB.batch([...commit.statements]);
    }
  };
  const places = () =>
    rows<{ id: string; place_text: string | null; latitude_e6: number | null; longitude_e6: number | null; last_used_at_ms: number }>(
      `SELECT id, place_text, latitude_e6, longitude_e6, last_used_at_ms FROM customer_places WHERE business_id = ? ORDER BY created_at_ms, id`,
      store.businessId,
    );
  /** A place saved by an earlier delivery, as the order handler would have saved it. */
  const savePlace = async (place: { text: string | null; pin: typeof PIN | null }) => {
    const id = `place-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO customer_places (id, business_id, customer_id, place_text, latitude_e6, longitude_e6, order_id, created_at_ms, last_used_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    )
      .bind(
        id,
        store.businessId,
        customerId,
        place.text,
        place.pin === null ? null : Math.round(place.pin.latitude * 1e6),
        place.pin === null ? null : Math.round(place.pin.longitude * 1e6),
        `order-earlier-${id}`,
      )
      .run();
    return id;
  };
  return {
    h,
    store,
    phone,
    customerId,
    engine,
    provider,
    tenant,
    burst,
    tap,
    lastSent,
    openOrder,
    handOver,
    places,
    savePlace,
    sent: () => h.sentTo(phone),
    text: (body: string) => textMessage({ ...at(), body }),
    pin: (spec: { latitude: unknown; longitude: unknown } = PIN) => locationMessage({ ...at(), ...spec, name: "Lugar de prueba" }),
  };
}

const readback = (placeLine: string, total = "L 60", lineText = "• 2 Arroz 1 lb · L 60") =>
  [
    "Tu pedido:",
    lineText,
    "",
    placeLine,
    `💵 Total: ${total}. ${placeLine === `🏪 ${COPY.pickup}` ? COPY.payOnPickup : COPY.payOnDelivery}`,
    "",
    COPY.confirmQuestion,
  ].join("\n");

describe("a pin from the webhook", () => {
  it.each(ENGINES)("is used for delivery and saved on Confirmar, with no fee shown (%s)", async (_label, makeEngine) => {
    const c = await customer([READ.arroz, READ.delivery], makeEngine);
    await c.burst(c.text("2 libras de arroz"));
    expect(c.sent().at(-1)).toBe(ASK_HOW); // every order asks pickup or delivery

    await c.burst(c.text("llevámelo"), c.pin());
    // The model was told a location was shared, never its coordinates.
    expect(c.provider.textOf(1)).toContain("[1] ubicacion compartida");
    expect(c.provider.textOf(1)).not.toContain("10.12");
    const shown = readback(`📍 ${COPY.deliveryToPin}`);
    expect(c.sent().at(-1)).toBe(shown);
    expect(shown).not.toContain("envío");
    expect(await c.places()).toEqual([]); // nothing is saved before Confirmar

    // The pin is on the message row, kind other, as millionths of a degree.
    expect(await rows(`SELECT kind, latitude_e6, longitude_e6 FROM inbound_messages WHERE business_id = ? AND latitude_e6 IS NOT NULL`, c.store.businessId)).toEqual([
      { kind: "other", latitude_e6: 10123456, longitude_e6: -80654321 },
    ]);

    await c.tap("Confirmar");
    // The name is on file (given earlier), so Confirmar confirms at once and says it.
    expect(c.sent().at(-1)).toBe("Listo, Ana 🙌 Tu pedido #101 quedó anotado. Total: L 60. Te aviso cuando esté listo.");
    expect(await c.places()).toEqual([
      { id: expect.any(String), place_text: null, latitude_e6: 10123456, longitude_e6: -80654321, last_used_at_ms: expect.any(Number) },
    ]);
    // Staff see where it goes, with a map link built from the numbers.
    const [card] = await c.engine.preparationList(c.tenant);
    expect(card!.order.fulfillment).toEqual({ mode: "delivery", placeId: null, placeText: null, pin: PIN, fee: null });
  });

  it("alone is read by code: no model call", async () => {
    const c = await customer([READ.arroz]);
    await c.burst(c.text("2 libras de arroz"));
    await c.burst(c.pin());
    expect(c.provider.requests).toHaveLength(1);
    expect(c.sent().at(-1)).toBe(readback(`📍 ${COPY.deliveryToPin}`));
  });

  it("sent with pickup is not used, and nothing is saved", async () => {
    const c = await customer([READ.arroz, READ.pickup]);
    await c.burst(c.text("2 libras de arroz"));
    await c.burst(c.text("lo paso a traer"), c.pin());
    expect(c.sent().at(-1)).toBe(readback(`🏪 ${COPY.pickup}`));
    await c.tap("Confirmar");
    expect(await c.places()).toEqual([]);
  });

  it("is not saved for an order cancelled instead of confirmed", async () => {
    const c = await customer([READ.arroz, READ.delivery]);
    await c.burst(c.text("2 libras de arroz"));
    await c.burst(c.text("llevámelo"), c.pin());
    await c.tap("Cancelar");
    expect(c.sent().at(-1)).toBe(COPY.cancelled);
    expect(await c.places()).toEqual([]);
  });
});

describe("the next delivery order", () => {
  it.each(ENGINES)("asks about the saved place with Sí / Otro lugar, never applies it, and Sí uses it (%s)", async (_label, makeEngine) => {
    const c = await customer([READ.arroz, READ.delivery], makeEngine);
    const placeId = await c.savePlace({ text: PLACE_TEXT, pin: null });
    await c.burst(c.text("2 libras de arroz"));
    expect(c.sent().at(-1)).toBe(ASK_HOW);
    await c.burst(c.text("me lo mandan"));

    const question = c.lastSent();
    expect(question.body).toBe(
      ["¿Te lo llevamos al mismo lugar de siempre?", `La vez pasada te lo llevamos a: ${PLACE_TEXT}.`, "Respondé Sí u Otro lugar."].join("\n"),
    );
    expect(question.buttons?.map((b) => b.title)).toEqual(["Sí", "Otro lugar"]);
    // Not applied: the order still has no place, and nothing was read back.
    expect((await c.openOrder())!.fulfillment).toEqual({ mode: "delivery", placeId: null, placeText: null, pin: null, fee: null });
    expect(c.sent().some((body) => body.startsWith("Tu pedido:"))).toBe(false);

    await c.tap("Sí");
    expect(c.sent().at(-1)).toBe(readback(TO_PLACE));
    expect((await c.openOrder())!.fulfillment).toMatchObject({ mode: "delivery", placeId, placeText: PLACE_TEXT });

    // A second tap on Sí is the same operation: nothing more is saved, and it isn't left unanswered.
    const sentBefore = c.sent().length;
    const before = await c.openOrder();
    await c.burst(buttonReply({ from: c.phone, id: wamid(), timestampS: nowS(c.h), replyId: question.buttons![0]!.id, title: "Sí" }));
    expect(c.sent()).toHaveLength(sentBefore + 1);
    expect(c.lastSent().body).toBe(COPY.confirmNudge);
    expect(c.lastSent().buttons?.map((b) => b.title)).toEqual(["Confirmar", "Corregir", "Cancelar"]);
    expect(await c.openOrder()).toEqual(before);

    c.h.clock.advance(60_000);
    await c.tap("Confirmar");
    const [place] = await c.places();
    // Still one place, now marked used: it stays the one offered next.
    expect(await c.places()).toHaveLength(1);
    expect(place).toMatchObject({ id: placeId, place_text: PLACE_TEXT });
    expect(place!.last_used_at_ms).toBeGreaterThan(1);
  });

  it("Otro lugar asks where; the place in words is kept as written and becomes the one offered", async () => {
    const c = await customer([READ.arroz, READ.delivery, READ.placeAnswer, READ.jabon, READ.delivery]);
    await c.savePlace({ text: null, pin: PIN });
    await c.burst(c.text("2 libras de arroz"));
    await c.burst(c.text("a domicilio"));
    // A pin-only saved place is echoed without coordinates.
    expect(c.lastSent().body).toBe(["¿Te lo llevamos al mismo lugar de siempre?", COPY.samePlacePin, "Respondé Sí u Otro lugar."].join("\n"));

    await c.tap("Otro lugar");
    expect(c.sent().at(-1)).toBe(ASK_WHERE);
    await c.burst(c.text(PLACE_TEXT));
    expect(c.sent().at(-1)).toBe(readback(TO_PLACE));
    c.h.clock.advance(60_000);
    await c.tap("Confirmar");
    expect((await c.places()).map((p) => p.place_text)).toEqual([null, PLACE_TEXT]);

    // The next order offers the newest place, again as a question.
    await c.handOver();
    await c.burst(c.text("1 jabon xtra"));
    expect(c.sent().at(-1)).toBe("Anotado ✅\n• 1 Jabón Xtra\n\n¿Lo recogés en la tienda o te lo llevamos?");
    await c.burst(c.text("me lo mandan"));
    expect(c.sent().at(-1)).toContain(`La vez pasada te lo llevamos a: ${PLACE_TEXT}.`);
  });

  it("a typed yes, read by perception, uses the saved place", async () => {
    const c = await customer([READ.arroz, READ.delivery, READ.yes]);
    await c.savePlace({ text: PLACE_TEXT, pin: null });
    await c.burst(c.text("2 libras de arroz"));
    await c.burst(c.text("me lo mandan"));
    await c.burst(c.text("Sí"));
    // Perception was told the question pending.
    expect(c.provider.textOf(2)).toContain("PREGUNTA PENDIENTE: same_place");
    expect(c.sent().at(-1)).toBe(readback(TO_PLACE));
  });

  it("a Sí tap naming a place that isn't the customer's saved one applies nothing", async () => {
    const c = await customer([READ.arroz, READ.delivery]);
    await c.savePlace({ text: PLACE_TEXT, pin: null });
    const theirs = await seedCustomer(c.store, newPhone());
    await env.DB.prepare(
      `INSERT INTO customer_places (id, business_id, customer_id, place_text, order_id, created_at_ms, last_used_at_ms)
       VALUES ('place-someone-else', ?, ?, 'otra casa', 'order-x', 1, 1)`,
    )
      .bind(c.store.businessId, theirs)
      .run();
    await c.burst(c.text("2 libras de arroz"));
    await c.burst(c.text("me lo mandan"));
    const order = (await c.openOrder())!;
    const forged = placeChoiceKey("same", order, "place-someone-else")!;
    await c.burst(buttonReply({ from: c.phone, id: wamid(), timestampS: nowS(c.h), replyId: forged, title: "Sí" }));
    expect(c.sent().at(-1)).toBe(COPY.statusBuilding);
    expect((await c.openOrder())!.fulfillment).toEqual({ mode: "delivery", placeId: null, placeText: null, pin: null, fee: null });
  });

  it("with no saved place, asks where instead", async () => {
    const c = await customer([READ.arroz, READ.delivery]);
    await c.burst(c.text("2 libras de arroz"));
    await c.burst(c.text("me lo mandan"));
    expect(c.sent().at(-1)).toBe(ASK_WHERE);
  });
});

describe("saved places in D1", () => {
  it("are read only within the store and the customer", async () => {
    const a = await seedStore({ members: [] });
    const b = await seedStore({ members: [] });
    const customerA = await seedCustomer(a, newPhone());
    const repo = new D1CustomerPlaceRepository(env.DB);
    await env.DB.batch([...repo.saveForOrderCommit(a, customerA, "order-1", { placeText: PLACE_TEXT, pin: null }, 10).statements]);
    expect(await repo.latest(a, customerA)).toMatchObject({ placeText: PLACE_TEXT, pin: null });
    expect(await repo.latest(b, customerA)).toBeNull();
  });

  it("one row per order: confirmed again, the order's place is updated, and never moved to another customer", async () => {
    const store = await seedStore({ members: [] });
    const one = await seedCustomer(store, newPhone());
    const two = await seedCustomer(store, newPhone());
    const repo = new D1CustomerPlaceRepository(env.DB);
    const run = (commit: ReturnType<typeof repo.saveForOrderCommit>) => env.DB.batch([...commit.statements]);
    await run(repo.saveForOrderCommit(store, one, "order-7", { placeText: "la escuela", pin: null }, 10));
    await run(repo.saveForOrderCommit(store, one, "order-7", { placeText: null, pin: PIN }, 20));
    await run(repo.saveForOrderCommit(store, two, "order-7", { placeText: "otra casa", pin: null }, 30));
    expect(await rows(`SELECT customer_id, place_text, latitude_e6 FROM customer_places WHERE business_id = ?`, store.businessId)).toEqual([
      { customer_id: one, place_text: null, latitude_e6: 10123456 },
    ]);
    // The guard fails loudly for a customer of another store.
    const other = await seedStore({ members: [] });
    const guard = repo.saveForOrderCommit(other, one, "order-8", { placeText: "x", pin: null }, 40).guards[0]!;
    expect(await env.DB.prepare(guard.holdsSql).bind(...guard.params).first()).toBeNull();
  });

  it("are deleted, with the pins on their messages, when the customer's data is purged", async () => {
    const c = await customer([READ.arroz, READ.delivery]);
    await c.burst(c.text("2 libras de arroz"));
    await c.burst(c.text("llevámelo"), c.pin());
    await c.tap("Confirmar");
    expect(await c.places()).toHaveLength(1);

    await env.DB.prepare(`UPDATE customers SET deletion_requested_at_ms = ? WHERE id = ?`).bind(c.h.clock.now(), c.customerId).run();
    expect(await c.h.deps.customerControls.purge(c.tenant, c.customerId, null, c.h.clock.now())).toBe(true);
    expect(await c.places()).toEqual([]);
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ? AND latitude_e6 IS NOT NULL`, c.store.businessId)).toEqual([]);
  });
});

describe("pieces", () => {
  it("parses a WhatsApp location into a pin, and drops one it can't use", () => {
    const base = { from: "50400000001", timestampS: 1_793_196_000 };
    const parsed = parseWebhookPayload(
      webhook("100000000000001", {
        messages: [
          locationMessage({ ...base, id: "wamid.L-1", ...PIN, name: "Lugar de prueba", address: "Calle de prueba" }),
          locationMessage({ ...base, id: "wamid.L-2", latitude: "10.5", longitude: "-80.25" }),
          locationMessage({ ...base, id: "wamid.L-3", latitude: 95, longitude: 0 }),
          locationMessage({ ...base, id: "wamid.L-4", latitude: "cerca", longitude: null }),
        ],
      }),
    );
    expect(parsed!.events.map((e) => (e.type === "message" ? [e.kind, e.location, e.textBody] : null))).toEqual([
      ["other", PIN, null],
      ["other", { latitude: 10.5, longitude: -80.25 }, null],
      ["other", null, null],
      ["other", null, null],
    ]);
  });

  it("rounds a pin to millionths of a degree, as stored", () => {
    expect(parsePin(10.1234567, -80.0000004)).toEqual({ latitude: 10.123457, longitude: -80 });
    expect(parsePin(Number.NaN, 0)).toBeNull();
    expect(parsePin(0, 181)).toBeNull();
  });

  it("adds the shared pin to a reading the model gave none, replacing a lone 'other'", () => {
    const pinMsg = { type: "location", ...PIN } as const;
    const reading = withSharedPin({ observations: [{ kind: "other", issues: [] }], calls: [] }, [{ type: "text", text: "aquí" }, pinMsg]);
    expect(reading.observations).toEqual([{ kind: "fulfillment", mode: null, pin: PIN, placeText: null, sameAsBefore: false, issues: [] }]);
    const unchanged = { observations: [{ kind: "other" as const, issues: [] }], calls: [] };
    expect(withSharedPin(unchanged, [{ type: "text", text: "hola" }])).toBe(unchanged);
  });

  it("reads the same-place buttons back into actions; foreign IDs give nothing", () => {
    const ref = { orderId: "order-1", version: 2 };
    expect(actionFromButtonId(placeChoiceKey("same", ref, "place-1")!)).toEqual({ type: "accept_saved_place", ...ref, placeId: "place-1" });
    expect(actionFromButtonId(placeChoiceKey("other", ref, "place-1")!)).toEqual({ type: "decline_saved_place", ...ref });
    expect(actionFromButtonId("place:order-1:v2:bad id")).toBeNull();
    expect(placeChoiceKey("same", ref, "bad id")).toBeNull();
  });

  it("shows a delivery fee only when the store set one, apart from the total", () => {
    const order = (fee: number | null): OrderView => ({
      orderId: "order-1",
      version: 1,
      state: "por_confirmar",
      lines: [
        {
          lineId: "l1",
          text: "2 libras de arroz",
          productId: "p-arroz",
          productName: "Arroz 1 lb",
          quantity: "2",
          unit: "libra",
          unitPrice: 3000,
          availability: "no_se",
          restricted: false,
          mark: null,
          substitute: null,
        },
      ],
      fulfillment: { mode: "delivery", placeId: null, placeText: PLACE_TEXT, fee, pin: null },
      total: 6000,
      queuePosition: null,
    });
    const body = (fee: number | null) => renderOutcome({ type: "readback", order: order(fee) }, { customerId: "c" })!.body;
    expect(body(null)).not.toContain("envío");
    expect(body(null)).toContain("💵 Total: L 60. Pagás cuando te lo entregamos.\n");
    expect(body(2500)).toContain("💵 Total: L 85 (L 60 + L 25 de envío). Pagás cuando te lo entregamos.\n");
  });

  it("knows a clear yes from anything else", () => {
    for (const yes of ["Sí", "si", "sí, ahí mismo", "Dale", "simón"]) expect(isYes(yes), yes).toBe(true);
    for (const no of ["no", "otro lugar", "sí pero otro lugar", "a la escuela", ""]) expect(isYes(no), no).toBe(false);
  });
});
