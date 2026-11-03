/**
 * Customer questions (#47): "¿Hay X?", "¿A cuánto?", "¿A qué hora abren?". Answers come from
 * records only: "sí hay", "ahorita no hay" or "te lo anoto y te confirmo"; only confirmed prices;
 * hours from settings or "te confirmo". Readings are authored in the wire format (synthetic), and
 * the engine is the pretend one; no test calls the network.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Engine, LineMatch } from "../src/application/engine";
import type { OrderReadingSource } from "../src/application/order-reading";
import { matchLines } from "../src/application/perception/matching";
import type { AnyPendiente, ModelProvider, ModelRequest, Pendientes, Tenant } from "../src/application/ports";
import type { BurstReading, Observation } from "../src/domain/contract/observation";
import type { AnswerFact, EngineOutcome, StoreHours } from "../src/domain/contract/outcomes";
import { COPY, firstCheck, flattenClaims, renderOutcome, unansweredCount } from "../src/domain/replies";
import { formatClock, formatDays, formatStoreHours, isUsableStoreHours } from "../src/domain/store-hours";
import { D1PretendEngine } from "../src/infrastructure/memory/d1-pretend-engine";
import { MemoryEngine, type PretendProduct } from "../src/infrastructure/memory/memory-engine";
import { harness } from "./helpers/harness";
import { newPhone, seedIntroducedCustomer, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const CUSTOMER = { customerId: "customer-1" };

const HOURS: StoreHours = [
  { days: [1, 2, 3, 4, 5, 6], opens: "07:00", closes: "19:00" },
  { days: [7], opens: "08:00", closes: "12:00" },
];
const HOURS_TEXT = "Abrimos de lunes a sábado de 7 a. m. a 7 p. m., y el domingo de 8 a. m. a 12 del mediodía.";

/** Synthetic products: made-up names, prices and stock evidence. */
function catalog(): PretendProduct[] {
  return [
    { productId: "p-arroz", names: ["Arroz 1 lb", "Arroz"], aliases: [], barcode: null, price: 1800, availability: "hay" },
    { productId: "p-leche", names: ["Leche entera 1 L", "Leche"], aliases: [], barcode: null, price: 3200, availability: "se_acabo" },
    { productId: "p-pan", names: ["Pan de molde", "Pan"], aliases: [], barcode: null, price: null },
    { productId: "p-cerveza", names: ["Cerveza lata", "Cerveza"], aliases: [], barcode: null, price: 3000, availability: "hay", restricted: true },
  ];
}

function render(outcome: EngineOutcome) {
  const rendered = renderOutcome(outcome, CUSTOMER);
  if (rendered === null) throw new Error(`no reply for ${outcome.type}`);
  return rendered;
}

const passesFirst = (outcome: EngineOutcome) => firstCheck(render(outcome).claims, { kind: "outcome", outcome, ...CUSTOMER });

const fact = (asked: string, more: Partial<AnswerFact> = {}): AnswerFact => ({
  asked,
  productId: null,
  unitPrice: null,
  availability: "no_se",
  restricted: false,
  ...more,
});

// ---------------------------------------------------------------------------------------------

describe("availability answers", () => {
  it("says 'sí hay' and 'ahorita no hay' only from records, each claimed, and 'te lo anoto' otherwise", () => {
    const outcome: EngineOutcome = {
      type: "answer",
      topic: "availability",
      facts: [
        fact("el arroz", { productId: "p-arroz", availability: "hay" }),
        fact("leche", { productId: "p-leche", availability: "se_acabo" }),
        fact("pan", { productId: "p-pan", availability: "no_se" }),
        fact("manteca roja"),
      ],
    };
    const reply = render(outcome);
    expect(reply.body).toBe(
      ["El arroz: sí hay.", "Leche: ahorita no hay.", "Pan: te confirmo si hay.", "Manteca roja: te confirmo si hay."].join("\n"),
    );
    expect(flattenClaims(reply.claims)).toEqual([
      { type: "availability", productId: "p-arroz", availability: "hay" },
      { type: "availability", productId: "p-leche", availability: "se_acabo" },
    ]);
    expect(passesFirst(outcome)).toBe(true);
    expect(unansweredCount(outcome)).toBe(2);
  });

  it("never says 'hay' for a product with no match, whatever availability the outcome carries", () => {
    const outcome: EngineOutcome = { type: "answer", topic: "availability", facts: [fact("arroz", { availability: "hay" })] };
    expect(render(outcome).body).toBe("Arroz: te confirmo si hay.");
    expect(render(outcome).claims).toEqual([]);
  });

  it("keeps alcohol and tobacco to the store, and asks which product when none was named", () => {
    const restricted: EngineOutcome = {
      type: "answer",
      topic: "availability",
      facts: [fact("cerveza", { productId: "p-cerveza", availability: "hay", restricted: true })],
    };
    expect(render(restricted).body).toBe("Cerveza: eso solo lo vendemos aquí en la tienda.");
    expect(render(restricted).claims).toEqual([]);
    expect(unansweredCount(restricted)).toBe(0);
    const empty: EngineOutcome = { type: "answer", topic: "availability", facts: [] };
    expect(render(empty).body).toBe(COPY.whichProduct);
    expect(unansweredCount(empty)).toBe(0);
  });
});

describe("price answers", () => {
  it("quotes only a confirmed price, claimed, and 'te lo confirmo' otherwise", () => {
    const outcome: EngineOutcome = {
      type: "answer",
      topic: "price",
      facts: [fact("el arroz", { productId: "p-arroz", unitPrice: 1800 }), fact("pan", { productId: "p-pan" }), fact("manteca roja")],
    };
    const reply = render(outcome);
    expect(reply.body).toBe(["El arroz: L 18.", "Pan: el precio te lo confirmo.", "Manteca roja: el precio te lo confirmo."].join("\n"));
    expect(flattenClaims(reply.claims)).toEqual([{ type: "unit_price", productId: "p-arroz", price: 1800 }]);
    expect(passesFirst(outcome)).toBe(true);
    expect(unansweredCount(outcome)).toBe(2);
  });

  it("never quotes a price for a product with no match", () => {
    const outcome: EngineOutcome = { type: "answer", topic: "price", facts: [fact("arroz", { unitPrice: 1800 })] };
    expect(render(outcome).body).toBe("Arroz: el precio te lo confirmo.");
  });
});

describe("store hours", () => {
  it("says the hours from settings, claimed exactly", () => {
    const outcome: EngineOutcome = { type: "store_hours", hours: HOURS };
    const reply = render(outcome);
    expect(reply.body).toBe(HOURS_TEXT);
    expect(flattenClaims(reply.claims)).toEqual([{ type: "store_hours", hours: HOURS }]);
    expect(passesFirst(outcome)).toBe(true);
    expect(unansweredCount(outcome)).toBe(0);
    // A claim for other hours isn't backed by this outcome.
    const other: EngineOutcome = { type: "store_hours", hours: [{ days: [1], opens: "07:00", closes: "18:00" }] };
    expect(firstCheck(render(other).claims, { kind: "outcome", outcome, ...CUSTOMER })).toBe(false);
  });

  it("says 'te confirmo' when the hours are unset or can't be read, never a default", () => {
    const unusable: (StoreHours | null)[] = [
      null,
      [],
      [{ days: [1], opens: "22:00", closes: "02:00" }], // past midnight: not expressible yet
      [{ days: [0], opens: "07:00", closes: "19:00" }],
      [{ days: [1], opens: "7:00", closes: "19:00" }],
      [
        { days: [1, 2], opens: "07:00", closes: "19:00" },
        { days: [2], opens: "08:00", closes: "12:00" },
      ],
    ];
    for (const hours of unusable) {
      const outcome: EngineOutcome = { type: "store_hours", hours };
      expect(render(outcome).body, JSON.stringify(hours)).toBe(COPY.hoursUnknown);
      expect(render(outcome).claims).toEqual([]);
      expect(unansweredCount(outcome)).toBe(1);
      expect(isUsableStoreHours(hours)).toBe(false);
    }
  });

  it("names days and times the way people say them", () => {
    expect(formatDays([1, 2, 3, 4, 5])).toBe("de lunes a viernes");
    expect(formatDays([6, 7])).toBe("sábado y domingo");
    expect(formatDays([7])).toBe("el domingo");
    expect(formatDays([1, 3, 5])).toBe("lunes, miércoles y viernes");
    expect(formatDays([1, 2, 3, 5])).toBe("de lunes a miércoles y viernes");
    expect(formatClock("06:30")).toBe("6:30 a. m.");
    expect(formatClock("12:00")).toBe("12 del mediodía");
    expect(formatClock("12:30")).toBe("12:30 p. m.");
    expect(formatClock("00:15")).toBe("12:15 a. m.");
    expect(formatStoreHours([{ days: [1, 2, 3, 4, 5, 6, 7], opens: "06:00", closes: "20:30" }])).toBe(
      "Abrimos de lunes a domingo de 6 a. m. a 8:30 p. m.",
    );
  });
});

// ---------------------------------------------------------------------------------------------

const question = (topic: Extract<Observation, { kind: "question" }>["topic"], products: string[] = []): Observation => ({
  kind: "question",
  topic,
  products,
  issues: [],
});

describe("matching the products asked about", () => {
  it("matches a question's products by code, by index into its products", () => {
    const products = catalog();
    const observations = [question("availability", ["el arroz", "Leche", "manteca roja", "la cerveza"])];
    expect(matchLines(observations, products)).toEqual<LineMatch[]>([
      { observation: 0, line: 0, productId: "p-arroz", how: "exact_name" },
      { observation: 0, line: 1, productId: "p-leche", how: "exact_name" },
      { observation: 0, line: 3, productId: "p-cerveza", how: "exact_name" },
    ]);
  });

  it("tries the words as said before dropping an article, and never breaks a tie", () => {
    const products = [
      { productId: "p-lafe", names: ["La Fe"], aliases: [], barcode: null },
      { productId: "p-fe", names: ["Fe"], aliases: [], barcode: null },
      { productId: "p-aceite-1", names: ["Aceite"], aliases: [], barcode: null },
      { productId: "p-aceite-2", names: ["Aceite"], aliases: [], barcode: null },
    ];
    expect(matchLines([question("price", ["la fe", "el aceite"])], products)).toEqual([
      { observation: 0, line: 0, productId: "p-lafe", how: "exact_name" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

const tenant = (): Tenant => ({ businessId: crypto.randomUUID() });
const contextOf = (t: Tenant) => ({ ...t, customerId: "c-1", conversationId: "conv-1", jobId: crypto.randomUUID(), nowMs: 1, customerName: null, customerNameAsked: false });
const readingOf = (...observations: Observation[]): BurstReading => ({ observations, calls: [] });

async function ask(engine: MemoryEngine, t: Tenant, observation: Observation): Promise<EngineOutcome> {
  const reading = readingOf(observation);
  const matches = matchLines(reading.observations, await engine.catalog());
  return (await engine.onBurst(contextOf(t), reading, matches)).outcome;
}

describe("the pretend engine answers from its records", () => {
  it("availability: hay, se acabó, no sé, unmatched and restricted", async () => {
    const engine = new MemoryEngine(() => [], { catalog: catalog() });
    const t = tenant();
    expect(await ask(engine, t, question("availability", ["arroz", "leche", "pan", "manteca", "cerveza"]))).toEqual({
      type: "answer",
      topic: "availability",
      facts: [
        { asked: "arroz", productId: "p-arroz", unitPrice: 1800, availability: "hay", restricted: false },
        { asked: "leche", productId: "p-leche", unitPrice: 3200, availability: "se_acabo", restricted: false },
        { asked: "pan", productId: "p-pan", unitPrice: null, availability: "no_se", restricted: false },
        { asked: "manteca", productId: null, unitPrice: null, availability: "no_se", restricted: false },
        { asked: "cerveza", productId: "p-cerveza", unitPrice: null, availability: "no_se", restricted: true },
      ],
    });
  });

  it("price: only the confirmed price, and nothing for an unmatched product", async () => {
    const engine = new MemoryEngine(() => [], { catalog: catalog() });
    const outcome = await ask(engine, tenant(), question("price", ["arroz", "pan", "manteca"]));
    expect(render(outcome).body).toBe(["Arroz: L 18.", "Pan: el precio te lo confirmo.", "Manteca: el precio te lo confirmo."].join("\n"));
  });

  it("hours: from its settings, or null when unset", async () => {
    const t = tenant();
    expect(await ask(new MemoryEngine(() => [], { storeHours: HOURS }), t, question("store_hours"))).toEqual({ type: "store_hours", hours: HOURS });
    expect(await ask(new MemoryEngine(), t, question("store_hours"))).toEqual({ type: "store_hours", hours: null });
  });

  it("off-topic questions get the short redirect; the balance goes to the store", async () => {
    const engine = new MemoryEngine(() => [], { catalog: catalog() });
    expect(await ask(engine, tenant(), question("other"))).toEqual({ type: "out_of_scope" });
    expect(await ask(engine, tenant(), question("balance"))).toEqual({ type: "handoff" });
  });

  it("verifies price, stock and hours claims against its records now", async () => {
    const products = catalog();
    const engine = new MemoryEngine(() => [], { catalog: products, storeHours: HOURS });
    const t = tenant();
    expect(
      await engine.verifyClaims(t, [
        { type: "unit_price", productId: "p-arroz", price: 1800 },
        { type: "unit_price", productId: "p-arroz", price: 1700 },
        { type: "unit_price", productId: "p-cerveza", price: 3000 }, // restricted: never quoted
        { type: "unit_price", productId: "p-nada", price: 1800 },
        { type: "availability", productId: "p-arroz", availability: "hay" },
        { type: "availability", productId: "p-leche", availability: "hay" },
        { type: "availability", productId: "p-pan", availability: "hay" },
        { type: "store_hours", hours: HOURS },
        { type: "store_hours", hours: [HOURS[0]!] },
      ]),
    ).toEqual([true, false, false, false, true, false, false, true, false]);
    expect(await new MemoryEngine().verifyClaims(t, [{ type: "store_hours", hours: HOURS }])).toEqual([false]);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the Worker on local D1: webhook → reader (recorded) → pretend engine → claim checks → send.

class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  constructor(private readonly readings: unknown[]) {}
  async complete(request: ModelRequest) {
    this.requests.push(request);
    const json = this.readings.shift();
    if (json === undefined) throw new Error("no recorded reading left");
    return { ok: true, json, latencyMs: 7_000, inputTokens: 3_950, outputTokens: 1_500 } as const;
  }
}

class RecordingPendientes implements Pendientes {
  items: AnyPendiente[] = [];
  async raise(_tenant: Tenant, item: AnyPendiente): Promise<void> {
    this.items.push(item);
  }
}

const wireQuestion = (topic: string, products: string[] = []) => ({ observations: [{ kind: "question", topic, products, issues: [] }] });

type PretendEngine = Engine & OrderReadingSource;

async function questionTrip(readings: unknown[], makeEngine: () => PretendEngine) {
  const store = await seedStore({ members: [] });
  const phone = newPhone();
  await seedIntroducedCustomer(store, phone);
  const engine = makeEngine();
  const pendientes = new RecordingPendientes();
  const h = harness({ engine, modelProvider: new RecordedProvider(readings), pendientes });
  const say = async (body: string) => {
    h.clock.advance(1_000);
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body })] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
    return h.sentTo(phone).at(-1);
  };
  return { h, store, phone, engine, pendientes, say };
}

const ENGINES = [
  ["in memory", (products: PretendProduct[], hours: StoreHours | null) => new MemoryEngine(() => [], { catalog: products, storeHours: hours })],
  ["with its state in D1", (products: PretendProduct[], hours: StoreHours | null) => new D1PretendEngine(env.DB, { catalog: products, storeHours: hours })],
] as const;

describe("customer questions end to end", () => {
  it.each(ENGINES)("answers ¿hay?, ¿a cuánto?, hours and off-topic honestly (%s)", async (_label, makeEngine) => {
    const t = await questionTrip(
      [
        wireQuestion("availability", ["arroz", "leche", "manteca roja"]),
        wireQuestion("price", ["el arroz", "pan"]),
        wireQuestion("store_hours"),
        wireQuestion("other"),
      ],
      () => makeEngine(catalog(), null),
    );

    expect(await t.say("¿Hay arroz, leche y manteca roja?")).toBe(
      ["Arroz: sí hay.", "Leche: ahorita no hay.", "Manteca roja: te confirmo si hay."].join("\n"),
    );
    expect(await t.say("¿A cuánto el arroz y el pan?")).toBe(["El arroz: L 18.", "Pan: el precio te lo confirmo."].join("\n"));
    expect(await t.say("¿A qué hora abren?")).toBe(COPY.hoursUnknown);
    expect(await t.say("¿Quién ganó el partido?")).toBe(COPY.outOfScope);

    // Every "te confirmo" is raised for a person, with IDs and counts only.
    expect(t.pendientes.items.filter((item) => item.kind === "customer_question")).toEqual([
      expect.objectContaining({ topic: "availability", unknown: 1 }),
      expect.objectContaining({ topic: "price", unknown: 1 }),
      expect.objectContaining({ topic: "store_hours", unknown: 1 }),
    ]);
    // No customer words reach the logs.
    expect(t.h.log.lines.join("\n")).not.toMatch(/manteca|arroz|partido/i);
    // Nothing was blocked by the claim check, and every reply was sent.
    expect(t.pendientes.items.filter((item) => item.kind === "claim_blocked")).toEqual([]);
  });

  it.each(ENGINES)("says the store hours from settings (%s)", async (_label, makeEngine) => {
    const t = await questionTrip([wireQuestion("store_hours")], () => makeEngine(catalog(), HOURS));
    expect(await t.say("¿Hasta qué hora atienden?")).toBe(HOURS_TEXT);
    expect(t.pendientes.items).toEqual([]);
  });

  it("sends the safe reply when the price changed between the answer and the send", async () => {
    const products = catalog();
    const engine = new MemoryEngine(() => [], { catalog: products });
    const t = await questionTrip([wireQuestion("price", ["arroz"])], () => engine);
    const onBurst = engine.onBurst.bind(engine);
    engine.onBurst = async (...args) => {
      const result = await onBurst(...args);
      // Johan changes the price after the answer was decided, before it is sent.
      products[0] = { ...products[0]!, price: 2000 };
      return result;
    };
    expect(await t.say("¿A cuánto el arroz?")).toBe(COPY.safeReply);
    expect(t.h.sentTo(t.phone).join("\n")).not.toContain("L 18");
    expect(t.pendientes.items).toEqual([expect.objectContaining({ kind: "claim_blocked", stage: "before_send" })]);
  });
});
