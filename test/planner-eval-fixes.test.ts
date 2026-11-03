/**
 * Fixes for what the head-to-head eval found on the planner path (Nov 3): an option list that never
 * resolved (E19, E09b), a voice note read differently from the same text (E21), and "una" right
 * after a product question (E11). Each test failed on the code it was written against. Recorded
 * model answers, no network.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CustomerContext } from "../src/application/engine";
import { ONE_CALL_SCHEMA_NAME } from "../src/application/planner/one-call";
import type { BurstReading, Observation } from "../src/domain/contract/observation";
import type { EngineOutcome } from "../src/domain/contract/outcomes";
import { chosenOption, type ShownOption } from "../src/domain/planner/option-answer";
import type { TurnPlan } from "../src/domain/planner/types";
import { orderBasis } from "../src/domain/planner/frame";
import { D1StoreSetupRepository } from "../src/infrastructure/d1/store-setup-repository";
import { MemoryEngine, type PretendProduct } from "../src/infrastructure/memory/memory-engine";
import { line as wireLine, quote } from "./fixtures/model/recorded";
import { plannerStore } from "./helpers/planner-trip";

const STORE = [
  { name: "Aceite Clover 1 L", price: 6000 },
  { name: "Aceite Clover 500 ml", price: 3400 },
  { name: "Aceite Mazola 1 L", price: 6500 },
  { name: "Jabón Xtra barra", price: 3500 },
  { name: "Arroz 1 lb", price: 1800, soldBy: "unit" as const },
  { name: "Miel de abeja Don Pancho 500 ml", price: null },
];

const names = { other_names: [] };
const op = (kind: string, line: string, product: string | null = null, quantity: string | null = null) => ({ op: kind, line, product, quantity, suggested_quantity: null });
const turn = (ops: unknown[], move: string, ask: { kind: string; lines: string[] } = { kind: "none", lines: [] }) => ({ ops, move, ask, say: "" });
const OTHER = { kind: "other", issues: [] };

/** "deme un aciete y 2 jabones": seen before the call, T1 aciete → P1–P3 (near spelling), T2 jabones → P4 Jabón. */
const ACIETE = {
  observations: [
    {
      kind: "customer_order",
      lines: [
        wireLine("un aciete", "aciete", "1", null, quote(0, "un aciete"), names),
        wireLine("2 jabones", "jabones", "2", null, quote(0, "2 jabones"), names),
      ],
      issues: [],
    },
  ],
  ...turn([op("add", "N1", null, "1"), op("add", "N2", "P4", "2")], "ask", { kind: "options", lines: ["N1"] }),
};

describe("E19, E09b: an option list always resolves or moves on", () => {
  const shown: ShownOption[] = [
    { number: 1, lineId: "l1", productId: "clover-1l", name: "Aceite Clover 1 L", price: 6000 },
    { number: 2, lineId: "l1", productId: "clover-500", name: "Aceite Clover 500 ml", price: 3400 },
    { number: 3, lineId: "l1", productId: "mazola", name: "Aceite Mazola 1 L", price: 6500 },
  ];
  const chosen = (said: string) => chosenOption([said], shown)?.productId ?? null;

  it("reads an answer by number, price, brand or size, and nothing unclear", () => {
    expect(["2", "el 2", "la segunda", "esa de 34", "la de L 34", "34", "mazola, la de marca porfa", "el clover de litro", "la de 500"].map(chosen)).toEqual([
      "clover-500",
      "clover-500",
      "clover-500",
      "clover-500",
      "clover-500",
      "clover-500",
      "mazola",
      "clover-1l",
      "clover-500",
    ]);
    expect(["la de litro", "lo recojo", "ok, Pedro", "la de 99", "clover"].map(chosen)).toEqual([null, null, null, null, null]);
  });

  it("'esa de 34' picks the option even when the reading isn't an answer: no third list", async () => {
    const t = await plannerStore(STORE, { [ONE_CALL_SCHEMA_NAME]: [ACIETE, { observations: [OTHER], ...turn([], "restate") }] });
    await t.say("deme un aciete y 2 jabones");
    expect(t.last()).toContain("Para un aciete tengo:");
    await t.say("esa de 34");
    // Only the line the pick changed: the jabones were noted with the list already.
    expect(t.last()).toBe("Anotado ✅\n• 1 Aceite Clover 500 ml\n\n¿Lo recogés en la tienda o te lo llevamos?");
  });

  it("'mazola, la de marca' picks it even when the planner asks the same list again", async () => {
    const t = await plannerStore(STORE, {
      [ONE_CALL_SCHEMA_NAME]: [
        ACIETE,
        {
          observations: [{ kind: "clarification", answer: "mazola, la de marca porfa", pick: null, quantity: null, evidence: quote(0, "mazola, la de marca porfa"), issues: [] }],
          ...turn([], "ask", { kind: "options", lines: ["L1"] }),
        },
      ],
    });
    await t.say("deme un aciete y 2 jabones");
    await t.say("mazola, la de marca porfa");
    expect(t.last()).toBe("Anotado ✅\n• 1 Aceite Mazola 1 L\n\n¿Lo recogés en la tienda o te lo llevamos?");
  });

  it("never asks the same list a third time: the line is left for the store to confirm, and the order moves on", async () => {
    const catalog: PretendProduct[] = [
      { productId: "clover-1l", names: ["Aceite Clover 1 L"], aliases: [], barcode: null, price: 6000 },
      { productId: "mazola", names: ["Aceite Mazola 1 L"], aliases: [], barcode: null, price: 6500 },
    ];
    const engine = new MemoryEngine(() => [], { catalog });
    let job = 0;
    const context = (): CustomerContext => ({ businessId: "s", conversationId: "c", customerId: "u", jobId: `j${++job}`, nowMs: job });
    const burst = async (observations: Observation[], lineRef: string): Promise<EngineOutcome> => {
      const basis = orderBasis((await engine.plannerContext(context())).order);
      const plan: TurnPlan = { move: "ask", ask: { kind: "options", lineRefs: [lineRef] }, assumed: [], say: "", basis, options: [{ lineRef, productIds: ["clover-1l", "mazola"] }] };
      const reading: BurstReading = { observations, calls: [] };
      return (await engine.onBurst(context(), reading, [], plan)).outcome;
    };
    const evidence = { source: "text", message: 0, start: 0, end: 1 } as const;
    const first = await burst([{ kind: "customer_order", lines: [{ text: "un aceite", name: "aceite", quantity: "1", unit: null, restrictedCategory: false, evidence }], issues: [] }], "N1");
    expect(first).toMatchObject({ questions: { kind: "options" } });
    expect(await burst([{ kind: "other", issues: [] }], "L1")).toMatchObject({ questions: { kind: "options" } });
    const third = await burst([{ kind: "other", issues: [] }], "L1");
    expect(third).toMatchObject({ type: "ask", questions: { kind: "fulfillment" } });
  });
});

describe("E21: a voice note is read like the same words typed", () => {
  const SAID = "me manda 2 libras de arroz, lo paso a traer";
  const reading = (source: number) => ({
    observations: [
      { kind: "customer_order", lines: [wireLine("2 libras de arroz", "arroz", "2", "libra", quote(source, "2 libras de arroz"), names)], issues: [] },
      { kind: "fulfillment", mode: "pickup", place_text: null, same_as_before: false, issues: [] },
    ],
    // Seen before the call: T1 libras de arroz → P1 Arroz 1 lb.
    ...turn([op("add", "N1", "P1", "2")], "readback"),
  });

  it("takes the same one call, and gets the same reply", async () => {
    const typed = await plannerStore(STORE, { [ONE_CALL_SCHEMA_NAME]: [reading(0)] });
    await typed.say(SAID);
    const spoken = await plannerStore(STORE, { [ONE_CALL_SCHEMA_NAME]: [reading(0)] }, { transcript: SAID });
    await spoken.voice();
    expect(spoken.provider.requests.map((r) => r.schemaName)).toEqual([ONE_CALL_SCHEMA_NAME]);
    expect(spoken.provider.textOf(0)).toContain(`[0] nota de voz (transcripcion): ${JSON.stringify(SAID)}`);
    expect(spoken.last()).toBe(typed.last());
    expect(spoken.last()).toContain("• 2 Arroz 1 lb · L 36");
  });
});

describe("E11: 'me manda una' right after a product question orders that product", () => {
  it("tells the reader and the planner what the last answer was about, and offers that product", async () => {
    const t = await plannerStore(STORE, {
      [ONE_CALL_SCHEMA_NAME]: [
        {
          observations: [{ kind: "question", topic: "availability", products: ["miel de abeja don pancho"], issues: [] }],
          ...turn([], "answer_only"),
        },
        // Read as an order only when the reader was told what "una" points at, and the planner was offered it.
        (_request: unknown, text: string) =>
          text.includes("ULTIMA RESPUESTA") && text.toLowerCase().includes("miel de abeja don pancho") && text.includes('"A1"')
            ? {
                observations: [{ kind: "customer_order", lines: [wireLine("una", "miel de abeja don pancho", "1", null, quote(0, "una"), names)], issues: [] }],
                ...turn([op("add", "N1", "P1", "1")], "ask", { kind: "fulfillment", lines: [] }),
              }
            : { observations: [OTHER], ...turn([], "restate") },
      ],
    });
    await t.say("buenas, tiene miel de abeja don pancho?");
    expect(t.last()).toContain("Miel de abeja Don Pancho 500 ml: te confirmo si hay.");
    await t.say("me manda una porfa");
    expect(t.last()).toBe("Anotado ✅\n• 1 Miel de abeja Don Pancho 500 ml\n\n¿Lo recogés en la tienda o te lo llevamos?");
  });
});

// ---------------------------------------------------------------------------------------------
// Codex final pass (Nov 3). Each test failed on the code it was written against.

describe("Codex final pass, finding 3: only a choice picks an option, never a 'no' or a question", () => {
  const shown: ShownOption[] = [
    { number: 1, lineId: "l1", productId: "clover-1l", name: "Aceite Clover 1 L", price: 6000 },
    { number: 2, lineId: "l1", productId: "clover-500", name: "Aceite Clover 500 ml", price: 3400 },
    { number: 3, lineId: "l1", productId: "mazola", name: "Aceite Mazola 1 L", price: 6500 },
  ];
  const chosen = (...said: string[]) => chosenOption(said, shown)?.productId ?? null;

  it.each(["no quiero Mazola", "sin la Mazola", "la Mazola no", "no, la de 34 no"])("a 'no' picks nothing: %s", (said) => {
    expect(chosen(said)).toBeNull();
  });

  it.each(["¿cuánto trae la Mazola?", "¿la de 34 es de litro?", "la mazola es de litro?", "cuanto trae la mazola", "cuánta trae la de 34", "qué tal la mazola", "cual es la de 34", "hay mazola", "tiene la de 34", "tienen mazola"])(
    "a question picks nothing: %s",
    (said) => {
      expect(chosen(said)).toBeNull();
    },
  );

  it("a 'no' anywhere in the burst takes back a choice in another message; a question beside a choice doesn't", () => {
    expect(chosen("la mazola", "no, mejor no")).toBeNull();
    expect(chosen("la 2", "¿a qué hora cierran?")).toBe("clover-500");
  });

  it("an affirmative answer still picks", () => {
    expect(["la mazola porfa", "la 2", "esa de 34", "mazola, la de marca porfa"].map((said) => chosen(said))).toEqual(["mazola", "clover-500", "clover-500", "mazola"]);
  });

  it("a word of an option's own name isn't a 'no': 'la sin azúcar' picks it, 'no quiero la sin azúcar' doesn't", () => {
    const sodas: ShownOption[] = [
      { number: 1, lineId: "l1", productId: "coca", name: "Coca Cola 600 ml", price: 2500 },
      { number: 2, lineId: "l1", productId: "coca-zero", name: "Coca Cola sin azúcar 600 ml", price: 2600 },
    ];
    expect(chosenOption(["la sin azúcar"], sodas)?.productId).toBe("coca-zero");
    expect(chosenOption(["no quiero la sin azúcar"], sodas)).toBeNull();
  });
});

describe("Codex final pass, finding 4: 'la de 34' is read against the prices the customer saw", () => {
  it("after the store swaps two prices, 'la de 34' isn't picked by code: the list is asked again with today's prices", async () => {
    const t = await plannerStore(STORE, { [ONE_CALL_SCHEMA_NAME]: [ACIETE, { observations: [OTHER], ...turn([], "restate") }] });
    await t.say("deme un aciete y 2 jabones");
    expect(t.last()).toContain("2. Aceite Clover 500 ml · L 34");
    // The store swaps the two Clover prices before the customer answers.
    const setup = new D1StoreSetupRepository(env.DB);
    const saved = await setup.listProducts(t.tenant);
    const swap = { "Aceite Clover 1 L": 3400, "Aceite Clover 500 ml": 6000 } as Record<string, number>;
    for (const product of saved.filter((p) => swap[p.name] !== undefined)) {
      expect(await setup.updateProduct(t.tenant, product.productId, { name: product.name, otherNames: [], price: swap[product.name]! }, 5)).toBe("saved");
    }
    await t.say("la de 34");
    expect(t.last()).not.toContain("Anotado ✅\n• 1 Aceite Clover 1 L");
    expect(t.last()).toContain("Para un aciete tengo:");
    expect(t.last()).toContain("1. Aceite Clover 1 L · L 34");
  });
});
