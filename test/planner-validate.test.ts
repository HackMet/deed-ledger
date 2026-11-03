/**
 * The planner's proposal, checked by code (contract §2.3): one test per refusal, then the
 * readiness gate (`missingFor`) and the engine's last word on the step (`settleStep`). Pure.
 */
import { describe, expect, it } from "vitest";
import type { OrderLineView, OrderView } from "../src/domain/contract/outcomes";
import type { FrameLine, PlannerFrame } from "../src/domain/planner/frame";
import type { Candidate, PlannerOp, RetrievableProduct, TurnProposal } from "../src/domain/planner/types";
import { settleStep, validateProposal, type ValidatedTurn } from "../src/domain/planner/validate";
import { SAY_PHRASES } from "../src/domain/planner/wire";
import { missingFor } from "../src/domain/readiness";

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

const PRODUCTS = [
  product("p-tomate", "Tomate"),
  product("p-salsa", "Salsa de tomate Naturas 400 g"),
  product("p-pollo", "Pollo entero", { soldBy: "weight" }),
  product("p-huevos", "Huevos cartón 30", { usualQuantity: "1" }),
  product("p-cerveza", "Cerveza Salva Vida", { restricted: true }),
  product("p-arroz", "Arroz 1 lb"),
  product("p-tortillas", "Tortillas paquete 10"),
  product("p-clover", "Aceite Clover 1 L"),
  product("p-mazola", "Aceite Mazola 1 L"),
];

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

/** P labels in this order; `offered` says which line gets which. */
const LABELS = ["p-tomate", "p-salsa", "p-pollo", "p-huevos", "p-arroz", "p-tortillas", "p-clover", "p-mazola", "p-cerveza"];
const P = (productId: string) => `P${LABELS.indexOf(productId) + 1}`;

function frame(more: Partial<PlannerFrame> = {}, offered: Record<string, string[]> = {}): PlannerFrame {
  const products = new Map(PRODUCTS.map((p) => [p.productId, p]));
  const candidates: Candidate[] = LABELS.map((id, n) => {
    const p = products.get(id)!;
    return { label: `P${n + 1}`, productId: id, name: p.names[0]!, soldBy: p.soldBy, usualQuantity: p.usualQuantity, hasPrice: p.hasPrice, availability: p.availability, restricted: p.restricted, how: "all_words" };
  });
  const table = {
    candidates,
    offered: new Map(
      Object.entries({
        N1: [],
        N2: [P("p-pollo")],
        N3: [P("p-tomate"), P("p-salsa")],
        N4: [P("p-arroz")],
        N5: [],
        N6: [P("p-cerveza")],
        N7: [P("p-huevos")],
        L1: [P("p-clover"), P("p-mazola")],
        L3: [P("p-tortillas")],
        ...offered,
      }),
    ),
    howByLine: new Map(),
  };
  return {
    newItems: [
      line("N1", "platanos"),
      line("N2", "pollo"),
      line("N3", "tomates"),
      line("N4", "arroz", { quantity: "3", unit: "libra", productId: "p-arroz", productName: "Arroz 1 lb" }),
      line("N5", "piña"),
      line("N6", "cerveza", { restricted: true }),
      line("N7", "huevos"),
    ],
    orderLines: [line("L1", "aceite"), line("L2", "jabon", { quantity: "2", productId: "p-jabon", productName: "Jabón Xtra" }), line("L3", "tortillas", { productId: "p-tortillas", productName: "Tortillas paquete 10" })],
    table,
    saidTexts: [],
    readerQuantities: new Map(),
    readerRemoved: new Set(),
    unplacedRemovals: [],
    askedQuantityOf: null,
    basis: null,
    illegible: false,
    products,
    ...more,
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

const proposal = (ops: PlannerOp[], more: Partial<TurnProposal> = {}): TurnProposal => ({
  ops,
  move: "readback",
  ask: { kind: "none", lines: [] },
  say: "",
  ...more,
});

function check(raw: unknown, f: PlannerFrame = frame()): ValidatedTurn {
  const result = validateProposal(raw, f);
  if (!result.ok) throw new Error("expected a valid proposal");
  return result.turn;
}

const codes = (turn: ValidatedTurn) => turn.refused.map((r) => `${r.code}:${r.line ?? "-"}`);

describe("the proposal's shape", () => {
  it("refuses output that isn't the schema: a missing key, an extra key, a wrong enum, too many ops", () => {
    expect(validateProposal({ ops: [], move: "readback", ask: { kind: "none", lines: [] } }, frame())).toEqual({ ok: false, reason: "schema" });
    expect(validateProposal({ ...proposal([]), extra: 1 }, frame())).toEqual({ ok: false, reason: "schema" });
    expect(validateProposal({ ...proposal([]), move: "save" }, frame())).toEqual({ ok: false, reason: "schema" });
    expect(validateProposal(proposal(Array.from({ length: 41 }, () => op("add", "N1"))), frame())).toEqual({ ok: false, reason: "schema" });
    expect(validateProposal(proposal([], { ask: { kind: "quantities", lines: Array.from({ length: 13 }, () => "N1") } }), frame())).toEqual({ ok: false, reason: "schema" });
    expect(validateProposal("not json", frame())).toEqual({ ok: false, reason: "schema" });
  });
});

describe("labels and products", () => {
  it("drops an op on a label that isn't this turn's", () => {
    const turn = check(proposal([op("pick", "L9", { product: "P1" }), op("add", "N99")]));
    expect(codes(turn)).toContain("unknown_line:-");
    expect(turn.plan.changes).toBeUndefined();
  });

  it("drops a product that wasn't offered for that line, leaving the line unmatched", () => {
    // P1 (Tomate) exists, but was offered for N3, not N2.
    const turn = check(proposal([op("add", "N2", { product: P("p-tomate") }), op("add", "N3", { product: "P77" })]));
    expect(codes(turn)).toEqual(expect.arrayContaining(["not_offered:N2", "not_offered:N3"]));
    expect(turn.picks).toEqual([]);
  });

  it("maps a pick among the offered products to its product, by code", () => {
    const turn = check(proposal([op("add", "N3", { product: P("p-tomate") }), op("pick", "L1", { product: P("p-mazola") })]));
    expect(turn.picks).toEqual([{ label: "N3", productId: "p-tomate" }]);
    expect(turn.plan.changes).toEqual([{ lineRef: "L1", productId: "p-mazola" }]);
  });

  it("drops a second add of the same new item, and an add of an order line", () => {
    const turn = check(proposal([op("add", "N3", { product: P("p-tomate") }), op("add", "N3", { product: P("p-salsa") }), op("add", "L1", { product: P("p-clover") })]));
    expect(codes(turn)).toEqual(expect.arrayContaining(["add_twice:N3", "add_order_line:L1"]));
    expect(turn.picks).toEqual([{ label: "N3", productId: "p-tomate" }]);
  });

  it("drops a pick with no product", () => {
    expect(codes(check(proposal([op("pick", "L1")])))).toContain("pick_without_product:L1");
  });

  it("never lets a pick replace code's exact match", () => {
    const f = frame({}, { N4: [P("p-arroz"), P("p-tomate")] });
    const turn = check(proposal([op("add", "N4", { product: P("p-tomate") })]), f);
    expect(codes(turn)).toContain("pick_conflicts_match:N4");
    expect(turn.picks).toEqual([]);
  });

  it("logs a new item the plan left out; the engine still adds it, unmatched", () => {
    const turn = check(proposal([op("add", "N1")]));
    expect(codes(turn)).toEqual(expect.arrayContaining(["line_left_out:N2", "line_left_out:N7"]));
    expect(codes(turn)).not.toContain("line_left_out:N1");
  });
});

describe("quantities", () => {
  const answered = frame({ saidTexts: ["6 platanos, 2 libras de pollo y 4 tomates"] });

  it("takes a quantity the customer said for that line, line by line", () => {
    const turn = check(proposal([op("set_quantity", "N1", { quantity: "6" }), op("set_quantity", "N2", { quantity: "2" }), op("set_quantity", "N3", { quantity: "4" })]), answered);
    expect(turn.refused.filter((r) => r.code === "quantity_not_said")).toEqual([]);
    expect(turn.plan.changes).toEqual([
      { lineRef: "N1", quantity: "6" },
      { lineRef: "N2", quantity: "2" },
      { lineRef: "N3", quantity: "4" },
    ]);
  });

  it("refuses a quantity nobody said, or one said for another line", () => {
    const turn = check(proposal([op("set_quantity", "N1", { quantity: "7" }), op("set_quantity", "N1", { quantity: "4" })]), answered);
    expect(codes(turn).filter((c) => c.startsWith("quantity_not_said"))).toEqual(["quantity_not_said:N1", "quantity_not_said:N1"]);
    expect(turn.plan.changes).toBeUndefined();
  });

  it("drops the whole op when its quantity isn't said: the product goes too", () => {
    const turn = check(proposal([op("add", "N3", { product: P("p-tomate"), quantity: "9" })]));
    expect(codes(turn)).toContain("quantity_not_said:N3");
    expect(turn.picks).toEqual([]);
  });

  it("never changes a quantity the reader read for a new item", () => {
    const turn = check(proposal([op("add", "N4", { quantity: "5" })]), frame({ saidTexts: ["5"] }));
    expect(codes(turn)).toContain("quantity_not_said:N4");
    expect(check(proposal([op("add", "N4", { quantity: "3" })])).refused.map((r) => r.code)).not.toContain("quantity_not_said");
  });

  it("takes the reader's own set_quantity for an order line, and never a number that is the product's name", () => {
    const byReader = check(proposal([op("set_quantity", "L1", { quantity: "2" })]), frame({ readerQuantities: new Map([["L1", "2"]]) }));
    expect(byReader.plan.changes).toEqual([{ lineRef: "L1", quantity: "2" }]);
    const named = check(proposal([op("set_quantity", "L3", { quantity: "10" })]), frame({ saidTexts: ["si el paquete de 10 gracias"] }));
    expect(codes(named)).toContain("quantity_not_said:L3");
  });
});

describe("removals", () => {
  it("removes only an order line the reader removed, or one a removal it couldn't place names", () => {
    expect(codes(check(proposal([op("remove", "N1")])))).toContain("remove_new_item:N1");
    expect(codes(check(proposal([op("remove", "L2")])))).toContain("remove_not_said:L2");
    // Named, but the reader heard no removal: nothing goes.
    expect(codes(check(proposal([op("remove", "L2")]), frame({ saidTexts: ["el jabon dejalo igual"] })))).toContain("remove_not_said:L2");
    expect(check(proposal([op("remove", "L2")]), frame({ unplacedRemovals: ["el jabon"] })).plan.changes).toEqual([{ lineRef: "L2", remove: true }]);
    expect(check(proposal([op("remove", "L2")]), frame({ readerRemoved: new Set(["L2"]) })).plan.changes).toEqual([{ lineRef: "L2", remove: true }]);
  });
});

describe("a suggested quantity (D-46)", () => {
  const suggest = (target: string, more: Partial<PlannerOp> = {}) => op("add", target, { suggested_quantity: "1", ...more });

  it("is taken as 1, shown openly, for an item bought one at a time", () => {
    const turn = check(proposal([suggest("N5")]));
    expect(turn.plan.assumed).toEqual([{ lineRef: "N5", quantity: "1", source: "suggested" }]);
  });

  it("is dropped when it isn't 1", () => {
    const turn = check(proposal([suggest("N5", { suggested_quantity: "2" })]));
    expect(codes(turn)).toContain("suggestion_not_one:N5");
    expect(turn.plan.assumed).toEqual([]);
  });

  it("is dropped when a quantity was said", () => {
    expect(codes(check(proposal([suggest("N4", { product: P("p-arroz") })])))).toContain("suggestion_quantity_said:N4");
  });

  it("is dropped when the customer said a weight unit", () => {
    const f = frame({ newItems: [line("N1", "pollo", { unit: "libras" })] }, { N1: [] });
    expect(codes(check(proposal([suggest("N1")]), f))).toContain("suggestion_weight_unit:N1");
  });

  it("is dropped for a product sold by weight", () => {
    expect(codes(check(proposal([suggest("N2", { product: P("p-pollo") })])))).toContain("suggestion_sold_by_weight:N2");
  });

  it("is dropped while two products fit and none was picked, or the reader found the item unclear", () => {
    expect(codes(check(proposal([suggest("N3")])))).toContain("suggestion_unresolved:N3");
    const unclear = frame({ newItems: [line("N1", "aceite", { unclear: true })] }, { N1: [] });
    expect(codes(check(proposal([suggest("N1")]), unclear))).toContain("suggestion_unresolved:N1");
    // Picked among two by weaker evidence: still unsettled. Picked the one the customer named: 1 can stand.
    expect(codes(check(proposal([suggest("N3", { product: P("p-tomate") })])))).toContain("suggestion_unresolved:N3");
    const base = frame();
    const named: PlannerFrame = { ...base, table: { ...base.table, howByLine: new Map([["N3", new Map([[P("p-tomate"), "exact_name" as const]])]]) } };
    expect(check(proposal([suggest("N3", { product: P("p-tomate") })]), named).plan.assumed).toEqual([{ lineRef: "N3", quantity: "1", source: "suggested" }]);
  });

  it("is dropped for alcohol or tobacco", () => {
    expect(codes(check(proposal([suggest("N6")])))).toContain("suggestion_restricted:N6");
  });

  it("gives way to the store's own usual amount, which also stands with no suggestion", () => {
    const suggested = check(proposal([suggest("N7", { product: P("p-huevos") })]), frame({}, { N7: [P("p-huevos")] }));
    expect(suggested.plan.assumed).toEqual([{ lineRef: "N7", quantity: "1", source: "store_usual" }]);
    const unsuggested = check(proposal([op("add", "N7", { product: P("p-huevos") })]));
    expect(unsuggested.plan.assumed).toEqual([{ lineRef: "N7", quantity: "1", source: "store_usual" }]);
  });
});

describe("the question", () => {
  it("keeps only the lines that miss that kind, and drops a quantities question with none left", () => {
    const turn = check(proposal([op("add", "N5", { suggested_quantity: "1" })], { move: "ask", ask: { kind: "quantities", lines: ["N1", "N4", "N5", "N6", "N9"] } }));
    expect(turn.plan.ask).toEqual({ kind: "quantities", lineRefs: ["N1"] });
    expect(codes(turn)).toContain("ask_lines_filtered:-");
    const none = check(proposal([], { move: "ask", ask: { kind: "quantities", lines: ["N4"] } }));
    expect(none.plan.ask).toBeNull();
    expect(codes(none)).toContain("ask_without_lines:-");
  });

  it("asks which one only where two or more products were offered, and carries them for the engine", () => {
    const turn = check(proposal([], { move: "ask", ask: { kind: "options", lines: ["L1", "N2", "N3"] } }));
    expect(turn.plan.ask).toEqual({ kind: "options", lineRefs: ["L1", "N3"] });
    expect(turn.plan.options).toEqual([
      { lineRef: "L1", productIds: ["p-clover", "p-mazola"] },
      { lineRef: "N3", productIds: ["p-tomate", "p-salsa"] },
    ]);
  });

  it("asks pickup or delivery with no lines, and nothing when the move isn't ask", () => {
    expect(check(proposal([], { move: "ask", ask: { kind: "fulfillment", lines: ["N1"] } })).plan.ask).toEqual({ kind: "fulfillment", lineRefs: [] });
    expect(check(proposal([], { move: "readback", ask: { kind: "quantities", lines: ["N1"] } })).plan.ask).toBeNull();
  });
});

describe("the connecting phrase", () => {
  it("is one of the approved phrases, carried as chosen", () => {
    for (const say of SAY_PHRASES) expect(check(proposal([], { say })).plan.say).toBe(say);
  });

  it("refuses the whole proposal for anything else: no free text reaches a customer", () => {
    for (const say of ["Listo, son L 90", "Ya vi tu lista 👍 ", "Tu pedido está confirmado"]) {
      expect(validateProposal(proposal([], { say }), frame()), say).toEqual({ ok: false, reason: "schema" });
    }
  });

  it("states no fact and asks nothing, phrase by phrase", () => {
    for (const say of SAY_PHRASES) {
      expect(say, say).not.toMatch(/[\p{Nd}?¿]|\b(?:L|lempiras?|listo|confirmad|pagad|entregad|hay|acab|abiert|cerrad|hoy|mañana|minutos?|horas?)\b/iu);
    }
  });
});

// ---------------------------------------------------------------------------------------------

const orderLine = (lineId: string, more: Partial<OrderLineView> = {}): OrderLineView => ({
  lineId,
  text: lineId,
  productId: null,
  productName: null,
  quantity: "1",
  unit: null,
  unitPrice: null,
  availability: "no_se",
  restricted: false,
  mark: null,
  substitute: null,
  ...more,
});
const orderOf = (lines: OrderLineView[], fulfillment: OrderView["fulfillment"] = { mode: "pickup" }): OrderView => ({
  orderId: "o-1",
  version: 1,
  state: "armando",
  lines,
  fulfillment,
  total: null,
  queuePosition: null,
});

describe("readiness (missingFor)", () => {
  it("needs what to order, then quantities until asked twice, then pickup or delivery, then the place", () => {
    expect(missingFor(orderOf([]))).toEqual([{ kind: "what_to_order" }]);
    const order = orderOf([orderLine("a", { quantity: null }), orderLine("b"), orderLine("c", { quantity: null, restricted: true }), orderLine("d", { quantity: null, mark: "no_hay" })], null);
    expect(missingFor(order)).toEqual([{ kind: "quantities", lineIds: ["a"] }, { kind: "fulfillment" }]);
    expect(missingFor(order, { a: 2 })).toEqual([{ kind: "fulfillment" }]);
    const delivery = orderOf([orderLine("a")], { mode: "delivery", placeId: null, placeText: null, fee: null });
    expect(missingFor(delivery)).toEqual([{ kind: "delivery_place" }]);
    expect(missingFor(orderOf([orderLine("a", { productId: null, unitPrice: null })]))).toEqual([]);
  });
});

describe("the engine's last word (settleStep)", () => {
  const waiting = orderOf([orderLine("a", { quantity: null }), orderLine("b", { quantity: null }), orderLine("c")], null);
  const settle = (order: OrderView, proposed: Parameters<typeof settleStep>[0]["proposed"], more: { withOptions?: string[]; illegible?: boolean } = {}) =>
    settleStep({ order, missing: missingFor(order), proposed, withOptions: new Set(more.withOptions ?? []), illegible: more.illegible ?? false });

  it("turns a readback the order isn't ready for into the first missing question", () => {
    expect(settle(waiting, "readback")).toEqual({ type: "ask", kind: "quantities", lineIds: ["a", "b"] });
    expect(settle(orderOf([orderLine("a")]), "readback")).toEqual({ type: "readback" });
  });

  it("narrows a question to the lines that need it, or replaces it", () => {
    expect(settle(waiting, { kind: "quantities", lineIds: ["b", "c"] })).toEqual({ type: "ask", kind: "quantities", lineIds: ["b"] });
    expect(settle(waiting, { kind: "quantities", lineIds: ["c"] })).toEqual({ type: "ask", kind: "quantities", lineIds: ["a", "b"] });
    expect(settle(orderOf([orderLine("a")]), { kind: "fulfillment", lineIds: [] })).toEqual({ type: "readback" });
    expect(settle(waiting, { kind: "options", lineIds: ["a"] })).toEqual({ type: "ask", kind: "quantities", lineIds: ["a", "b"] });
    expect(settle(waiting, { kind: "options", lineIds: ["a", "c"] }, { withOptions: ["a"] })).toEqual({ type: "ask", kind: "options", lineIds: ["a"] });
    expect(settle(waiting, { kind: "unreadable", lineIds: [] }, { illegible: true })).toEqual({ type: "ask", kind: "unreadable", lineIds: [] });
    expect(settle(waiting, { kind: "unreadable", lineIds: [] })).toEqual({ type: "ask", kind: "quantities", lineIds: ["a", "b"] });
  });

  it("restates the first missing thing when nothing was proposed", () => {
    expect(settle(orderOf([orderLine("a")], null), null)).toEqual({ type: "ask", kind: "fulfillment", lineIds: [] });
  });
});
