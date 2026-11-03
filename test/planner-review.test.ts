/**
 * Findings from the independent review of the planner diff (Codex, Nov 2), one block each. Every
 * test here failed on the code it was written against, and passes with the fix. Finding 5 (alias
 * proposals and the completion batch) lives in planner-flow.test.ts, beside the D1 trip it needs.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CustomerContext } from "../src/application/engine";
import type { BurstReading, Observation } from "../src/domain/contract/observation";
import type { EngineOutcome, OrderView } from "../src/domain/contract/outcomes";
import { validateReading } from "../src/domain/perception/validate";
import type { FrameLine, PlannerFrame } from "../src/domain/planner/frame";
import type { CandidateHow, PlannerOp, RetrievableProduct, TurnPlan, TurnProposal } from "../src/domain/planner/types";
import { validateProposal } from "../src/domain/planner/validate";
import { renderOutcome } from "../src/domain/replies";
import { D1RetrievalRepository } from "../src/infrastructure/d1/retrieval-repository";
import { D1StoreSetupRepository } from "../src/infrastructure/d1/store-setup-repository";
import { MemoryEngine, type PretendProduct } from "../src/infrastructure/memory/memory-engine";
import { box } from "./fixtures/model/recorded";
import { storeWithStaff } from "./helpers/console";

// ---------------------------------------------------------------------------------------------
// A small frame: L1 arroz and L2 platanos on the order, N1 tomates (two products offered), N2 aceite.

const product = (productId: string, name: string, more: Partial<RetrievableProduct> = {}): RetrievableProduct => ({
  productId,
  names: [name],
  aliases: [],
  barcode: null,
  soldBy: null,
  usualQuantity: null,
  hasPrice: true,
  availability: "no_se",
  restricted: false,
  ...more,
});
const PRODUCTS = [product("p-tomate", "Tomate"), product("p-salsa", "Salsa de tomate"), product("p-clover", "Aceite Clover 1 L"), product("p-mazola", "Aceite Mazola 1 L")];

const line = (label: string, said: string, more: Partial<FrameLine> = {}): FrameLine => ({
  label,
  said,
  quantity: null,
  unit: null,
  restricted: false,
  productId: null,
  productName: null,
  unclear: false,
  ...more,
});

function frame(more: Partial<PlannerFrame> & { readonly how?: Record<string, CandidateHow> } = {}): PlannerFrame {
  const { how = {}, ...rest } = more;
  const candidates = PRODUCTS.map((p, n) => ({
    label: `P${n + 1}`,
    productId: p.productId,
    name: p.names[0]!,
    soldBy: p.soldBy,
    usualQuantity: p.usualQuantity,
    hasPrice: p.hasPrice,
    availability: p.availability,
    restricted: p.restricted,
    how: "all_words" as const,
  }));
  const offered = new Map([
    ["N1", ["P1", "P2"]],
    ["N2", ["P3", "P4"]],
  ]);
  const howByLine = new Map([...offered].map(([label, ps]) => [label, new Map(ps.map((p) => [p, how[`${label}:${p}`] ?? ("all_words" as CandidateHow)]))]));
  return {
    newItems: [line("N1", "tomates"), line("N2", "aceite")],
    orderLines: [line("L1", "arroz"), line("L2", "platanos")],
    table: { candidates, offered, howByLine },
    saidTexts: [],
    readerQuantities: new Map(),
    readerRemoved: new Set(),
    unplacedRemovals: [],
    askedQuantityOf: null,
    basis: null,
    illegible: false,
    products: new Map(PRODUCTS.map((p) => [p.productId, p])),
    ...rest,
  };
}

const op = (kind: PlannerOp["op"], target: string, more: Partial<PlannerOp> = {}): PlannerOp => ({
  op: kind,
  line: target,
  product: null,
  quantity: null,
  suggested_quantity: null,
  ...more,
});
const proposal = (ops: PlannerOp[], more: Partial<TurnProposal> = {}): TurnProposal => ({ ops, move: "readback", ask: { kind: "none", lines: [] }, say: "", ...more });
const check = (raw: unknown, f: PlannerFrame) => {
  const result = validateProposal(raw, f);
  if (!result.ok) throw new Error("expected a valid proposal");
  return result.turn;
};
const quantities = (raw: unknown, f: PlannerFrame) => (check(raw, f).plan.changes ?? []).filter((c) => c.quantity !== undefined);

describe("finding 1: a number backs a line's quantity only when the customer said it for that line", () => {
  it("never takes '6 plátanos' as the arroz's quantity", () => {
    expect(quantities(proposal([op("set_quantity", "L1", { quantity: "6" })]), frame({ saidTexts: ["6 plátanos"] }))).toEqual([]);
  });

  it("never takes a price or an address number as a quantity", () => {
    expect(quantities(proposal([op("set_quantity", "L1", { quantity: "18" })]), frame({ saidTexts: ["2 libras de arroz a L 18 cada una"] }))).toEqual([]);
    const askedArroz = frame({ saidTexts: ["llevámelo a la casa 5"], askedQuantityOf: "L1" });
    expect(quantities(proposal([op("set_quantity", "L1", { quantity: "5" })]), askedArroz)).toEqual([]);
  });

  it("takes a lone number that answers a question about that one line's quantity, and the words that name the line", () => {
    const askedArroz = frame({ saidTexts: ["6"], askedQuantityOf: "L1" });
    expect(quantities(proposal([op("set_quantity", "L1", { quantity: "6" })]), askedArroz)).toEqual([{ lineRef: "L1", quantity: "6" }]);
    // Asked about one line, but the burst holds two numbers: neither is taken by position.
    const two = frame({ saidTexts: ["6 y 2"], askedQuantityOf: "L1" });
    expect(quantities(proposal([op("set_quantity", "L1", { quantity: "6" })]), two)).toEqual([]);
    const named = frame({ saidTexts: ["6 plátanos, 2 libras de arroz"] });
    expect(quantities(proposal([op("set_quantity", "L1", { quantity: "2" }), op("set_quantity", "L2", { quantity: "6" })]), named)).toEqual([
      { lineRef: "L1", quantity: "2" },
      { lineRef: "L2", quantity: "6" },
    ]);
  });
});

describe("finding 2: a removal needs the reader to have heard one", () => {
  const removes = (raw: unknown, f: PlannerFrame) => (check(raw, f).plan.changes ?? []).filter((c) => c.remove === true).map((c) => c.lineRef);

  it("never removes a line the customer only mentioned", () => {
    expect(removes(proposal([op("remove", "L1")]), frame({ saidTexts: ["dejá el arroz como estaba"] }))).toEqual([]);
  });

  it("resolves a removal the reader couldn't place only among the lines it names", () => {
    const f = frame({ saidTexts: ["quitame el arroz"], unplacedRemovals: ["el arroz"] });
    expect(removes(proposal([op("remove", "L1"), op("remove", "L2")]), f)).toEqual(["L1"]);
    expect(removes(proposal([op("remove", "L2")]), frame({ readerRemoved: new Set(["L2"]) }))).toEqual(["L2"]);
  });
});

describe("finding 3: the planner's sentence is one of the approved phrases, never free text", () => {
  it("never lets a sentence outside the list reach the customer", () => {
    for (const say of ["Tu pedido está en camino", "Tenemos arroz disponible", "Cuesta veinte pesos"]) {
      const result = validateProposal(proposal([], { say }), frame());
      expect(result.ok ? result.turn.plan.say : "", say).toBe("");
    }
  });
});

describe("finding 4: picking one of several products doesn't make a suggested 1 safe", () => {
  const assumed = (raw: unknown, f: PlannerFrame) => check(raw, f).plan.assumed.map((a) => a.lineRef);

  it("refuses 1 for a line offered two or more products unless the customer named the one picked", () => {
    expect(assumed(proposal([op("add", "N2", { product: "P3", suggested_quantity: "1" })]), frame())).toEqual([]);
    const named = frame({ how: { "N2:P3": "exact_name" } });
    expect(assumed(proposal([op("add", "N2", { product: "P3", suggested_quantity: "1" })]), named)).toEqual(["N2"]);
  });

  it("refuses 1 when the reader found the item unclear, whatever was picked", () => {
    const unclear = frame({ newItems: [line("N1", "tomates"), line("N2", "aceite", { unclear: true })], how: { "N2:P3": "exact_name" } });
    expect(assumed(proposal([op("add", "N2", { product: "P3", suggested_quantity: "1" })]), unclear)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

const CATALOG: readonly PretendProduct[] = [
  { productId: "p-arroz", names: ["Arroz 1 lb"], aliases: [], barcode: null, price: 1800 },
  { productId: "p-pollo", names: ["Pollo entero"], aliases: [], barcode: null, price: 4500, soldBy: "weight" },
  { productId: "p-clover", names: ["Aceite Clover 1 L"], aliases: [], barcode: null, price: 6000, availability: "se_acabo" },
  { productId: "p-clover-500", names: ["Aceite Clover 500 ml"], aliases: [], barcode: null, price: 3400 },
  { productId: "p-mazola", names: ["Aceite Mazola 1 L"], aliases: [], barcode: null, price: 6500 },
];
const evidence = { source: "text", message: 0, start: 0, end: 1 } as const;
const item = (name: string, quantity: string | null = null) => ({ text: name, name, quantity, unit: null, restrictedCategory: false, evidence });
const pickup: Observation = { kind: "fulfillment", mode: "pickup", pin: null, placeText: null, sameAsBefore: false, issues: [] };

function customer() {
  const engine = new MemoryEngine(() => [], { catalog: CATALOG });
  let job = 0;
  const context = (): CustomerContext => ({ businessId: "store-r", conversationId: "conv-r", customerId: "cust-r", jobId: `job-${++job}`, nowMs: job });
  const burst = async (observations: Observation[], plan?: TurnPlan): Promise<EngineOutcome> => {
    const reading: BurstReading = { observations, calls: [] };
    return (await (plan === undefined ? engine.onBurst(context(), reading, []) : engine.onBurst(context(), reading, [], plan))).outcome;
  };
  return { engine, burst, open: async () => (await engine.plannerContext(context())).order };
}
const plan = (more: Partial<TurnPlan>): TurnPlan => ({ move: "ask", ask: null, assumed: [], say: "", basis: null, ...more });
const orderOf = (outcome: EngineOutcome): OrderView => ("order" in outcome ? outcome.order : null)!;

describe("finding 6: the engine applies a plan only to the order it was checked against", () => {
  it("refuses a plan made for an order that has changed since, and asks what the order still needs", async () => {
    const c = customer();
    await c.burst([{ kind: "customer_order", lines: [item("arroz"), item("platanos")], issues: [] }, pickup]);
    // The plan was checked while L1 was arroz; since then the arroz went, so L1 is now platanos.
    await c.burst([{ kind: "order_change", edits: [{ op: "remove", target: { ref: "L1", said: "el arroz" }, evidence }], issues: [] }]);
    const stale = plan({ move: "readback", changes: [{ lineRef: "L1", quantity: "6" }], basis: "the order as it was before the arroz went" });
    const outcome = await c.burst([{ kind: "clarification", answer: "6 de arroz", evidence, issues: [] }], stale);
    expect(orderOf(outcome).lines.map((l) => [l.text, l.quantity])).toEqual([["platanos", null]]);
    expect(outcome).toMatchObject({ type: "ask", questions: { kind: "quantities" } });
  });

  it("checks every assumed quantity against the product as it is now: never 1 of something sold by the pound", async () => {
    const c = customer();
    const outcome = await c.burst(
      [{ kind: "customer_order", lines: [item("pollo")], issues: [] }, pickup],
      plan({ move: "readback", changes: [{ lineRef: "N1", productId: "p-pollo" }], assumed: [{ lineRef: "N1", quantity: "1", source: "suggested" }] }),
    );
    expect(orderOf(outcome).lines[0]).toMatchObject({ productId: "p-pollo", quantity: null });
  });
});

describe("finding 8: options never offer a product marked 'No hay'", () => {
  it("leaves a sold-out product out of 'Para … tengo:'", async () => {
    const c = customer();
    const outcome = await c.burst(
      [{ kind: "customer_order", lines: [item("aceite")], issues: [] }, pickup],
      plan({ ask: { kind: "options", lineRefs: ["N1"] }, options: [{ lineRef: "N1", productIds: ["p-clover", "p-clover-500", "p-mazola"] }] }),
    );
    const body = renderOutcome(outcome, { customerId: "cust-r" })!.body;
    expect(body).not.toContain("Aceite Clover 1 L");
    expect(body).toContain("1. Aceite Clover 500 ml · L 34\n2. Aceite Mazola 1 L · L 65");
  });
});

describe("finding 9: a photo line kept only through the whole-photo fallback never keeps a quantity", () => {
  it("drops the quantity read from an area it couldn't place, so it's asked", () => {
    const messages = [{ type: "image" as const, mimeType: "image/jpeg", bytes: new Uint8Array([1]).buffer }];
    const raw = {
      observations: [
        {
          kind: "customer_order",
          lines: [{ text: "2 sal", name: "sal", quantity: "2", unit: null, restricted: false, pick: null, evidence: box(0, [0.1, 0.94, 0.3, 1.03]) }],
          issues: [],
        },
      ],
    };
    const read = validateReading(raw, "customer", messages, { openOrder: null, pendingQuestion: null, catalogLabels: [] });
    expect(read.ok && read.observations[0]).toMatchObject({ kind: "customer_order", lines: [{ name: "sal", quantity: null }] });
  });
});

// ---------------------------------------------------------------------------------------------

describe("finding 7: a stale 'Sí' never approves a renewed proposal for another product", () => {
  it("gives a proposal renewed for another product a new ID", async () => {
    const store = await storeWithStaff();
    const owner = store.members[0]!.userId;
    const setup = new D1StoreSetupRepository(env.DB);
    await setup.addProduct(store, { name: "Salsa de tomate Naturas 400 g", otherNames: [], price: 2800 }, 1);
    await setup.addProduct(store, { name: "Salsa inglesa", otherNames: [], price: 4000 }, 1);
    const products = await setup.listProducts(store);
    const id = (name: string) => products.find((p) => p.name === name)!.productId;
    const customerId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO customers (id, business_id, phone, created_at_ms) VALUES (?, ?, ?, 0)`).bind(customerId, store.businessId, `5040${Date.now() % 1e8}`).run();
    for (const orderId of ["order-a", "order-b"]) {
      await env.DB.prepare(`INSERT INTO orders (id, business_id, customer_id, state, current_version, created_at_ms) VALUES (?, ?, ?, 'confirmado', 1, 0)`)
        .bind(`${orderId}-${store.businessId}`, store.businessId, customerId)
        .run();
    }
    const repo = new D1RetrievalRepository(env.DB);
    const propose = (productId: string, orderId: string) =>
      repo.proposeAlias(store, { said: "salsa roja", productId, orderId: `${orderId}-${store.businessId}`, customerId }, 10);
    expect(await propose(id("Salsa de tomate Naturas 400 g"), "order-a")).toBe(true);
    const [first] = await repo.listProposed(store);
    expect(await repo.rejectAlias(store, first!.id, owner, 11)).toBe(true);
    expect(await propose(id("Salsa inglesa"), "order-b")).toBe(true);
    const [renewed] = await repo.listProposed(store);
    expect(renewed).toMatchObject({ said: "salsa roja", productName: "Salsa inglesa" });
    // The owner's old page still shows "salsa roja → Salsa de tomate"; its Sí must not approve Salsa inglesa.
    expect(renewed!.id).not.toBe(first!.id);
    expect(await repo.approveAlias(store, first!.id, owner, 12)).toBe(false);
    expect(await repo.listApprovedAliases(store)).toEqual([]);
  });
});
