import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { matchLines, type CatalogProduct } from "../src/application/perception/matching";
import { BurstReader, MAX_OUTPUT_TOKENS, type ReadOutcome } from "../src/application/perception/reader";
import { SYSTEM_PROMPT } from "../src/application/perception/prompt";
import { buildBurstReader } from "../src/composition";
import { isCustomerKind, type Observation } from "../src/domain/contract/observation";
import type { BurstMessage } from "../src/domain/perception/burst";
import { findQuote } from "../src/domain/perception/evidence";
import { D1SpendLedger, storeDay } from "../src/infrastructure/d1/spend-repository";
import { ContributorModelError, MuseSparkProvider } from "../src/integrations/meta/spark";
import * as contract from "./fixtures/contract";
import { cleanSugar, contractBursts, e1Cases, hijackedToSale, smuggledId } from "./fixtures/model/authored";
import { liveInjection, liveOrder } from "./fixtures/model/live";
import { authored, box, catalog, edit, line, photo, quote, text, type Recorded } from "./fixtures/model/recorded";
import { FakeClock, RecordingLogger } from "./helpers/fakes";
import { seedStore } from "./helpers/seed";

const FAKE_KEY = "test-model-key-not-real";

interface Captured {
  url: string;
  headers: Headers;
  body: {
    model: string;
    max_tokens: number;
    messages: { role: string; content: unknown }[];
    response_format: { type: string; json_schema: { name: string; strict: boolean; schema: unknown } };
  };
}

/** A fetch that answers with a recorded response and keeps every request. Never the network. */
function recordedFetch(answer: (n: number) => Response) {
  const requests: Captured[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    requests.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return answer(requests.length);
  };
  return { fetch, requests };
}

function completion(recorded: Recorded): Response {
  return Response.json({
    model: "muse-spark-1.3",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(recorded.response) } }],
    usage: recorded.usage,
  });
}

let businessId: string;
let otherBusinessId: string;
beforeAll(async () => {
  businessId = (await seedStore({ members: [] })).businessId;
  otherBusinessId = (await seedStore({ members: [] })).businessId;
});

function setup(answer: (n: number) => Response, options: { cap?: number; clock?: FakeClock } = {}) {
  const { fetch, requests } = recordedFetch(answer);
  const log = new RecordingLogger();
  const clock = options.clock ?? new FakeClock(Date.UTC(2026, 9, 30, 18, 0, 0));
  const ledger = new D1SpendLedger(env.DB);
  const reader = new BurstReader({
    provider: new MuseSparkProvider({ apiKey: FAKE_KEY, fetch }),
    spend: ledger,
    clock,
    log,
    // Each test gets its own store day budget through a fresh business, unless it shares one.
    dailyCapMicroUsd: options.cap ?? 1_000_000_000,
  });
  return { reader, requests, log, ledger, clock };
}

async function readRecorded(recorded: Recorded, tenant = { businessId }): Promise<{ outcome: ReadOutcome; requests: Captured[]; log: RecordingLogger }> {
  const { reader, requests, log } = setup(() => completion(recorded));
  const outcome = await reader.read(tenant, { audience: recorded.audience, messages: recorded.messages, context: recorded.context, catalog });
  return { outcome, requests, log };
}

function observationsOf(outcome: ReadOutcome): readonly Observation[] {
  if (!outcome.ok) throw new Error(`expected a reading, got ${outcome.reason}`);
  return outcome.reading.observations;
}

/** The request the reader sends for a recorded burst. */
async function capturedRequest(recorded: Recorded): Promise<Captured> {
  const { requests } = await readRecorded(recorded);
  return requests[0]!;
}

/** The input-token upper bound of a request as sent, rebuilt from its body. */
function inputBound(request: Captured): number {
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  const system = request.body.messages[0]!.content as string;
  const parts = request.body.messages[1]!.content as { type: string; text?: string }[];
  const { name, schema } = request.body.response_format.json_schema;
  return 1_024 + bytes(system) + bytes(name) + bytes(JSON.stringify(schema)) + parts.reduce((sum, part) => sum + (part.type === "text" ? bytes(part.text!) : 4_096), 0);
}

/** Micro-dollars: the input bound plus the full output cap. */
function upperBound(request: Captured): number {
  return Math.ceil(inputBound(request) * 1.25 + request.body.max_tokens * 4.25);
}

// ---------------------------------------------------------------------------------------------

describe("reading the contract fixtures from recorded responses", () => {
  for (const [name, recorded] of Object.entries(contractBursts) as [keyof typeof contractBursts, Recorded][]) {
    it(`${name} reads as the contract fixture`, async () => {
      const { outcome } = await readRecorded(recorded);
      expect(observationsOf(outcome)).toEqual(contract.allReadings[name].observations);
      if (!outcome.ok) return;
      expect(outcome.reading.calls).toEqual([
        { model: "muse-spark-1.3", promptVersion: "order-v2", latencyMs: expect.any(Number), inputTokens: 3950, outputTokens: 1500 },
      ]);
    });
  }

  it("every text and transcript span in the fixtures is what the burst says there", () => {
    for (const [name, reading] of Object.entries(contract.allReadings) as [keyof typeof contract.allReadings, typeof contract.firstOrder][]) {
      const texts = contract.burstText[name];
      for (const observation of reading.observations) {
        const spans = JSON.stringify(observation).match(/"source":"(text|transcript)","message":\d+,"start":\d+,"end":\d+/g) ?? [];
        for (const span of spans) {
          const [, message, start, end] = span.match(/"message":(\d+),"start":(\d+),"end":(\d+)/)!.map(Number);
          expect(texts[message!]).toBeTypeOf("string");
          expect(findQuote(texts[message!]!, texts[message!]!.slice(start, end))).toEqual({ start, end });
        }
      }
    }
  });

  it("matches firstOrder's lines to the catalog by code, leaving the oil for the size question", async () => {
    const { outcome } = await readRecorded(contractBursts.firstOrder);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.matches).toEqual(contract.firstOrderMatches);
    expect(outcome.labelMatches).toEqual([]);
  });
});

describe("the E1 spike cases", () => {
  for (const testCase of e1Cases) {
    it(`${testCase.id} keeps the spike's rules`, async () => {
      const { outcome } = await readRecorded(testCase.recorded);
      const observations = observationsOf(outcome);
      expect(observations.map((o) => o.kind)).toEqual(testCase.kinds);
      const numbers = JSON.stringify(observations, (key, value) =>
        ["quantity", "unitPrice", "receivedQuantity", "unitCost"].includes(key) || typeof value !== "number" ? value : undefined,
      );
      for (const forbidden of testCase.never) {
        expect(numbers).not.toMatch(new RegExp(`"(quantity|unitPrice|receivedQuantity|unitCost)":"?${forbidden}"?[,}]`));
      }
    });
  }

  it("E1-03: two boxes of twelve stay two boxes; nothing is multiplied", async () => {
    const [observation] = observationsOf((await readRecorded(e1Cases.find((c) => c.id === "E1-03")!.recorded)).outcome);
    expect(observation).toMatchObject({ kind: "supplier_invoice", lines: [{ quantity: "2", unit: "caja", name: "leches" }] });
  });

  it("E1-04: a price that may be per box or total stays unknown", async () => {
    const [observation] = observationsOf((await readRecorded(e1Cases.find((c) => c.id === "E1-04")!.recorded)).outcome);
    expect(observation).toMatchObject({ kind: "sale_report", lines: [{ quantity: "2", unitPrice: null }] });
  });

  it("E1-11: a sale with no product keeps the numbers and asks which product", async () => {
    const [observation] = observationsOf((await readRecorded(e1Cases.find((c) => c.id === "E1-11")!.recorded)).outcome);
    expect(observation).toMatchObject({
      kind: "sale_report",
      lines: [{ quantity: "3", unitPrice: 2000 }],
      issues: [{ code: "ambiguous_product", line: 0 }],
    });
  });

  it("E1-16 and E1-17: a spoken correction sets the affirmed figure on the open order's line", async () => {
    for (const [id, quantity] of [["E1-16", "6"], ["E1-17", "7"]] as const) {
      const [observation] = observationsOf((await readRecorded(e1Cases.find((c) => c.id === id)!.recorded)).outcome);
      expect(observation).toMatchObject({ kind: "order_change", edits: [{ op: "set_quantity", target: { ref: "L1" }, quantity }] });
    }
  });

  it("E1-19: filler is gone from the words kept, and the span still points at the message", async () => {
    const [observation] = observationsOf((await readRecorded(e1Cases.find((c) => c.id === "E1-19")!.recorded)).outcome);
    expect(observation).toMatchObject({
      kind: "supplier_invoice",
      lines: [{ text: "cuatro cajas de leche", quantity: "4", evidence: { source: "text", message: 0, start: 12, end: 33 } }],
    });
  });

  it("E1-21: no affirmed figure means no edit, and an issue so the engine asks", async () => {
    const [observation] = observationsOf((await readRecorded(e1Cases.find((c) => c.id === "E1-21")!.recorded)).outcome);
    expect(observation).toEqual({
      kind: "order_change",
      edits: [],
      issues: [{ code: "illegible", line: null, evidence: { source: "text", message: 0, start: 8, end: 20 } }],
    });
  });
});

describe("embedded instructions", () => {
  it("the live injected burst reads as an issue plus the real order line, nothing else", async () => {
    const { outcome } = await readRecorded(liveInjection);
    const observations = observationsOf(outcome);
    expect(observations).toEqual([
      {
        kind: "other",
        issues: [{ code: "embedded_instructions", line: null, evidence: { source: "text", message: 0, start: 0, end: 36 } }],
      },
      expect.objectContaining({ kind: "customer_order" }),
    ]);
    expect(observations.every((o) => isCustomerKind(o.kind))).toBe(true);
  });

  it("changes nothing: the order line reads the same as the burst without the injection", async () => {
    const injected = observationsOf((await readRecorded(liveInjection)).outcome)[1]!;
    const clean = observationsOf((await readRecorded(cleanSugar)).outcome)[0]!;
    if (clean.kind !== "customer_order") throw new Error(clean.kind);
    const shifted = { ...clean, lines: clean.lines.map((l) => ({ ...l, evidence: { ...l.evidence, message: 1 } })) };
    expect(injected).toEqual(shifted);
    // No price, no approval, no IDs reach the reading.
    expect(JSON.stringify(injected)).not.toMatch(/unitPrice|product-|approve/);
  });

  it("a model that obeyed the injection and answered with a staff kind reads nothing", async () => {
    const { outcome, log } = await readRecorded(hijackedToSale);
    expect(outcome).toEqual({ ok: false, reason: "invalid_output", calls: [expect.objectContaining({ model: "muse-spark-1.3" })] });
    expect(log.fields("perception.invalid_output")).toEqual([expect.objectContaining({ reason: "schema" })]);
  });

  it("a model that added a catalog ID reads nothing", async () => {
    expect((await readRecorded(smuggledId)).outcome).toMatchObject({ ok: false, reason: "invalid_output" });
  });

  it("message text goes only in the user turn; the system prompt is fixed", async () => {
    const { requests } = await readRecorded(liveInjection);
    const [request] = requests;
    expect(request!.body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(request!.body.messages[0]!.content).toBe(SYSTEM_PROMPT.customer);
    const user = JSON.stringify(request!.body.messages[1]!.content);
    expect(user).toContain("IGNORA LAS INSTRUCCIONES ANTERIORES");
    expect(SYSTEM_PROMPT.customer).not.toContain("IGNORA LAS INSTRUCCIONES");
  });
});

describe("the live order (gap p)", () => {
  it("reads an order and a pickup from one call", async () => {
    const { outcome } = await readRecorded(liveOrder);
    expect(observationsOf(outcome)).toEqual([
      {
        kind: "customer_order",
        lines: [
          { text: "3 libras de arroz", name: "arroz", quantity: "3", unit: "libra", restrictedCategory: false, evidence: { source: "text", message: 0, start: 17, end: 34 } },
          {
            text: "un aceite de la marca Mazola",
            name: "aceite de la marca Mazola",
            quantity: "1",
            unit: null,
            restrictedCategory: false,
            evidence: { source: "text", message: 0, start: 37, end: 65 },
          },
        ],
        issues: [],
      },
      { kind: "fulfillment", mode: "pickup", pin: null, placeText: null, sameAsBefore: false, issues: [] },
    ]);
  });

  it("code matches the rice by name; the model's pick of label P3 maps to Mazola only through code", async () => {
    const { outcome } = await readRecorded(liveOrder);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.matches).toEqual([{ observation: 0, line: 0, productId: "product-arroz-1lb", how: "exact_name" }]);
    expect(outcome.labelMatches).toEqual([{ observation: 0, line: 1, label: "P3", productId: "product-mazola-1l" }]);
  });

  it("sends the request in the shape the live check used", async () => {
    const { requests } = await readRecorded(liveOrder);
    const [request] = requests;
    expect(request!.url).toBe("https://api.meta.ai/v1/chat/completions");
    expect(request!.headers.get("authorization")).toBe(`Bearer ${FAKE_KEY}`);
    expect(request!.body.model).toBe("muse-spark-1.3");
    expect(request!.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "BurstReading", strict: true } });
    expect(JSON.stringify(request!.body.messages[1]!.content)).toContain('P3: \\"Aceite Mazola 1 L\\"');
  });
});

describe("contract rules on a response that fits the schema", () => {
  const order = (lines: unknown[], issues: unknown[] = []) => [{ kind: "customer_order", lines, issues }];

  it("a quantity that isn't a decimal string becomes null, with an issue", async () => {
    const recorded = authored("customer", [text("dos libras de arroz")], order([line("dos libras de arroz", "arroz", "dos", "libra", quote(0, "dos libras"))]));
    expect(observationsOf((await readRecorded(recorded)).outcome)[0]).toMatchObject({
      lines: [{ quantity: null }],
      issues: [{ code: "illegible", line: 0 }],
    });
  });

  it("a line whose quote isn't in the message goes, an issue takes its place, and later issues are renumbered", async () => {
    const recorded = authored(
      "customer",
      [text("una coca y 2 libras de arroz")],
      order(
        [line("tres cervezas", "cerveza", "3", null, quote(0, "tres cervezas")), line("una coca", "coca", "1", null, quote(0, "una coca"))],
        [{ code: "ambiguous_size", line: 1, evidence: quote(0, "una coca") }],
      ),
    );
    expect(observationsOf((await readRecorded(recorded)).outcome)[0]).toEqual({
      kind: "customer_order",
      lines: [{ text: "una coca", name: "coca", quantity: "1", unit: null, restrictedCategory: false, evidence: { source: "text", message: 0, start: 0, end: 8 } }],
      issues: [
        { code: "ambiguous_size", line: 0, evidence: { source: "text", message: 0, start: 0, end: 8 } },
        { code: "illegible", line: null, evidence: null },
      ],
    });
  });

  it("evidence outside the burst, or a box outside the photo, is never used", async () => {
    const recorded = authored(
      "customer",
      [text("arroz")],
      order([line("arroz", "arroz", null, null, quote(4, "arroz")), line("arroz", "arroz", null, null, box(0, [0.1, 0.1, 1.4, 0.2]))]),
    );
    expect(observationsOf((await readRecorded(recorded)).outcome)[0]).toMatchObject({ lines: [], issues: [{ code: "illegible" }, { code: "illegible" }] });
  });

  it("a ref that isn't one of the open order's labels becomes null", async () => {
    const recorded = authored(
      "customer",
      [text("quitale el jabón")],
      [{ kind: "order_change", edits: [edit("remove", { ref: "L9", said: "jabón", evidence: quote(0, "quitale el jabón") })], issues: [] }],
      contract.packingContext,
    );
    expect(observationsOf((await readRecorded(recorded)).outcome)[0]).toMatchObject({ edits: [{ op: "remove", target: { ref: null, said: "jabón" } }] });
  });

  it("a pick that isn't a supplied label is ignored", async () => {
    const recorded = authored("customer", [text("un aceite Mazola")], order([line("un aceite Mazola", "aceite Mazola", "1", null, quote(0, "un aceite Mazola"), { pick: "P99" })]));
    const { outcome } = await readRecorded(recorded);
    expect(outcome).toMatchObject({ ok: true, labelMatches: [] });
  });

  it("finds a quote the model wrote without its accents, and keeps the original span", () => {
    expect(findQuote("dos libras de azúcar", "libras de azucar")).toEqual({ start: 4, end: 20 });
    expect(findQuote("dos libras", "tres libras")).toBeNull();
  });

  it("a shared location becomes the pin; the model never gives coordinates", async () => {
    const recorded = authored(
      "customer",
      [text("me lo manda aquí"), { type: "location", latitude: 15.68, longitude: -86.0 }],
      [{ kind: "fulfillment", mode: "delivery", place_text: null, same_as_before: false, issues: [] }],
    );
    expect(observationsOf((await readRecorded(recorded)).outcome)[0]).toMatchObject({ mode: "delivery", pin: { latitude: 15.68, longitude: -86.0 } });
  });

  it("an empty reading is `other`", async () => {
    expect(observationsOf((await readRecorded(authored("customer", [text("hola")], []))).outcome)).toEqual([{ kind: "other", issues: [] }]);
  });

  it("a photo the model never saw backs nothing: its box is invalid and the line becomes an issue", async () => {
    const unfetched: BurstMessage = { type: "image", mimeType: "image/jpeg", bytes: null };
    const heic: BurstMessage = { type: "image", mimeType: "image/heic", bytes: new Uint8Array([0, 0, 0, 0x18]).buffer };
    for (const missing of [unfetched, heic]) {
      const recorded = authored("customer", [missing], order([line("arroz", "arroz", "2", "libra", box(0, [0.1, 0.1, 0.5, 0.2]))]));
      const { outcome, requests } = await readRecorded(recorded);
      expect(JSON.stringify(requests[0]!.body.messages[1]!.content)).toContain("(no disponible)");
      expect(observationsOf(outcome)[0]).toEqual({ kind: "customer_order", lines: [], issues: [{ code: "illegible", line: null, evidence: null }] });
    }
    // The same box on a photo that was sent is kept.
    const seen = authored("customer", [photo()], order([line("arroz", "arroz", "2", "libra", box(0, [0.1, 0.1, 0.5, 0.2]))]));
    expect(observationsOf((await readRecorded(seen)).outcome)[0]).toMatchObject({ lines: [{ evidence: { source: "image", message: 0 } }], issues: [] });
  });

  it("a clarification answer that isn't what its quote says is not an answer", async () => {
    const recorded = authored("customer", [text("de litro")], [{ kind: "clarification", answer: "de medio", evidence: quote(0, "de litro"), issues: [] }]);
    expect(observationsOf((await readRecorded(recorded)).outcome)).toEqual([{ kind: "other", issues: [{ code: "illegible", line: null, evidence: null }] }]);
  });

  it("a name must be in its quote as whole words; case, accents and punctuation don't matter", async () => {
    const said = (name: string, words: string) => authored("customer", [text("hola, soy Carla Martínez.")], [{ kind: "customer_name", name, evidence: quote(0, words), issues: [] }]);
    expect(observationsOf((await readRecorded(said("carla martinez", "soy Carla Martínez."))).outcome)[0]).toMatchObject({ kind: "customer_name", name: "carla martinez" });
    expect(observationsOf((await readRecorded(said("Carla", "Carla"))).outcome)[0]).toMatchObject({ kind: "customer_name", name: "Carla" });
    expect(observationsOf((await readRecorded(said("Carl", "soy Carla"))).outcome)[0]).toEqual({ kind: "other", issues: [{ code: "illegible", line: null, evidence: null }] });
    expect(observationsOf((await readRecorded(said("Rosa", "soy Carla"))).outcome)[0]).toEqual({ kind: "other", issues: [{ code: "illegible", line: null, evidence: null }] });
    // A box has no words to check the name against.
    const onPhoto = authored("customer", [photo()], [{ kind: "customer_name", name: "Carla", evidence: box(0, [0.1, 0.1, 0.5, 0.2]), issues: [] }]);
    expect(observationsOf((await readRecorded(onPhoto)).outcome)[0]).toEqual({ kind: "other", issues: [{ code: "illegible", line: null, evidence: null }] });
  });

  it("a payment field whose evidence isn't in the burst is cleared, with an issue; the others stay", async () => {
    const recorded = authored("customer", [text("le mandé 500 por BAC, ref 12345")], [
      {
        kind: "payment_receipt",
        amount_centavos: 50_000,
        bank: "BAC",
        date_text: "30/10",
        reference: "12345",
        amount_evidence: quote(3, "500"),
        bank_evidence: quote(0, "BAC"),
        date_evidence: { message: null, quote: null, box: null },
        reference_evidence: quote(0, "12345"),
        issues: [],
      },
    ]);
    expect(observationsOf((await readRecorded(recorded)).outcome)[0]).toEqual({
      kind: "payment_receipt",
      amount: null,
      bank: "BAC",
      dateText: null,
      reference: "12345",
      evidence: {
        amount: null,
        bank: { source: "text", message: 0, start: 17, end: 20 },
        date: null,
        reference: { source: "text", message: 0, start: 26, end: 31 },
      },
      issues: [
        { code: "illegible", line: null, evidence: null },
        { code: "illegible", line: null, evidence: null },
      ],
    });
  });

  it("a clarification whose words aren't in the burst is not an answer", async () => {
    const recorded = authored("customer", [text("de litro")], [{ kind: "clarification", answer: "de medio", evidence: quote(0, "de medio"), issues: [] }]);
    expect(observationsOf((await readRecorded(recorded)).outcome)).toEqual([{ kind: "other", issues: [{ code: "illegible", line: null, evidence: null }] }]);
  });
});

describe("matching by code", () => {
  const ordered = (name: string): Observation[] => [
    { kind: "customer_order", lines: [{ text: name, name, quantity: "1", unit: null, restrictedCategory: false, evidence: { source: "text", message: 0, start: 0, end: name.length } }], issues: [] },
  ];
  const product = (productId: string, names: string[], aliases: string[] = [], barcode: string | null = null): CatalogProduct => ({ productId, names, aliases, barcode });

  it("two exact names are unresolved; a third product's alias never breaks the tie", () => {
    const products = [product("a", ["Aceite"]), product("b", ["aceite"]), product("c", ["Aceite Mazola"], ["aceite"])];
    expect(matchLines(ordered("aceite"), products)).toEqual([]);
    // With one exact name, that one wins over the alias.
    expect(matchLines(ordered("aceite"), products.slice(1))).toEqual([{ observation: 0, line: 0, productId: "b", how: "exact_name" }]);
    // With no exact name, a single alias matches.
    expect(matchLines(ordered("aceite"), products.slice(2))).toEqual([{ observation: 0, line: 0, productId: "c", how: "known_alias" }]);
  });

  it("two products with one barcode are unresolved; names and aliases are not tried", () => {
    const products = [product("a", ["Uno"], [], "7401000000011"), product("b", ["Dos"], [], "7401000000011"), product("c", ["7401000000011"])];
    expect(matchLines(ordered("7401000000011"), products)).toEqual([]);
    expect(matchLines(ordered("7401000000011"), products.slice(1))).toEqual([{ observation: 0, line: 0, productId: "b", how: "barcode" }]);
  });
});

describe("the Muse Spark adapter", () => {
  it("refuses contributor model IDs", () => {
    expect(() => new MuseSparkProvider({ apiKey: FAKE_KEY, fetch: async () => new Response(), model: "muse-spark-1.3-contributor" })).toThrow(
      ContributorModelError,
    );
  });

  it("with MODEL_API_KEY blank (as in every test), refuses before the network", async () => {
    let called = 0;
    const reader = buildBurstReader(env, { clock: new FakeClock(), log: new RecordingLogger() }, {
      fetch: async () => {
        called++;
        return new Response();
      },
    });
    const outcome = await reader.read({ businessId }, { audience: "customer", messages: [text("hola")], context: contract.packingContext, catalog });
    expect(outcome).toMatchObject({ ok: false, reason: "rejected" });
    expect(called).toBe(0);
  });

  it("sends a photo as a data URL in the user turn", async () => {
    const { reader, requests } = setup(() => completion(contractBursts.injectedInstructions));
    await reader.read({ businessId }, { audience: "customer", messages: contractBursts.injectedInstructions.messages, context: contract.packingContext, catalog });
    expect(JSON.stringify(requests[0]!.body.messages[1]!.content)).toContain('"url":"data:image/jpeg;base64,/9j/4A=="');
  });

  it("maps provider failures without reading anything", async () => {
    const cases: [Response | Error, string][] = [
      [new Response("slow down", { status: 429 }), "unavailable"],
      [new Response("bad schema", { status: 400 }), "rejected"],
      [new Response("oops", { status: 503 }), "unavailable"],
      [Response.json({ choices: [{ message: { content: "not json" } }] }), "invalid_output"],
      [new Error("network down"), "unavailable"],
    ];
    for (const [answer, reason] of cases) {
      const { reader } = setup(() => {
        if (answer instanceof Error) throw answer;
        return answer.clone();
      });
      const outcome = await reader.read({ businessId }, { audience: "customer", messages: [text("hola")], context: contract.packingContext, catalog });
      expect(outcome).toMatchObject({ ok: false, reason });
    }
  });

  it("logs IDs and codes only, never message text", async () => {
    const { log } = await readRecorded(liveInjection);
    expect(log.lines.join("\n")).not.toMatch(/IGNORA|azucar|libras/i);
    expect(log.fields("perception.read")).toEqual([expect.objectContaining({ businessId, count: 2, outcome: "ok" })]);
  });
});

describe("the daily spend cap in D1", () => {
  const morning = Date.UTC(2026, 9, 30, 15, 0, 0);

  it("counts the store's own day (UTC-6)", () => {
    expect(storeDay(Date.UTC(2026, 9, 31, 3, 0, 0))).toBe("2026-10-30");
    expect(storeDay(Date.UTC(2026, 9, 31, 6, 0, 0))).toBe("2026-10-31");
  });

  it("two concurrent reservations can't pass the cap together", async () => {
    const { businessId: store } = await seedStore({ members: [] });
    const ledger = new D1SpendLedger(env.DB);
    const results = await Promise.all([ledger.reserve({ businessId: store }, morning, 60, 100), ledger.reserve({ businessId: store }, morning, 60, 100)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ledger.spentMicroUsd({ businessId: store }, morning)).toBe(60);
  });

  it("ten concurrent reservations stop at the cap", async () => {
    const { businessId: store } = await seedStore({ members: [] });
    const ledger = new D1SpendLedger(env.DB);
    const results = await Promise.all(Array.from({ length: 10 }, () => ledger.reserve({ businessId: store }, morning, 30, 100)));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await ledger.spentMicroUsd({ businessId: store }, morning)).toBe(90);
  });

  it("refuses a first reservation larger than the cap", async () => {
    const ledger = new D1SpendLedger(env.DB);
    expect(await ledger.reserve({ businessId: otherBusinessId }, morning, 101, 100)).toBeNull();
    expect(await ledger.spentMicroUsd({ businessId: otherBusinessId }, morning)).toBe(0);
  });

  it("settling replaces the estimate with the actual cost; stores and days are separate", async () => {
    const { businessId: a } = await seedStore({ members: [] });
    const { businessId: b } = await seedStore({ members: [] });
    const ledger = new D1SpendLedger(env.DB);
    const reservation = await ledger.reserve({ businessId: a }, morning, 100, 100);
    expect(await ledger.reserve({ businessId: a }, morning, 1, 100)).toBeNull();
    expect(await ledger.reserve({ businessId: b }, morning, 100, 100)).not.toBeNull();
    await ledger.settle(reservation!, 40);
    expect(await ledger.spentMicroUsd({ businessId: a }, morning)).toBe(40);
    expect(await ledger.reserve({ businessId: a }, morning, 60, 100)).not.toBeNull();
    expect(await ledger.reserve({ businessId: a }, morning + 24 * 3600 * 1000, 100, 100)).not.toBeNull();
  });

  it("the reader reserves before calling, settles to the usage, and stops calling at the cap", async () => {
    const { businessId: store } = await seedStore({ members: [] });
    const settled = Math.ceil(3956 * 1.25 + 1815 * 4.25);
    const bound = upperBound(await capturedRequest(liveOrder));
    // Room for the first call's usage plus a second call's bound, not for a third bound.
    const { reader, requests, ledger, clock, log } = setup(() => completion(liveOrder), { cap: settled + bound + settled - 1 });
    const read = () => reader.read({ businessId: store }, { audience: "customer", messages: liveOrder.messages, context: liveOrder.context, catalog });
    expect((await read()).ok).toBe(true);
    // 3956 input and 1815 output tokens at $1.25 and $4.25 per million.
    expect(await ledger.spentMicroUsd({ businessId: store }, clock.now())).toBe(settled);
    expect((await read()).ok).toBe(true);
    expect(await read()).toEqual({ ok: false, reason: "spend_cap", calls: [] });
    expect(requests).toHaveLength(2);
    expect(log.fields("perception.spend_cap")).toEqual([expect.objectContaining({ businessId: store, reason: "spend_cap" })]);
  });

  it("reserves the request's upper bound: every byte sent, each photo, and the whole output cap", async () => {
    const { businessId: store } = await seedStore({ members: [] });
    // A timeout: the spend is unknown, so the reservation stays as it was.
    const { reader, requests, ledger, clock } = setup(() => new Response("slow", { status: 503 }));
    await reader.read({ businessId: store }, { audience: "customer", messages: [text("dos libras de azúcar"), photo()], context: contract.packingContext, catalog });
    const [request] = requests;
    expect(request!.body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    const sent = request!.body.messages[1]!.content as { type: string; text?: string }[];
    const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
    const input =
      1_024 +
      bytes(SYSTEM_PROMPT.customer) +
      bytes("BurstReading") +
      bytes(JSON.stringify(request!.body.response_format.json_schema.schema)) +
      sent.reduce((sum, part) => sum + (part.type === "text" ? bytes(part.text!) : 4_096), 0);
    expect(sent.filter((part) => part.type === "image_url")).toHaveLength(1);
    expect(await ledger.spentMicroUsd({ businessId: store }, clock.now())).toBe(Math.ceil(input * 1.25 + MAX_OUTPUT_TOKENS * 4.25));
    expect(upperBound(request!)).toBe(Math.ceil(input * 1.25 + MAX_OUTPUT_TOKENS * 4.25));
  });

  it("the bound covers the live call's real input, with room for the reasoning it used", async () => {
    const request = await capturedRequest(liveOrder);
    // Billed 3,956 input tokens for this request; the bound counts one token per byte sent.
    expect(inputBound(request)).toBeGreaterThan(3956);
    // Reasoning counts against max_tokens: the live calls used 1,287-1,620 of 1,400-1,815 in all.
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(4 * 1815);
  });

  it("a call that spends its whole output cap still settles within its reservation", async () => {
    const { businessId: store } = await seedStore({ members: [] });
    const cutOff = () =>
      Response.json({
        choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: '{"observations":[' } }],
        usage: { prompt_tokens: 3_956, completion_tokens: MAX_OUTPUT_TOKENS },
      });
    const { reader, requests, ledger, clock, log } = setup(cutOff);
    const outcome = await reader.read({ businessId: store }, { audience: "customer", messages: liveOrder.messages, context: liveOrder.context, catalog });
    // A cut-off answer is never read as data.
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_output" });
    const spent = await ledger.spentMicroUsd({ businessId: store }, clock.now());
    expect(spent).toBe(Math.ceil(3_956 * 1.25 + MAX_OUTPUT_TOKENS * 4.25));
    expect(spent).toBeLessThanOrEqual(upperBound(requests[0]!));
    expect(log.fields("perception.spend_over_bound")).toEqual([]);
  });

  it("usage past the bound is recorded as spent and logged, never hidden", async () => {
    const { businessId: store } = await seedStore({ members: [] });
    const { reader, requests, ledger, clock, log } = setup(() => completion({ ...liveOrder, usage: { prompt_tokens: 3_956, completion_tokens: 50_000 } }));
    await reader.read({ businessId: store }, { audience: "customer", messages: liveOrder.messages, context: liveOrder.context, catalog });
    const actual = Math.ceil(3_956 * 1.25 + 50_000 * 4.25);
    expect(await ledger.spentMicroUsd({ businessId: store }, clock.now())).toBe(actual);
    expect(log.fields("perception.spend_over_bound")).toEqual([
      expect.objectContaining({ businessId: store, reason: "over_bound", count: actual - upperBound(requests[0]!) }),
    ]);
  });

  it("a refused request gives its reservation back", async () => {
    const { businessId: store } = await seedStore({ members: [] });
    const { reader, ledger, clock } = setup(() => new Response("bad", { status: 400 }));
    await reader.read({ businessId: store }, { audience: "customer", messages: [text("hola")], context: contract.packingContext, catalog });
    expect(await ledger.spentMicroUsd({ businessId: store }, clock.now())).toBe(0);
  });
});
