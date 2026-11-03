/**
 * The one-call text path (PLANNER_FAST_TEXT): a burst of text only is read and planned in one
 * strict call, checked by the same validators as the two-call path, after code retrieved products
 * from the customer's own words. Recorded model answers, no network.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PLANNER_MODE_PROMPT } from "../src/application/perception/prompt";
import { ONE_CALL_LAYER, plannerInstructions } from "../src/application/planner/instructions";
import { ONE_CALL_SCHEMA_NAME, oneCallPrompt, relabeled, textPieces } from "../src/application/planner/one-call";
import type { ModelProvider, ModelRequest } from "../src/application/ports";
import type { CandidateTable, TurnProposal } from "../src/domain/planner/types";
import { readConfig } from "../src/infrastructure/config";
import { D1StoreSetupRepository } from "../src/infrastructure/d1/store-setup-repository";
import { D1PretendEngine } from "../src/infrastructure/memory/d1-pretend-engine";
import { line as wireLine, quote } from "./fixtures/model/recorded";
import { harness, rows, testEnv } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

describe("the one call's pieces", () => {
  it("looks up the customer's own words, numbers and number words left out", () => {
    const pieces = textPieces([{ type: "text", text: "buenas, me manda platanos, una piña, salsa de tomate y 2 libras de arroz. lo paso a traer" }]);
    expect(pieces.map((p) => [p.label, p.said])).toEqual([
      ["T1", "buenas"],
      ["T2", "me manda platanos"],
      ["T3", "pina"],
      ["T4", "salsa de tomate"],
      ["T5", "libras de arroz"],
      ["T6", "lo paso a traer"],
    ]);
    expect(textPieces([{ type: "text", text: "2, y 3" }])).toEqual([]);
  });

  it("keeps a pick only where the item line's own words find that product too", () => {
    const candidate = (label: string, productId: string) => ({ label, productId, name: productId, soldBy: null, usualQuantity: null, hasPrice: true, availability: "no_se" as const, restricted: false, how: "all_words" as const });
    const seen: CandidateTable = { candidates: [candidate("P1", "salsa"), candidate("P2", "tomate")], offered: new Map([["T4", ["P1", "P2"]]]), howByLine: new Map() };
    const lines: CandidateTable = { candidates: [candidate("P1", "tomate"), candidate("P2", "salsa")], offered: new Map([["N1", ["P2"]], ["N2", ["P1"]]]), howByLine: new Map() };
    const op = (line: string, product: string) => ({ op: "add" as const, line, product, quantity: null, suggested_quantity: null });
    const proposal: TurnProposal = { ops: [op("N1", "P1"), op("N2", "P1")], move: "readback", ask: { kind: "none", lines: [] }, say: "" };
    expect(relabeled(proposal, seen, lines).ops.map((o) => o.product)).toEqual(["P2", "P1-not-offered"]);
  });

  it("is prompted by the planner's layers, the one-call bridge and the reader's rules, cached under all three", () => {
    const prompt = oneCallPrompt();
    expect(prompt.system.startsWith(plannerInstructions().system)).toBe(true);
    expect(prompt.system).toContain(ONE_CALL_LAYER.text.trim());
    expect(prompt.system.endsWith(PLANNER_MODE_PROMPT.text)).toBe(true);
    expect(prompt.version).toBe(`one-call:${plannerInstructions().version}+${ONE_CALL_LAYER.version}+reader:${PLANNER_MODE_PROMPT.version}`);
  });

  it("is on only on the planner path, as PLANNER_FAST_TEXT says", () => {
    const config = (vars: Record<string, string>) => readConfig(testEnv(vars as unknown as Partial<Env>));
    expect(config({ CONVERSATION: "planner", PLANNER_FAST_TEXT: "1" }).fastText).toBe(true);
    expect(config({ CONVERSATION: "planner", PLANNER_FAST_TEXT: "0" }).fastText).toBe(false);
    expect(config({ CONVERSATION: "classic", PLANNER_FAST_TEXT: "1" }).fastText).toBe(false);
    // On by default in planner mode, at "minimal" (D-52); either can be set.
    expect(config({ CONVERSATION: "planner" }).fastText).toBe(true);
    expect(config({ CONVERSATION: "planner" }).fastTextModel).toEqual({ reasoningEffort: "minimal" });
    expect(config({ CONVERSATION: "planner", FAST_TEXT_REASONING_EFFORT: "low" }).fastTextModel).toEqual({ reasoningEffort: "low" });
  });
});

// ---------------------------------------------------------------------------------------------

const STORE = [
  { name: "Arroz 1 lb", price: 1800, soldBy: "unit" as const },
  { name: "Salsa de tomate Naturas 400 g", price: 2800 },
  { name: "Tomate", price: 500 },
  { name: "Pollo entero", price: 4500, soldBy: "weight" as const },
];

/** Answers each call by its schema: one-call answers, readings, plans, in order. Never the network. */
class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  constructor(private readonly answers: Record<string, unknown[]>) {}
  async complete(request: ModelRequest) {
    this.requests.push(request);
    const json = (this.answers[request.schemaName] ?? []).shift();
    if (json === undefined) throw new Error(`no recorded ${request.schemaName} left`);
    return { ok: true, json, latencyMs: 3_000, inputTokens: 4_000, outputTokens: 700 } as const;
  }
  textOf(n: number): string {
    return this.requests[n]!.user.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  }
}

async function textTrip(answers: Record<string, unknown[]>) {
  const store = await seedStore({ members: [] });
  const tenant = { businessId: store.businessId };
  const phone = newPhone();
  await env.DB.prepare(`INSERT INTO customers (id, business_id, phone, created_at_ms, introduced_at_ms, name_asked_at_ms) VALUES (?, ?, ?, 0, 1, 1)`)
    .bind(crypto.randomUUID(), store.businessId, phone)
    .run();
  const setup = new D1StoreSetupRepository(env.DB);
  for (const p of STORE) await setup.addProduct(tenant, { name: p.name, otherNames: [], price: p.price }, 1);
  const products = await setup.listProducts(tenant);
  for (const p of STORE.filter((s) => s.soldBy !== undefined)) {
    const saved = products.find((s) => s.name === p.name)!;
    await setup.updateProduct(tenant, saved.productId, { name: saved.name, otherNames: [], price: saved.price }, 2, { soldBy: p.soldBy!, usualQuantity: null });
  }
  const provider = new RecordedProvider(answers);
  const h = harness({
    engine: new D1PretendEngine(env.DB, { setup }),
    modelProvider: provider,
    env: testEnv({ CONVERSATION: "planner", PLANNER_FAST_TEXT: "1" } as unknown as Partial<Env>),
  });
  const say = async (body: string) => {
    h.clock.advance(1_000);
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body })] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
  };
  return { h, store, phone, provider, say, productIds: products.map((p) => p.productId) };
}

const ORDER_TEXT = "buenas, me manda platanos, una piña, salsa de tomate y 2 libras de arroz. lo paso a traer";
const op = (kind: string, line: string, product: string | null = null, quantity: string | null = null, suggested: string | null = null) => ({
  op: kind,
  line,
  product,
  quantity,
  suggested_quantity: suggested,
});
const names = (otherNames: string[] = []) => ({ other_names: otherNames });
const pickup = { kind: "fulfillment", mode: "pickup", place_text: null, same_as_before: false, issues: [] };

describe("a text-only burst on the planner path, in one call", () => {
  it("reads and plans the order in one call, checked as on the two-call path", async () => {
    // Seen before the call: T4 salsa de tomate → P1 Salsa (all words), P2 Tomate (some words); T5 libras de arroz → P3 Arroz.
    const t = await textTrip({
      [ONE_CALL_SCHEMA_NAME]: [
        {
          observations: [
            {
              kind: "customer_order",
              lines: [
                wireLine("platanos", "platanos", null, null, quote(0, "platanos"), names()),
                wireLine("una piña", "piña", "1", null, quote(0, "una piña"), names()),
                wireLine("salsa de tomate", "salsa de tomate", null, null, quote(0, "salsa de tomate"), names(["ketchup"])),
                wireLine("2 libras de arroz", "arroz", "2", "libra", quote(0, "2 libras de arroz"), names()),
              ],
              issues: [],
            },
            pickup,
          ],
          ops: [op("add", "N1"), op("add", "N2", null, "1"), op("add", "N3", "P1", null, "1"), op("add", "N4", "P3", "2")],
          move: "ask",
          ask: { kind: "quantities", lines: ["N1", "N3"] },
          say: "Ya vi tu lista 👍",
        },
      ],
    });
    await t.say(ORDER_TEXT);

    expect(t.provider.requests.map((r) => r.schemaName)).toEqual([ONE_CALL_SCHEMA_NAME]);
    expect(t.provider.requests[0]!.system).toBe(oneCallPrompt().system);
    for (const secret of [...t.productIds, "1800", "2800"]) expect(t.provider.textOf(0)).not.toContain(secret);
    // The salsa had two products to choose from and the customer named neither: no suggested 1,
    // so it's asked with the platanos. "Ya vi tu lista" says nothing: there was no photo.
    expect(t.h.sentTo(t.phone)).toEqual([
      [
        "Anotado ✅",
        "• 1 Piña",
        "• 2 Arroz 1 lb",
        "",
        "¿Cuántos querés de estos?",
        "• Platanos",
        "• Salsa de tomate Naturas 400 g",
        "Escribime todo junto, por ejemplo: «2 platanos, 1 salsa de tomate naturas 400 g».",
      ].join("\n"),
    ]);
    expect(t.h.log.fields("planner.planned")).toEqual([expect.objectContaining({ outcome: "ask", reason: "quantities" })]);
  });

  it("asks the planner again when the reader's other names find a product the customer's words didn't ('catsup')", async () => {
    const t = await textTrip({
      [ONE_CALL_SCHEMA_NAME]: [
        {
          observations: [
            {
              kind: "customer_order",
              lines: [
                wireLine("un catsup", "catsup", "1", null, quote(0, "un catsup"), names(["ketchup", "salsa de tomate"])),
                wireLine("2 libras de pollo", "pollo", "2", "libra", quote(0, "2 libras de pollo"), names()),
              ],
              issues: [],
            },
            pickup,
          ],
          // Seen before the call: only the pollo. The catsup had nothing to pick from.
          ops: [op("add", "N1", null, "1"), op("add", "N2", "P1", "2")],
          move: "readback",
          ask: { kind: "none", lines: [] },
          say: "Va 👍",
        },
      ],
      // The second call's table: N1 catsup → P1 Salsa (by the other names), N2 pollo → P2 Pollo entero.
      TurnProposal: [{ ops: [op("add", "N1", "P1", "1"), op("add", "N2", "P2", "2")], move: "readback", ask: { kind: "none", lines: [] }, say: "Con gusto." }],
    });
    await t.say("mandame un catsup y 2 libras de pollo, lo paso a traer");

    expect(t.provider.requests.map((r) => r.schemaName)).toEqual([ONE_CALL_SCHEMA_NAME, "TurnProposal"]);
    expect(t.h.log.fields("one_call.second_call")).toEqual([expect.objectContaining({ reason: "other_names" })]);
    const readback = t.h.sentTo(t.phone).at(-1)!;
    expect(readback).toContain("• 1 Salsa de tomate Naturas 400 g · L 28\n• 2 libras de Pollo entero · L 90");
    expect(readback).toContain("💵 Total: L 118.");
  });

  it("an answer that isn't the schema goes the two-call way, and the logs say so", async () => {
    const t = await textTrip({
      [ONE_CALL_SCHEMA_NAME]: [{ observations: [], everything: true }],
      BurstReading: [
        { observations: [{ kind: "customer_order", lines: [wireLine("2 libras de arroz", "arroz", "2", "libra", quote(0, "2 libras de arroz"), names())], issues: [] }, pickup] },
      ],
      TurnProposal: [{ ops: [op("add", "N1", "P1", "2")], move: "readback", ask: { kind: "none", lines: [] }, say: "" }],
    });
    await t.say("2 libras de arroz, lo paso a traer");
    expect(t.provider.requests.map((r) => r.schemaName)).toEqual([ONE_CALL_SCHEMA_NAME, "BurstReading", "TurnProposal"]);
    expect(t.h.log.fields("one_call.fallback")).toEqual([expect.objectContaining({ reason: "invalid_output" })]);
    expect(t.h.sentTo(t.phone).at(-1)).toContain("• 2 Arroz 1 lb · L 36");
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ? AND job_state <> 'done'`, t.store.businessId)).toEqual([]);
  });
});
