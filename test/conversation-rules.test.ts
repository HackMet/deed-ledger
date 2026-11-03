/**
 * How the assistant talks to customers (conversation rules, Oct 31), end to end through the Worker:
 * WhatsApp in, recorded readings, the pretend engine (in memory and with its state in D1), the
 * replies templates, the outbox and the fake channel. Pure rules have unit tests at the bottom.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Engine } from "../src/application/engine";
import type { OrderReadingSource } from "../src/application/order-reading";
import type { ModelProvider, ModelRequest } from "../src/application/ports";
import { HANDED_TO_STORE } from "../src/domain/copy";
import { asksToStop, controlWord, STOP_ASK, stopConfirmed } from "../src/domain/customer-controls";
import { nameFrom } from "../src/domain/customer-name";
import { COPY, confirmNudge, greetingLine, handoffText, renderOutcome } from "../src/domain/replies";
import { foldShortText, isTypedYes, smallTalk, typedButtonNumber } from "../src/domain/small-talk";
import type { OrderView } from "../src/domain/contract/outcomes";
import { D1PretendEngine } from "../src/infrastructure/memory/d1-pretend-engine";
import { MemoryEngine, type PretendProduct } from "../src/infrastructure/memory/memory-engine";
import { line, quote } from "./fixtures/model/recorded";
import { type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedIntroducedCustomer, seedStore } from "./helpers/seed";
import { buttonReply, textMessage, wamid, webhook } from "./helpers/whatsapp";

const SETTLED_MS = 4_000;
const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

const CATALOG: readonly PretendProduct[] = [
  { productId: "p-arroz", names: ["Arroz 1 lb", "Arroz"], aliases: [], barcode: null, price: 3000 },
  { productId: "p-leche", names: ["Leche Sula 1 L", "Leche"], aliases: [], barcode: null, price: 3200 },
];

const none = { issues: [] };
const READ = {
  arroz: { observations: [{ kind: "customer_order", lines: [line("2 libras de arroz", "arroz", "2", "libra", quote(0, "2 libras de arroz"))], ...none }] },
  pickup: { observations: [{ kind: "fulfillment", mode: "pickup", place_text: null, same_as_before: false, ...none }] },
  nothing: { observations: [{ kind: "other", ...none }] },
  yesAnswer: { observations: [{ kind: "clarification", answer: "sí", pick: null, quantity: null, evidence: quote(0, "sí"), ...none }] },
  carla: { observations: [{ kind: "customer_name", name: "Carla", evidence: quote(0, "Carla"), ...none }] },
  priceAndOrder: {
    observations: [
      { kind: "question", topic: "price", products: ["la leche"], ...none },
      { kind: "customer_order", lines: [line("2 libras de arroz", "arroz", "2", "libra", quote(0, "2 libras de arroz"))], ...none },
    ],
  },
} as const;

const ASK_HOW = "Anotado ✅ 2 × Arroz 1 lb.\n¿Lo recogés en la tienda o te lo llevamos?";
const CONFIRMED_CARLA = "Listo, Carla 🙌 Tu pedido #101 quedó anotado. Total: L 60. Te aviso cuando esté listo.";

class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  /** Runs inside the next call, as if the customer wrote while the model read. */
  during: (() => Promise<void>) | null = null;
  constructor(private readonly readings: unknown[]) {}
  async complete(request: ModelRequest) {
    this.requests.push(request);
    const during = this.during;
    this.during = null;
    await during?.();
    const json = this.readings.shift();
    if (json === undefined) throw new Error("no recorded reading left");
    return { ok: true, json, latencyMs: 5_000, inputTokens: 3_000, outputTokens: 500 } as const;
  }
}

type PretendEngine = Engine & OrderReadingSource;
const ENGINES = [
  ["in memory", (): PretendEngine => new MemoryEngine(() => [], { catalog: CATALOG })],
  ["with its state in D1", (): PretendEngine => new D1PretendEngine(env.DB, { catalog: CATALOG })],
] as const;

/** An introduced customer, named or not, on a pretend engine with recorded readings. */
async function customer(readings: unknown[], options: { name?: string | null; makeEngine?: () => PretendEngine } = {}) {
  const store = await seedStore({ members: [] });
  const phone = newPhone();
  const customerId = await seedIntroducedCustomer(store, phone);
  if (options.name != null) {
    await env.DB.prepare(`UPDATE customers SET name = ?, name_saved_at_ms = 1 WHERE id = ?`).bind(options.name, customerId).run();
  }
  const engine = (options.makeEngine ?? ENGINES[0][1])();
  const provider = new RecordedProvider(readings);
  const h = harness({ engine, modelProvider: provider });
  const tenant = { businessId: store.businessId };
  const at = () => ({ from: phone, id: wamid(), timestampS: nowS(h) });
  const send = async (message: unknown) => {
    h.clock.advance(1_000);
    await h.post(webhook(store.phoneNumberId, { messages: [message] }));
    h.clock.advance(SETTLED_MS);
    await h.deliver(h.takeRingsFor(store.businessId));
  };
  const sent = () => h.channel.sent.filter((s) => s.toPhone === phone);
  const lastSent = () => sent().at(-1)!;
  return {
    h,
    store,
    phone,
    customerId,
    engine,
    provider,
    tenant,
    sent,
    lastSent,
    say: async (body: string) => {
      await send(textMessage({ ...at(), body }));
      return lastSent().body;
    },
    /** Taps the last reply's button with this title. */
    tap: async (title: string) => {
      const button = lastSent().buttons?.find((b) => b.title === title);
      if (button === undefined) throw new Error(`no ${title} button on the last reply`);
      await send(buttonReply({ ...at(), replyId: button.id, title }));
      return lastSent().body;
    },
    /** Posts a text without settling: it arrives while something else is being handled. */
    post: (body: string) => h.post(webhook(store.phoneNumberId, { messages: [textMessage({ ...at(), body })] })),
    settle: async () => {
      h.clock.advance(SETTLED_MS);
      await h.deliver(h.takeRingsFor(store.businessId));
      return lastSent().body;
    },
    /** Taps a button by ID, as a stale or replayed tap would. */
    tapId: (replyId: string, title: string) => send(buttonReply({ ...at(), replyId, title })),
    confirmedCount: async () =>
      (await engine.preparationList(tenant)).filter((card) => card.order.state === "confirmado").length,
    savedName: async () =>
      (await rows<{ name: string | null }>(`SELECT name FROM customers WHERE id = ?`, customerId))[0]!.name,
  };
}

/** Builds an order to its readback: "2 libras de arroz", then pickup. */
async function toReadback(c: Awaited<ReturnType<typeof customer>>) {
  expect(await c.say("2 libras de arroz")).toBe(ASK_HOW);
  const readback = await c.say("lo paso a traer");
  expect(readback.startsWith("Tu pedido:")).toBe(true);
  expect(c.lastSent().buttons?.map((b) => b.title)).toEqual(["Confirmar", "Corregir", "Cancelar"]);
}

describe("never silent", () => {
  it.each(ENGINES)("a message that changes nothing hears the open question again (%s)", async (_label, makeEngine) => {
    const c = await customer([READ.arroz, READ.nothing], { name: "Carla", makeEngine });
    expect(await c.say("2 libras de arroz")).toBe(ASK_HOW);
    const before = c.sent().length;
    expect(await c.say("mmm déjame ver")).toBe(ASK_HOW);
    expect(c.sent()).toHaveLength(before + 1);
  });

  it("a message with nothing to act on and no order asks what they want", async () => {
    const c = await customer([READ.nothing]);
    expect(await c.say("ey")).toBe("¿Qué te mando? Escribime la lista, mandame una foto o una nota de voz.");
  });
});

describe("the name, asked at the end", () => {
  it.each(ENGINES)("isn't asked while the order is built; Confirmar asks it, and the name completes the confirmation once (%s)", async (_label, makeEngine) => {
    const c = await customer([READ.arroz, READ.pickup, READ.yesAnswer, READ.carla], { makeEngine });
    await toReadback(c);
    expect(c.sent().map((s) => s.body)).not.toContain(COPY.askName);

    // Tapped with no name on file: asked, not yet confirmed.
    expect(await c.tap("Confirmar")).toBe(COPY.askName);
    expect(await c.confirmedCount()).toBe(0);

    // Not a name: asked again, warmly, once.
    expect(await c.say("sí")).toBe(COPY.askNameAgain);
    expect(await c.savedName()).toBeNull();
    expect(await c.confirmedCount()).toBe(0);

    // The name completes the held Confirmar: no second tap needed.
    expect(await c.say("Carla")).toBe(CONFIRMED_CARLA);
    expect(await c.savedName()).toBe("Carla");
    const cards = await c.engine.preparationList(c.tenant);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ customerName: "Carla", order: { state: "confirmado" } });

    // The old Confirmar again shares the held key: a duplicate, never a second confirmation.
    const confirmId = c.sent().find((s) => s.body.startsWith("Tu pedido:"))!.buttons![0]!.id;
    await c.tapId(confirmId, "Confirmar");
    expect(await c.confirmedCount()).toBe(1);
    expect(c.lastSent().body).toBe(COPY.welcome);
  });

  it("is never asked of a customer whose name is on file", async () => {
    const c = await customer([READ.arroz, READ.pickup], { name: "Carla" });
    await toReadback(c);
    expect(await c.tap("Confirmar")).toBe(CONFIRMED_CARLA);
    expect(c.sent().map((s) => s.body)).not.toContain(COPY.askName);
  });

  it("'ta bien, Luis' after the name question is read by code, with no model call, and confirms", async () => {
    const c = await customer([READ.arroz, READ.pickup]);
    await toReadback(c);
    expect(await c.tap("Confirmar")).toBe(COPY.askName);
    const calls = c.provider.requests.length;
    expect(await c.say("ta bien, Luis")).toMatch(/^Listo, Luis 🙌 Tu pedido #\d+ quedó anotado\./u);
    expect(c.provider.requests).toHaveLength(calls);
    expect(await c.savedName()).toBe("Luis");
    expect(await c.confirmedCount()).toBe(1);
  });
});

describe("a typed yes under a readback", () => {
  it.each(ENGINES)("\"dale\" is Confirmar for the version shown, with no model call (%s)", async (_label, makeEngine) => {
    const c = await customer([READ.arroz, READ.pickup], { name: "Carla", makeEngine });
    await toReadback(c);
    expect(await c.say("dale")).toBe(CONFIRMED_CARLA);
    expect(c.provider.requests).toHaveLength(2);
    expect(await c.confirmedCount()).toBe(1);
  });

  it("\"sí\" confirms, and the Confirmar button after it is a duplicate", async () => {
    const c = await customer([READ.arroz, READ.pickup], { name: "Carla" });
    await toReadback(c);
    const confirmId = c.lastSent().buttons![0]!.id;
    expect(await c.say("Sí")).toBe(CONFIRMED_CARLA);
    expect(c.provider.requests).toHaveLength(2);
    await c.tapId(confirmId, "Confirmar");
    expect(await c.confirmedCount()).toBe(1);
    expect(c.lastSent().body).toBe(COPY.welcome);
  });

  it("\"👍\" after the confirm nudge confirms: the nudge carries the same buttons", async () => {
    const c = await customer([READ.arroz, READ.pickup], { name: "Carla" });
    await toReadback(c);
    expect(await c.say("gracias")).toBe(COPY.confirmNudge);
    expect(c.lastSent().buttons?.map((b) => b.title)).toEqual(["Confirmar", "Corregir", "Cancelar"]);
    expect(await c.say("👍")).toBe(CONFIRMED_CARLA);
    expect(c.provider.requests).toHaveLength(2);
  });

  it("a yes after a message without the Confirmar button is read, not taken as Confirmar", async () => {
    const c = await customer([READ.arroz, READ.yesAnswer], { name: "Carla" });
    expect(await c.say("2 libras de arroz")).toBe(ASK_HOW);
    await c.say("sí");
    expect(c.provider.requests).toHaveLength(2);
    expect(await c.confirmedCount()).toBe(0);
  });
});

describe("thanks, ok and greetings", () => {
  it("\"gracias\" with nothing pending is ¡A la orden!, with no model call", async () => {
    const c = await customer([]);
    expect(await c.say("Gracias!!")).toBe(COPY.welcome);
    expect(c.provider.requests).toHaveLength(0);
  });

  it("a greeting mid-order says hi by name and asks the open question again", async () => {
    const c = await customer([READ.arroz], { name: "Carla" });
    expect(await c.say("2 libras de arroz")).toBe(ASK_HOW);
    expect(await c.say("buenas")).toBe(`${greetingLine("Carla")}\n${ASK_HOW}`);
    expect(c.provider.requests).toHaveLength(1);
  });

  it("a greeting without a name on file", async () => {
    const c = await customer([READ.arroz]);
    await c.say("2 libras de arroz");
    expect(await c.say("Buenos días")).toBe(`¡Buenas! 👋\n${ASK_HOW}`);
  });

  it("a thanks after a readback that was never sent (withheld for it) gets the readback in full", async () => {
    const c = await customer([READ.arroz, READ.pickup], { name: "Carla" });
    expect(await c.say("2 libras de arroz")).toBe(ASK_HOW);
    // "gracias" arrives while "lo paso a traer" is read: that job's readback is withheld for it.
    c.provider.during = async () => {
      c.h.clock.advance(500);
      await c.post("gracias");
    };
    await c.say("lo paso a traer");
    const body = await c.settle();
    expect(body.startsWith("Tu pedido:")).toBe(true);
    expect(c.sent().map((s) => s.body)).not.toContain(COPY.confirmNudge);
    expect(c.lastSent().buttons?.map((b) => b.title)).toEqual(["Confirmar", "Corregir", "Cancelar"]);
  });

  it("a greeting with a readback waiting nudges toward Confirmar, with its buttons", async () => {
    const c = await customer([READ.arroz, READ.pickup], { name: "Carla" });
    await toReadback(c);
    expect(await c.say("hola")).toBe(`${greetingLine("Carla")}\n${COPY.confirmNudge}`);
    expect(c.lastSent().buttons?.map((b) => b.title)).toEqual(["Confirmar", "Corregir", "Cancelar"]);
  });
});

describe("a question and an order in one message", () => {
  it.each(ENGINES)("answers the question first, then the order's next step, in one reply (%s)", async (_label, makeEngine) => {
    const c = await customer([READ.priceAndOrder], { name: "Carla", makeEngine });
    const reply = await c.say("¿a cómo la leche? y mandame 2 libras de arroz");
    expect(reply.split("\n")).toEqual(["La leche: L 32.", ...ASK_HOW.split("\n")]);
    expect(c.sent()).toHaveLength(1);
  });
});

describe("a number after buttons", () => {
  it("\"1\" right after the readback is its first button: Confirmar", async () => {
    const c = await customer([READ.arroz, READ.pickup], { name: "Carla" });
    await toReadback(c);
    expect(await c.say("1")).toBe(CONFIRMED_CARLA);
    expect(c.provider.requests).toHaveLength(2);
  });

  it("\"3\" right after the readback is Cancelar", async () => {
    const c = await customer([READ.arroz, READ.pickup], { name: "Carla" });
    await toReadback(c);
    expect(await c.say("3.")).toBe(COPY.cancelled);
  });

  it("a number after a message with no buttons is read, never guessed", async () => {
    const c = await customer([READ.arroz, READ.nothing], { name: "Carla" });
    expect(await c.say("2 libras de arroz")).toBe(ASK_HOW);
    await c.say("2");
    expect(c.provider.requests).toHaveLength(2);
  });
});

describe("stop in other words", () => {
  it("asks with one tap that is the real ALTO, and stops nothing until it's tapped", async () => {
    const c = await customer([]);
    expect(await c.say("ya no me manden más mensajes")).toBe(STOP_ASK);
    const stopped = async () =>
      (await rows<{ stopped_at_ms: number | null }>(`SELECT stopped_at_ms FROM customers WHERE id = ?`, c.customerId))[0]!.stopped_at_ms;
    expect(await stopped()).toBeNull();
    expect(c.provider.requests).toHaveLength(0);

    const body = await c.tap("Sí, pausar");
    expect(body.startsWith("Listo, pausé los mensajes.")).toBe(true);
    expect(body).not.toContain("escribí: quiero hablar");
    expect(await stopped()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The rules, unit by unit

describe("small talk, decided by code", () => {
  it("knows a greeting, a thanks and an ok only as the whole message", () => {
    expect(smallTalk("Holaaa!")).toBe("greeting");
    expect(smallTalk("buenos días")).toBe("greeting");
    expect(smallTalk("Gracias")).toBe("thanks");
    expect(smallTalk("ok")).toBe("ack");
    expect(smallTalk("hola, mandame 2 libras de arroz")).toBeNull();
  });

  it("takes the approved typed yes words, any case or accent, and nothing else", () => {
    for (const yes of ["sí", "Si", "dale", "va", "OK", "listo", "confirmo", "así está bien", "👍"]) expect(isTypedYes(yes)).toBe(true);
    for (const other of ["sí pero sin arroz", "dale con 3", "no", "bueno, y la leche?"]) expect(isTypedYes(other)).toBe(false);
  });

  it("reads 1, 2 or 3 alone as a button's place", () => {
    expect(typedButtonNumber("1")).toBe(1);
    expect(typedButtonNumber(" 3. ")).toBe(3);
    expect(typedButtonNumber("(2)")).toBe(2);
    expect(typedButtonNumber("4")).toBeNull();
    expect(typedButtonNumber("2 libras")).toBeNull();
  });
});

describe("a name, decided by code", () => {
  it("keeps a name, with its lead-in dropped", () => {
    expect(nameFrom("Carla")).toBe("Carla");
    expect(nameFrom("a nombre de Doña Marta")).toBe("Doña Marta");
    expect(nameFrom("soy Ma. José")).toBe("Ma. José");
  });

  it("never takes a yes, a number, an emoji, a product or a sentence", () => {
    for (const notName of ["sí", "ok", "dale", "123", "👍", "¿y la leche?", "quiero arroz y leche por favor ya", "no"]) {
      expect(nameFrom(notName)).toBeNull();
    }
    // The handler passes catalog names folded the same way.
    expect(nameFrom("Arroz", new Set([foldShortText("arroz")]))).toBeNull();
  });
});

describe("stop words and copy", () => {
  it("knows a wish to stop in other words, never ALTO itself", () => {
    for (const ask of ["no me manden más", "ya no quiero mensajes", "baja", "no más mensajes"]) expect(asksToStop(ask)).toBe(true);
    expect(asksToStop("ALTO")).toBe(false);
    expect(controlWord("ALTO")).toBe("stop");
    expect(asksToStop("no me mandes arroz")).toBe(false);
  });

  it("the ALTO confirmation teaches plain words, not a phrase to type", () => {
    const text = stopConfirmed({ storeName: "Punto", ownerName: "Johan", privacyUrl: null });
    expect(text).not.toContain("escribí: quiero hablar");
    expect(text).toContain("SEGUIR");
  });

  it("hands off without promising a time", () => {
    expect(handoffText("Johan")).toBe("Se lo dejo anotado a Johan, te escribe por aquí.");
    expect(handoffText(null)).not.toMatch(/en un momento|ahorita|enseguida/);
    expect(HANDED_TO_STORE).not.toMatch(/otra vez/);
    expect(COPY.slowNotice).not.toMatch(/en un momento/);
  });
});

describe("tocá only when there is a button", () => {
  const readback: OrderView = {
    orderId: "o-1",
    version: 1,
    state: "por_confirmar",
    lines: [
      {
        lineId: "l-1",
        text: "2 lb arroz",
        productId: "p-arroz",
        productName: "Arroz 1 lb",
        quantity: "2",
        unit: null,
        unitPrice: 3000,
        availability: "hay",
        restricted: false,
        mark: null,
        substitute: null,
      },
    ],
    fulfillment: { mode: "pickup" },
    total: 6000,
    queuePosition: null,
  };

  it("the confirm nudge points at Confirmar only with its buttons on the same message", () => {
    const nudge = confirmNudge(readback);
    expect(nudge.body).toBe(COPY.confirmNudge);
    expect(nudge.buttons.map((b) => b.title)).toEqual(["Confirmar", "Corregir", "Cancelar"]);
  });

  it("the readback keeps a typed fallback as its soft last line", () => {
    const body = renderOutcome({ type: "readback", order: readback }, { customerId: "c-1" })!.body;
    expect(body.split("\n").at(-1)).toBe(COPY.typedFallbackSoft);
    expect(body.match(/[\p{Extended_Pictographic}]/gu) ?? []).toHaveLength(0);
  });
});
