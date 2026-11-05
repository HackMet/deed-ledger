/**
 * The planner on the Deed engine (PlannedDeedEngine), on local D1: the conversation's memory beside the
 * ledger, the plan's decisions reaching OrderEngine as line content, and the ledger as the only writer
 * of orders. No model calls: plans are written by hand, as the validated planner would hand them over.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CustomerContext, EngineResult, LineMatch, MemberContext } from "../src/application/engine";
import { OrderEngine } from "../src/application/engine/order-engine";
import { reviewKey } from "../src/domain/change-request";
import type { ActionEnvelope, CustomerAction } from "../src/domain/contract/actions";
import type { BurstReading, ItemLine, Observation } from "../src/domain/contract/observation";
import type { EngineOutcome, OrderView } from "../src/domain/contract/outcomes";
import { orderBasis } from "../src/domain/planner/frame";
import type { TurnPlan } from "../src/domain/planner/types";
import type { StoreSetup } from "../src/domain/store-setup";
import { D1FactLedger } from "../src/infrastructure/d1/fact-ledger";
import { D1OrderStore } from "../src/infrastructure/d1/order-store";
import { PlannedDeedEngine, SetupCatalogOrderStore } from "../src/infrastructure/d1/planned-deed-engine";
import { D1StockBalances } from "../src/infrastructure/d1/stock-balances";
import { priceKey } from "../src/domain/price";
import { renderOutcome } from "../src/domain/replies";
import { count, save, T0 } from "./helpers/orders";
import { newPhone, seedStore } from "./helpers/seed";

const evidence = { source: "text", message: 0, start: 0, end: 1 } as const;
const item = (name: string, quantity: string | null = null): ItemLine => ({ text: name, name, quantity, unit: null, restrictedCategory: false, evidence });
const order = (...lines: ItemLine[]): Observation => ({ kind: "customer_order", lines, issues: [] });
const pickup: Observation = { kind: "fulfillment", mode: "pickup", pin: null, placeText: null, sameAsBefore: false, issues: [] };
const delivery: Observation = { kind: "fulfillment", mode: "delivery", pin: null, placeText: "frente a la iglesia", sameAsBefore: false, issues: [] };
const answer = (said: string): Observation => ({ kind: "clarification", answer: said, evidence, issues: [] });
const priceQuestion = (asked: string): Observation => ({ kind: "question", topic: "price", products: [asked], issues: [] });

/**
 * A store with its own Tienda products (synthetic), its ledger and the planner's engine over it, wired
 * as composition wires it (with the store's stock). Arroz, Clover and Mazola have prices the owner
 * confirmed on Productos; Sal has only a legacy Tienda price (`store_products.price_centavos`, no fact).
 */
async function plannedStore(fee: number | null = null) {
  const seeded = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
  const { businessId } = seeded;
  const owner = seeded.members[0]!.userId;
  const id = (name: string) => `${businessId}:${name}`;
  const setupOf: StoreSetup = {
    products: [
      { productId: id("arroz"), name: "Arroz 1 lb", otherNames: [], price: 1800, noHay: false, soldBy: null, usualQuantity: null },
      { productId: id("clover"), name: "Aceite Clover 1 L", otherNames: [], price: 6000, noHay: false, soldBy: null, usualQuantity: null },
      { productId: id("mazola"), name: "Aceite Mazola 1 L", otherNames: [], price: 6500, noHay: false, soldBy: null, usualQuantity: null },
      { productId: id("sal"), name: "Sal 1 lb", otherNames: [], price: 800, noHay: false, soldBy: null, usualQuantity: null },
      { productId: id("leche"), name: "Leche entera 1 L", otherNames: [], price: 3200, noHay: true, soldBy: null, usualQuantity: null },
    ],
    hours: null,
    deliveryFee: fee,
  };
  const setup = { read: async () => setupOf };
  const store = new SetupCatalogOrderStore(new D1OrderStore(env.DB), setup);
  const ledger = new OrderEngine({ store, ids: { newId: () => crypto.randomUUID() }, ledger: new D1FactLedger(env.DB), stock: new D1StockBalances(env.DB) });
  const engine = new PlannedDeedEngine({ db: env.DB, ledger, store, setup });
  const member: MemberContext = { businessId, memberId: owner, role: "owner", canApproveFiado: false, nowMs: T0 - 60_000 };
  for (const [name, price] of [["arroz", 1800], ["clover", 6000], ["mazola", 6500], ["leche", 3200]] as const) {
    await save(
      await engine.onConsoleAction(member, {
        operationKey: priceKey(id(name), member.nowMs, "confirm_price"),
        actor: { type: "member", memberId: owner, role: "owner" },
        action: { type: "confirm_price", productId: id(name), price },
      }),
    );
  }
  let job = 0;
  const context = (customerId = "cust-1", over: Partial<CustomerContext> = {}): CustomerContext => ({
    businessId,
    customerId,
    conversationId: `conv-${customerId}`,
    jobId: `job-${++job}`,
    nowMs: T0 + job * 1_000,
    // A name on file: Confirmar isn't held for it.
    ...({ customerName: "Carla" } as object),
    ...over,
  });
  /** One burst with a plan checked against the order as the planner would see it. */
  const burst = async (
    observations: Observation[],
    plan: Omit<TurnPlan, "basis"> | null,
    matches: readonly LineMatch[] = [],
    at: CustomerContext = context(),
  ): Promise<EngineResult> => {
    const reading: BurstReading = { observations, calls: [] };
    const known = await engine.plannerContext(at);
    const result =
      plan === null ? await engine.onBurst(at, reading, matches) : await engine.onBurst(at, reading, matches, { ...plan, basis: orderBasis(known.order) });
    await save(result);
    return result;
  };
  return { businessId, id, engine, ledger, store, context, burst };
}

const ask = (kind: NonNullable<TurnPlan["ask"]>["kind"], lineRefs: string[], more: Partial<TurnPlan> = {}): Omit<TurnPlan, "basis"> => ({
  move: "ask",
  ask: { kind, lineRefs },
  assumed: [],
  say: "",
  ...more,
});
const readback = (more: Partial<TurnPlan> = {}): Omit<TurnPlan, "basis"> => ({ move: "readback", ask: null, assumed: [], say: "", ...more });

const orderIn = (outcome: EngineOutcome): OrderView => {
  if (!("order" in outcome) || outcome.order === null) throw new Error(`expected an order, got ${outcome.type}`);
  return outcome.order;
};

const confirmTap = (customerId: string, view: OrderView): ActionEnvelope<CustomerAction> => ({
  operationKey: `confirm:${view.orderId}:v${view.version}`,
  actor: { type: "customer", customerId },
  action: { type: "confirm_order", orderId: view.orderId, version: view.version },
});

describe("the planner on the Deed engine", () => {
  it("keeps an order being built in the conversation's memory and the question it asked", async () => {
    const t = await plannedStore();
    const at = t.context();
    const asked = await t.burst([order(item("arroz"))], ask("quantities", ["N1"]), [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }], at);

    expect(asked.outcome).toMatchObject({ type: "ask", questions: { kind: "quantities" } });
    // Nothing read back yet: the ledger holds no order; the memory holds the draft.
    expect(await count(`orders WHERE business_id = ?`, t.businessId)).toBe(0);
    expect(await count(`planner_memory WHERE business_id = ?`, t.businessId)).toBe(1);

    const known = await t.engine.plannerContext(t.context());
    expect(known.order).toMatchObject({ state: "armando", lines: [{ productId: t.id("arroz"), quantity: null }] });
    const lineId = known.order!.lines[0]!.lineId;
    expect(known.said).toEqual({ [lineId]: "arroz" });
    expect(known.lastAsk).toEqual({ kind: "quantities", lineIds: [lineId], times: 1 });
    // The ask's order claim is backed by the memory that holds the draft.
    expect(await t.engine.verifyClaims(at, [{ type: "order_state", orderId: known.order!.orderId, version: known.order!.version, state: "armando" }])).toEqual([true]);
  });

  it("applies the plan's product pick, writes the readback through the ledger, and confirms it there", async () => {
    const t = await plannedStore();
    const picked: LineMatch = { observation: 0, line: 0, productId: t.id("clover"), how: "planner_pick" };
    const read = await t.burst([order(item("aceite de litro", "2")), pickup], readback(), [picked]);

    expect(read.outcome.type).toBe("readback");
    const view = orderIn(read.outcome);
    expect(view.lines).toMatchObject([{ lineId: "L1", productId: t.id("clover"), productName: "Aceite Clover 1 L", quantity: "2", unitPrice: 6000 }]);
    expect(view.total).toBe(12000);
    // The ledger wrote it: version 1, por_confirmar, priced as the conversation priced it.
    const row = await env.DB.prepare(`SELECT o.state, o.current_version AS version, v.total_centavos AS total FROM orders o JOIN order_versions v ON v.order_id = o.id AND v.version = o.current_version WHERE o.id = ?`)
      .bind(view.orderId)
      .first();
    expect(row).toEqual({ state: "por_confirmar", version: 1, total: 12000 });
    // The pick is remembered under the ledger's label, for the alias proposal after Confirmar.
    expect((await t.engine.plannerContext(t.context())).picked).toEqual(["L1"]);

    const confirmed = await t.engine.onCustomerAction(t.context(), confirmTap("cust-1", view));
    await save(confirmed);
    expect(confirmed.outcome).toMatchObject({ type: "order_confirmed", order: { orderId: view.orderId, state: "confirmado", total: 12000 } });
    expect((await env.DB.prepare(`SELECT state FROM orders WHERE id = ?`).bind(view.orderId).first())?.state).toBe("confirmado");
    const after = await t.engine.plannerContext(t.context());
    expect(after.order).toMatchObject({ orderId: view.orderId, state: "confirmado" });
    expect(after.picked).toEqual(["L1"]);
  });

  it("numbers the options it showed and takes the plan's pick for an answered number", async () => {
    const t = await plannedStore();
    const options = [{ lineRef: "N1", productIds: [t.id("clover"), t.id("mazola")] }];
    const shown = await t.burst([order(item("aceite", "1"))], ask("options", ["N1"], { options }));
    expect(shown.outcome).toMatchObject({ type: "ask", questions: { kind: "options" } });

    const known = await t.engine.plannerContext(t.context());
    expect(known.shownOptions.map((o) => [o.number, o.productId, o.price])).toEqual([
      [1, t.id("clover"), 6000],
      [2, t.id("mazola"), 6500],
    ]);
    // "2": code maps the number to the option as shown; the plan carries the pick as a change.
    const two = known.shownOptions.find((o) => o.number === 2)!;
    const read = await t.burst([answer("2"), pickup], readback({ changes: [{ lineRef: "L1", productId: two.productId }] }));
    expect(read.outcome.type).toBe("readback");
    expect(orderIn(read.outcome).lines).toMatchObject([{ productId: t.id("mazola"), productName: "Aceite Mazola 1 L", unitPrice: 6500 }]);
    expect((await t.engine.plannerContext(t.context())).lastAsk).toBeNull();
  });

  it("remembers what the last answer was about until the next burst", async () => {
    const t = await plannedStore();
    const answered = await t.burst([priceQuestion("arroz")], null, [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }]);
    expect(answered.outcome).toMatchObject({ type: "answer", facts: [{ productId: t.id("arroz"), unitPrice: 1800 }] });
    expect((await t.engine.plannerContext(t.context())).lastAnswered).toEqual(["arroz"]);
    // The price claim is backed by the store's own setup, where it was quoted from.
    expect(await t.engine.verifyClaims(t.context(), [{ type: "unit_price", productId: t.id("arroz"), price: 1800 }, { type: "unit_price", productId: t.id("arroz"), price: 100 }])).toEqual([true, false]);

    await t.burst([order(item("arroz", "2"))], ask("fulfillment", []));
    expect((await t.engine.plannerContext(t.context())).lastAnswered).toEqual([]);
  });

  it("keeps each store's conversation and ledger apart", async () => {
    const a = await plannedStore();
    const b = await plannedStore();
    await a.burst([order(item("arroz"))], ask("quantities", ["N1"]), [{ observation: 0, line: 0, productId: a.id("arroz"), how: "exact_name" }], a.context("same-customer"));

    // Same customer ID in another store: nothing of store A.
    const inB = await b.engine.plannerContext(b.context("same-customer"));
    expect(inB.order).toBeNull();
    expect(inB.said).toEqual({});
    // A pick naming store A's product reaches store B's ledger unmatched, never as A's product.
    const read = await b.burst([order(item("arroz", "1")), pickup], readback(), [{ observation: 0, line: 0, productId: a.id("arroz"), how: "planner_pick" }], b.context("same-customer"));
    expect(orderIn(read.outcome).lines).toMatchObject([{ productId: null, productName: null, unitPrice: null }]);
    // A's draft isn't backed in B, and B's order isn't backed in A.
    const draft = (await a.engine.plannerContext(a.context("same-customer"))).order!;
    expect(await b.engine.verifyClaims(b.context(), [{ type: "order_state", orderId: draft.orderId, version: draft.version, state: "armando" }])).toEqual([false]);
    const bOrder = orderIn(read.outcome);
    expect(await a.engine.verifyClaims(a.context(), [{ type: "order_state", orderId: bOrder.orderId, version: 1, state: "por_confirmar" }])).toEqual([false]);
    expect(await b.engine.verifyClaims(b.context(), [{ type: "order_state", orderId: bOrder.orderId, version: 1, state: "por_confirmar" }])).toEqual([true]);
  });

  it("replays a retried job without writing anything twice", async () => {
    const t = await plannedStore();
    const at = t.context();
    const reading: BurstReading = { observations: [order(item("arroz", "3")), pickup], calls: [] };
    const matches: LineMatch[] = [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }];
    const plan = { ...readback(), basis: null };
    const first = await t.engine.onBurst(at, reading, matches, plan);
    await save(first);
    const memoryBefore = await env.DB.prepare(`SELECT version FROM planner_memory WHERE business_id = ?`).bind(t.businessId).first();

    const again = await t.engine.onBurst(at, reading, matches, plan);
    expect(again.commits).toEqual([]);
    expect(again.outcome).toEqual(first.outcome);
    await save(again);
    expect(await count(`order_versions WHERE business_id = ?`, t.businessId)).toBe(1);
    expect(await count(`operations WHERE business_id = ?`, t.businessId)).toBe(1);
    expect(await env.DB.prepare(`SELECT version FROM planner_memory WHERE business_id = ?`).bind(t.businessId).first()).toEqual(memoryBefore);
  });

  it("says the subtotal for a delivery while the ledger keeps the total with the fee, and backs the claim", async () => {
    const t = await plannedStore(3000);
    const read = await t.burst([order(item("arroz", "5")), delivery], readback(), [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }]);
    const view = orderIn(read.outcome);
    expect(view.total).toBe(9000);
    expect(view.fulfillment).toMatchObject({ mode: "delivery", fee: 3000 });
    expect((await env.DB.prepare(`SELECT total_centavos FROM order_versions WHERE order_id = ?`).bind(view.orderId).first())?.total_centavos).toBe(12000);
    expect(
      await t.engine.verifyClaims(t.context(), [
        { type: "order_total", orderId: view.orderId, version: 1, total: 9000 },
        { type: "order_total", orderId: view.orderId, version: 1, total: 12000 },
      ]),
    ).toEqual([true, false]);
  });

  it("holds Confirmar for the customer's name, then confirms the ledger's version once the name arrives", async () => {
    const t = await plannedStore();
    const nameless = (over: Partial<CustomerContext> = {}) => t.context("cust-1", { customerName: null, ...over } as Partial<CustomerContext>);
    const read = await t.burst([order(item("arroz", "2")), pickup], readback(), [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }], nameless());
    const view = orderIn(read.outcome);

    const held = await t.engine.onCustomerAction(nameless(), confirmTap("cust-1", view));
    await save(held);
    expect(held.outcome).toMatchObject({ type: "ask", question: "customer_name" });
    expect((await env.DB.prepare(`SELECT state FROM orders WHERE id = ?`).bind(view.orderId).first())?.state).toBe("por_confirmar");

    const named = await t.burst([{ kind: "customer_name", name: "Maria Lopez", evidence, issues: [] } as unknown as Observation], null, [], nameless());
    expect(named.outcome).toMatchObject({ type: "order_confirmed", order: { orderId: view.orderId, version: 1, state: "confirmado" } });
    expect((await env.DB.prepare(`SELECT state FROM orders WHERE id = ?`).bind(view.orderId).first())?.state).toBe("confirmado");
    // Under the key the button carries: the tap again is the same confirmation, never a second one.
    const again = await t.engine.onCustomerAction(t.context(), confirmTap("cust-1", view));
    expect(again.outcome.type).toBe("duplicate");
    expect(await count(`operations WHERE business_id = ? AND operation_key = ?`, t.businessId, `confirm:${view.orderId}:v1`)).toBe(1);
  });

  it("sends a change after confirming to the store as a request (K12): the order stays as confirmed", async () => {
    const t = await plannedStore();
    const read = await t.burst([order(item("arroz", "2")), pickup], readback(), [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }]);
    const view = orderIn(read.outcome);
    await save(await t.engine.onCustomerAction(t.context(), confirmTap("cust-1", view)));

    const changed = await t.burst(
      [{ kind: "order_change", edits: [{ op: "add", line: item("aceite", "1") }], issues: [] } as unknown as Observation],
      readback(),
      [{ observation: 0, line: 0, productId: t.id("clover"), how: "planner_pick" }],
    );
    expect(changed.outcome).toMatchObject({ type: "order_status", order: { orderId: view.orderId, version: 1, state: "confirmado" } });
    expect(orderIn(changed.outcome).openChangeRequest).not.toBeNull();
    expect(await count(`facts WHERE business_id = ? AND kind = 'change_request'`, t.businessId)).toBe(1);
    // The version stays as confirmed; the conversation holds what the customer asked for, to build on.
    const known = (await t.engine.plannerContext(t.context())).order!;
    expect(known).toMatchObject({ orderId: view.orderId, version: 1, state: "confirmado" });
    expect(known.lines.map((line) => [line.lineId, line.productId])).toEqual([
      ["L1", t.id("arroz")],
      ["L2", t.id("clover")],
    ]);
  });

  it("follows the ledger once staff move the order on, and forgets it once it's closed", async () => {
    const t = await plannedStore();
    const read = await t.burst([order(item("arroz", "2")), pickup], readback(), [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }]);
    const view = orderIn(read.outcome);
    await save(await t.engine.onCustomerAction(t.context(), confirmTap("cust-1", view)));
    const member = { businessId: t.businessId, memberId: "staff-1", role: "owner" as const, canApproveFiado: false, nowMs: T0 + 90_000 };
    const preparing = await t.engine.onConsoleAction(member, {
      operationKey: `staff:${view.orderId}:1:start_preparing`,
      actor: { type: "member", memberId: "staff-1", role: "owner" },
      action: { type: "start_preparing", orderId: view.orderId, version: 1 },
    });
    await save(preparing);
    expect((await t.engine.plannerContext(t.context())).order?.state).toBe("preparando");

    await env.DB.prepare(`UPDATE orders SET state = 'entregado' WHERE id = ?`).bind(view.orderId).run();
    expect((await t.engine.plannerContext(t.context())).order).toBeNull();
  });

  it("builds a second change after confirming on the change still waiting, so the store reviews both (K12)", async () => {
    const t = await plannedStore();
    const read = await t.burst([order(item("arroz", "2")), pickup], readback(), [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }]);
    const view = orderIn(read.outcome);
    await save(await t.engine.onCustomerAction(t.context(), confirmTap("cust-1", view)));
    const add = (name: string, productId: string) =>
      t.burst(
        [{ kind: "order_change", edits: [{ op: "add", line: item(name, "1") }], issues: [] } as unknown as Observation],
        readback(),
        [{ observation: 0, line: 0, productId, how: "planner_pick" }],
      );

    await add("aceite clover", t.id("clover"));
    const second = await add("aceite mazola", t.id("mazola"));

    const requests = await env.DB.prepare(
      `SELECT body_json FROM facts WHERE business_id = ? AND kind = 'change_request' ORDER BY rowid`,
    )
      .bind(t.businessId)
      .all<{ body_json: string }>();
    expect(requests.results).toHaveLength(2);
    const latest = JSON.parse(requests.results[1]!.body_json) as { lines: OrderView["lines"] };
    expect(latest.lines.map((line) => line.productId)).toEqual([t.id("arroz"), t.id("clover"), t.id("mazola")]);
    // What the customer hears about the confirmed version is that version, as the ledger holds it.
    const said = orderIn(second.outcome);
    expect(said).toMatchObject({ orderId: view.orderId, version: 1, state: "confirmado", total: 3600 });
    expect(said.lines.map((line) => line.productId)).toEqual([t.id("arroz")]);
    expect(await t.engine.verifyClaims(t.context(), [{ type: "order_total", orderId: view.orderId, version: 1, total: 3600 }])).toEqual([true]);
  });

  it("goes back to the confirmed version once the store declines the waiting change", async () => {
    const t = await plannedStore();
    const read = await t.burst([order(item("arroz", "2")), pickup], readback(), [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }]);
    const view = orderIn(read.outcome);
    await save(await t.engine.onCustomerAction(t.context(), confirmTap("cust-1", view)));
    const changed = await t.burst(
      [{ kind: "order_change", edits: [{ op: "add", line: item("aceite", "1") }], issues: [] } as unknown as Observation],
      readback(),
      [{ observation: 0, line: 0, productId: t.id("clover"), how: "planner_pick" }],
    );
    const request = orderIn(changed.outcome).openChangeRequest!;
    const member = { businessId: t.businessId, memberId: "staff-1", role: "owner" as const, canApproveFiado: false, nowMs: T0 + 90_000 };
    await save(
      await t.engine.onConsoleAction(member, {
        operationKey: reviewKey(request.id),
        actor: { type: "member", memberId: "staff-1", role: "owner" },
        action: { type: "review_change", changeRequestId: request.id, decision: "decline", reason: "No hay aceite" },
      }),
    );
    const known = (await t.engine.plannerContext(t.context())).order!;
    expect(known).toMatchObject({ orderId: view.orderId, version: 1, state: "confirmado" });
    expect(known.lines.map((line) => line.productId)).toEqual([t.id("arroz")]);
  });

  it("keeps a shared location in the ledger as words the staff can use, and still reads it back as the pin", async () => {
    const t = await plannedStore(3000);
    const pin = { latitude: 15.611234, longitude: -86.001578 };
    const atPin: Observation = { kind: "fulfillment", mode: "delivery", pin, placeText: null, sameAsBefore: false, issues: [] } as Observation;
    const arroz: LineMatch[] = [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }];
    const read = await t.burst([order(item("arroz", "2")), atPin], readback(), arroz);
    const view = orderIn(read.outcome);
    // The reply still has the pin ("a tu ubicación"); the ledger keeps it in words.
    expect(view.fulfillment).toMatchObject({ mode: "delivery", pin, placeText: null, fee: 3000 });
    const kept = await env.DB.prepare(`SELECT place_text FROM order_versions WHERE order_id = ? AND version = 1`).bind(view.orderId).first<{ place_text: string }>();
    expect(kept?.place_text).toBe("Ubicación compartida por WhatsApp: 15.611234, -86.001578");

    // The same place again is the same version: nothing new is written.
    await t.burst([atPin], readback());
    expect(await count(`order_versions WHERE order_id = ?`, view.orderId)).toBe(1);

    // Confirmed, the pin is still there (it becomes the customer's saved place); staff see the words.
    const confirmed = await t.engine.onCustomerAction(t.context(), confirmTap("cust-1", view));
    await save(confirmed);
    expect(orderIn(confirmed.outcome).fulfillment).toMatchObject({ mode: "delivery", pin });
    const card = (await t.engine.preparationList(t.context())).find((c) => c.order.orderId === view.orderId);
    expect(card?.order.fulfillment).toMatchObject({ mode: "delivery", placeText: "Ubicación compartida por WhatsApp: 15.611234, -86.001578" });
  });

  it("never says an order is confirmed when the ledger doesn't hold it, and saves nothing", async () => {
    const t = await plannedStore();
    const at = t.context("cust-ghost", { customerName: null } as Partial<CustomerContext>);
    // A conversation holding a read-back order and a Confirmar held for the name, with no such order in the ledger.
    const ghost: OrderView = {
      orderId: "order-ghost",
      version: 1,
      state: "por_confirmar",
      lines: [
        { lineId: "L1", text: "arroz", productId: t.id("arroz"), productName: "Arroz 1 lb", quantity: "2", unit: null, unitPrice: 1800, availability: "no_se", restricted: false, mark: null, substitute: null },
      ],
      fulfillment: { mode: "pickup" },
      total: 3600,
      queuePosition: null,
    };
    const memory = {
      snapshot: {
        orders: [["order-ghost", { customerId: "cust-ghost", customerName: null, confirmedAtMs: 0, changedLineIds: [], order: ghost }]],
        operations: [],
        drafts: [["order-ghost", { pending: [], names: [["L1", "arroz"]], shown: true, declinedSavedPlace: false }]],
        lastQuestion: [["cust-ghost", "customer_name"]],
        held: [["cust-ghost", { orderId: "order-ghost", version: 1, operationKey: "customer:cust-ghost:confirm:order-ghost:v1", asks: 1 }]],
      },
      ledger: null,
    };
    await env.DB.prepare(
      `INSERT INTO planner_memory (business_id, customer_id, order_id, version, state_json, updated_at_ms) VALUES (?, 'cust-ghost', 'order-ghost', 1, ?, 1)`,
    )
      .bind(t.businessId, JSON.stringify(memory))
      .run();

    const named = await t.engine.onBurst(at, { observations: [{ kind: "customer_name", name: "Maria", evidence, issues: [] } as unknown as Observation], calls: [] }, []);
    expect(named.outcome.type).toBe("rejected");
    expect(named.commits).toEqual([]);
    expect(await count(`orders WHERE business_id = ?`, t.businessId)).toBe(0);
    expect((await env.DB.prepare(`SELECT version FROM planner_memory WHERE customer_id = 'cust-ghost'`).first())?.version).toBe(1);
  });

  it("shows staff the ledger's total, delivery fee included, on the preparation list", async () => {
    const t = await plannedStore(3000);
    const read = await t.burst([order(item("arroz", "5")), delivery], readback(), [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }]);
    const view = orderIn(read.outcome);
    expect(view.total).toBe(9000); // the customer's readback: L 90 + L 30 de envío
    await save(await t.engine.onCustomerAction(t.context(), confirmTap("cust-1", view)));
    const card = (await t.engine.preparationList(t.context())).find((c) => c.order.orderId === view.orderId)!;
    expect(card.order.total).toBe(12000);
  });

  it("shows staff the name the customer gave on the preparation list, and none for a customer who gave none", async () => {
    const t = await plannedStore();
    const named = `cust-named-${crypto.randomUUID()}`;
    const nameless = `cust-nameless-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO customers (id, business_id, phone, name, name_saved_at_ms, created_at_ms) VALUES (?, ?, NULL, 'Marta', ?, ?)`).bind(named, t.businessId, T0, T0),
      env.DB.prepare(`INSERT INTO customers (id, business_id, phone, created_at_ms) VALUES (?, ?, NULL, ?)`).bind(nameless, t.businessId, T0),
    ]);
    const orderIds = new Map<string, string>();
    for (const customerId of [named, nameless]) {
      const read = await t.burst([order(item("arroz", "2")), pickup], readback(), [{ observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" }], t.context(customerId));
      const view = orderIn(read.outcome);
      await save(await t.engine.onCustomerAction(t.context(customerId), confirmTap(customerId, view)));
      orderIds.set(customerId, view.orderId);
    }
    const cards = await t.engine.preparationList(t.context());
    expect(cards.find((c) => c.order.orderId === orderIds.get(named))?.customerName).toBe("Marta");
    expect(cards.find((c) => c.order.orderId === orderIds.get(nameless))).toBeDefined();
    expect(cards.find((c) => c.order.orderId === orderIds.get(nameless))?.customerName).toBeNull();
  });

  it("with no stock left, the line reads back sold out and stays out of the total, as on the classic path", async () => {
    const t = await plannedStore();
    await setBalance(t.businessId, t.id("arroz"), 0);
    const read = await t.burst(
      [order(item("arroz", "2"), item("aceite", "1")), pickup],
      readback(),
      [
        { observation: 0, line: 0, productId: t.id("arroz"), how: "exact_name" },
        { observation: 0, line: 1, productId: t.id("clover"), how: "planner_pick" },
      ],
    );
    const view = orderIn(read.outcome);
    expect(view.lines.map((line) => line.availability)).toEqual(["se_acabo", "no_se"]);
    expect(view.total).toBe(6000);
    expect(renderOutcome(read.outcome, { customerId: "cust-1" })?.body).toContain("Arroz 1 lb: ahorita no hay.");
    const excluded = await env.DB.prepare(`SELECT excluded_from_total AS x FROM order_lines WHERE order_id = ? AND line_no = 1`).bind(view.orderId).first<{ x: number }>();
    expect(excluded?.x).toBe(1);
  });

  it("keeps the store's No hay out of the total when stock has no record of the product", async () => {
    const t = await plannedStore();
    const read = await t.burst(
      [order(item("leche", "1"), item("arroz", "2")), pickup],
      readback(),
      [
        { observation: 0, line: 0, productId: t.id("leche"), how: "exact_name" },
        { observation: 0, line: 1, productId: t.id("arroz"), how: "exact_name" },
      ],
    );
    const view = orderIn(read.outcome);
    expect(view.lines.map((line) => line.availability)).toEqual(["se_acabo", "no_se"]);
    expect(view.total).toBe(3600);
    expect((await env.DB.prepare(`SELECT total_centavos FROM order_versions WHERE order_id = ?`).bind(view.orderId).first())?.total_centavos).toBe(3600);
  });

  it("with less stock than asked, says how much there is, states no total and offers no Confirmar, as on the classic path", async () => {
    const t = await plannedStore();
    await setBalance(t.businessId, t.id("clover"), 1000);
    const read = await t.burst([order(item("aceite", "3")), pickup], readback(), [{ observation: 0, line: 0, productId: t.id("clover"), how: "planner_pick" }]);
    const view = orderIn(read.outcome);
    expect(view.lines[0]).toMatchObject({ availability: "hay", inStock: "1" });
    expect(view.total).toBeNull();
    const reply = renderOutcome(read.outcome, { customerId: "cust-1" })!;
    expect(reply.body).toContain("me aparecen 1.");
    expect(reply.buttons).toEqual([]);
    // The stock's question is what a silent turn says again, as on the classic path.
    expect((await t.engine.shortOrder(t.context()))?.lines[0]).toMatchObject({ inStock: "1" });
  });

  it("quotes only a price the owner confirmed: a legacy Tienda price is not read back, saved or counted", async () => {
    const t = await plannedStore();
    const read = await t.burst(
      [order(item("sal", "2"), item("arroz", "1")), pickup],
      readback(),
      [
        { observation: 0, line: 0, productId: t.id("sal"), how: "exact_name" },
        { observation: 0, line: 1, productId: t.id("arroz"), how: "exact_name" },
      ],
    );
    const view = orderIn(read.outcome);
    expect(view.lines.map((line) => [line.productName, line.unitPrice])).toEqual([
      ["Sal 1 lb", null],
      ["Arroz 1 lb", 1800],
    ]);
    expect(view.total).toBeNull();
    const body = renderOutcome(read.outcome, { customerId: "cust-1" })!.body;
    expect(body).not.toContain("L 8");
    expect(body).not.toContain("L 16");
    const saved = await env.DB.prepare(`SELECT line_no, unit_price_centavos AS price FROM order_lines WHERE order_id = ? ORDER BY line_no`).bind(view.orderId).all();
    expect(saved.results).toEqual([
      { line_no: 1, price: null },
      { line_no: 2, price: 1800 },
    ]);
    expect((await env.DB.prepare(`SELECT total_centavos FROM order_versions WHERE order_id = ?`).bind(view.orderId).first())?.total_centavos).toBeNull();
    // Asked for, the legacy price isn't said either, and its claim doesn't hold.
    const asked = await t.burst([priceQuestion("sal")], null, [{ observation: 0, line: 0, productId: t.id("sal"), how: "exact_name" }]);
    expect(asked.outcome).toMatchObject({ type: "answer", facts: [{ productId: t.id("sal"), unitPrice: null }] });
    expect(await t.engine.verifyClaims(t.context(), [{ type: "unit_price", productId: t.id("sal"), price: 800 }, { type: "unit_price", productId: t.id("arroz"), price: 1800 }])).toEqual([false, true]);
    expect(await t.engine.catalog(t.context())).toEqual(expect.arrayContaining([expect.objectContaining({ productId: t.id("sal") })]));
  });
});

async function setBalance(businessId: string, productId: string, qtyMilli: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO stock_balances (business_id, product_id, qty_milli, updated_at_ms) VALUES (?1, ?2, ?3, 0)
     ON CONFLICT (business_id, product_id) DO UPDATE SET qty_milli = ?3`,
  )
    .bind(businessId, productId, qtyMilli)
    .run();
}
