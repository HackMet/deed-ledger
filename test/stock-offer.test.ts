import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BurstReading } from "../src/domain/contract/observation";
import type { Claim, OrderLineView, OrderView } from "../src/domain/contract/outcomes";
import { firstCheck, flattenClaims, renderOutcome } from "../src/domain/replies";
import { stockVerdict } from "../src/domain/stock-offer";
import { OrderEngine } from "../src/application/engine/order-engine";
import { createOrderHandler, type OrderHandlerDeps } from "../src/application/order-handler";
import type { JobInput } from "../src/application/ports";
import { D1FactLedger } from "../src/infrastructure/d1/fact-ledger";
import { D1StockBalances } from "../src/infrastructure/d1/stock-balances";
import { ids, readbackOrder } from "./fixtures/contract";
import { count, firstPickupOrder, newStore, save, store, T0, tap } from "./helpers/orders";
import { newPhone, seedStore } from "./helpers/seed";

const engine = new OrderEngine({ store, ids: { newId: () => crypto.randomUUID() }, ledger: new D1FactLedger(env.DB), stock: new D1StockBalances(env.DB) });

const matched = { productId: "p", restricted: false };

describe("the stock rule", () => {
  it("no record, an unmatched line and a restricted line are unknown: absent is never zero", () => {
    expect(stockVerdict({ ...matched, quantity: "3" }, null)).toBe("unknown");
    expect(stockVerdict({ ...matched, productId: null, quantity: "3" }, 0)).toBe("unknown");
    expect(stockVerdict({ ...matched, restricted: true, quantity: "3" }, 0)).toBe("unknown");
  });

  it("at least the quantity is enough, exactly the quantity included", () => {
    expect(stockVerdict({ ...matched, quantity: "3" }, 3000)).toBe("enough");
    expect(stockVerdict({ ...matched, quantity: "3" }, 3001)).toBe("enough");
  });

  it("zero is sold out, even with no quantity said", () => {
    expect(stockVerdict({ ...matched, quantity: "3" }, 0)).toBe("sold_out");
    expect(stockVerdict({ ...matched, quantity: null }, 0)).toBe("sold_out");
  });

  it("above zero and under the quantity is short", () => {
    expect(stockVerdict({ ...matched, quantity: "3" }, 2999)).toBe("short");
    expect(stockVerdict({ ...matched, quantity: "3" }, 1)).toBe("short");
  });

  it("compares decimals exactly", () => {
    expect(stockVerdict({ ...matched, quantity: "0.1" }, 100)).toBe("enough");
    expect(stockVerdict({ ...matched, quantity: "1.25" }, 1250)).toBe("enough");
    expect(stockVerdict({ ...matched, quantity: "1.251" }, 1250)).toBe("short");
    expect(stockVerdict({ ...matched, quantity: "1.5" }, 1499)).toBe("short");
  });

  it("with no quantity or an unreadable one there's nothing to compare: unknown, not a guess", () => {
    expect(stockVerdict({ ...matched, quantity: null }, 5000)).toBe("unknown");
    expect(stockVerdict({ ...matched, quantity: "tres" }, 5000)).toBe("unknown");
  });
});

const CUSTOMER = { customerId: ids.customer };
const withLine = (line: Partial<OrderLineView>): OrderView => ({
  ...readbackOrder,
  lines: [{ ...readbackOrder.lines[0]!, ...line }, ...readbackOrder.lines.slice(1)],
  total: null,
});
const replyTo = (order: OrderView) => {
  const reply = renderOutcome({ type: "readback", order }, CUSTOMER);
  if (reply === null) throw new Error("expected a reply");
  return reply;
};

describe("the readback's stock copy", () => {
  it("asks one question about the first short line, with the typed way and no buttons, and claims the amount", () => {
    const productId = readbackOrder.lines[0]!.productId!;
    const order: OrderView = {
      ...readbackOrder,
      lines: [
        { ...readbackOrder.lines[0]!, quantity: "5", unit: null, availability: "hay", inStock: "2" },
        { ...readbackOrder.lines[1]!, quantity: "3", unit: "libra", availability: "hay", inStock: "1.5" },
      ],
      total: null,
    };
    const reply = replyTo(order);
    expect(reply.body).toContain("me aparecen 2.");
    expect(reply.body).toContain("me aparecen 1.5 libras.");
    expect(reply.body).toContain("ahorita me aparecen 2. ¿Te mando 2 o lo quitamos?\nEscribime 2 o quitar.");
    expect(reply.body.match(/¿/g)).toHaveLength(1);
    expect(reply.buttons).toEqual([]);
    expect(flattenClaims(reply.claims)).toContainEqual({ type: "availability", productId, availability: "hay", inStock: "2" });
    expect(firstCheck(reply.claims, { kind: "outcome", outcome: { type: "readback", order }, customerId: ids.customer })).toBe(true);
  });

  it("the first check refuses an amount the order doesn't show", () => {
    const order = withLine({ quantity: "5", availability: "hay", inStock: "2" });
    const claims = [{ anyOf: [{ type: "availability", productId: order.lines[0]!.productId!, availability: "hay", inStock: "3" } satisfies Claim] }];
    expect(firstCheck(claims, { kind: "outcome", outcome: { type: "readback", order }, customerId: ids.customer })).toBe(false);
  });

  it("offers what's left after a sold-out line, with the buttons", () => {
    const reply = replyTo(withLine({ availability: "se_acabo" }));
    expect(reply.body).toContain("ahorita no hay.");
    expect(reply.body).toContain("¿Te lo preparo así?");
    expect(reply.buttons.map((button) => button.title)).toEqual(["Confirmar", "Corregir", "Cancelar"]);
  });

  it("with nothing left, offers nothing to confirm and gives the typed way out", () => {
    const order: OrderView = { ...readbackOrder, lines: readbackOrder.lines.map((line) => ({ ...line, availability: "se_acabo" as const })), total: null };
    const reply = replyTo(order);
    expect(reply.body).toContain("¿Qué más te mando? Si no querés nada más, respondé Cancelar.");
    expect(reply.body).not.toContain("💵");
    expect(reply.buttons).toEqual([]);
  });

  it("never shows a score or says stock is complete", () => {
    const { body } = replyTo(withLine({ quantity: "5", availability: "hay", inStock: "2" }));
    expect(body).not.toMatch(/%|solo hay|todo lo que|completo/iu);
  });
});

/** The store with balances of its own: a product's id, for the quantities in the first order. */
async function stocked(balances: { arroz?: number; jabon?: number; azucar?: number }) {
  const s = await newStore();
  const [arroz, jabon, azucar] = s.matches.map((match) => match.productId) as [string, string, string];
  const rows: [string, number | undefined][] = [
    [arroz, balances.arroz],
    [jabon, balances.jabon],
    [azucar, balances.azucar],
  ];
  for (const [productId, qty] of rows) if (qty !== undefined) await setBalance(s.businessId, productId, qty);
  return { ...s, arroz, jabon, azucar };
}

async function setBalance(businessId: string, productId: string, qtyMilli: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO stock_balances (business_id, product_id, qty_milli, updated_at_ms) VALUES (?1, ?2, ?3, 0)
     ON CONFLICT (business_id, product_id) DO UPDATE SET qty_milli = ?3`,
  )
    .bind(businessId, productId, qtyMilli)
    .run();
}

const stockRows = async (businessId: string) => ({
  balances: (await env.DB.prepare(`SELECT product_id, qty_milli, updated_at_ms FROM stock_balances WHERE business_id = ? ORDER BY product_id`).bind(businessId).all()).results,
  movements: await count(`stock_movements WHERE business_id = ?`, businessId),
});

const edit = (ref: string, quantity: string | null): BurstReading => ({
  observations: [
    {
      kind: "order_change",
      edits: [
        quantity === null
          ? { op: "remove", target: { ref, said: "eso" }, evidence: { source: "text", message: 0, start: 0, end: 3 } }
          : { op: "set_quantity", target: { ref, said: "eso" }, quantity, evidence: { source: "text", message: 0, start: 0, end: 3 } },
      ],
      issues: [],
    },
  ],
  calls: [],
});

async function place(s: Awaited<ReturnType<typeof stocked>>, nowMs = T0): Promise<OrderView> {
  const result = await engine.onBurst(s.context({ nowMs }), firstPickupOrder, s.matches);
  if (result.outcome.type !== "readback") throw new Error(`expected readback, got ${result.outcome.type}`);
  await save(result);
  return result.outcome.order;
}

const lineOf = (order: OrderView, lineId: string) => order.lines.find((line) => line.lineId === lineId)!;

describe("the readback with the store's stock, on local D1", () => {
  // The first order: L1 unmatched, L2 3 libras of arroz, L3 3 jabones, L4 2 libras of azúcar.
  it("no row and an unmatched line stay unknown, exactly as today", async () => {
    const s = await stocked({});
    const order = await place(s);
    expect(order.lines.map((line) => line.availability)).toEqual(["no_se", "no_se", "no_se", "no_se"]);
    expect(order.lines.some((line) => "inStock" in line)).toBe(false);
    expect(renderOutcome({ type: "readback", order }, CUSTOMER)?.body).toContain("¿Te lo preparo así?");
    expect((await store.openOrder(s.context(), ids.customer))?.view).toEqual(order);
  });

  it("at least the quantity is hay, and the reply is as without a record", async () => {
    const s = await stocked({ arroz: 3000, jabon: 9000, azucar: 2000 });
    const order = await place(s);
    expect(order.lines.map((line) => line.availability)).toEqual(["no_se", "hay", "hay", "hay"]);

    const known = renderOutcome({ type: "readback", order }, CUSTOMER)!;
    const unknown = renderOutcome({ type: "readback", order: { ...order, lines: order.lines.map((line) => ({ ...line, availability: "no_se" as const })) } }, CUSTOMER)!;
    expect(known).toEqual(unknown);
  });

  it("zero is se_acabo: said, kept out of the total, and still sold out when read back", async () => {
    const s = await stocked({ arroz: 0 });
    const order = await place(s);
    expect(lineOf(order, "L2").availability).toBe("se_acabo");
    const reply = renderOutcome({ type: "readback", order }, CUSTOMER)!;
    expect(reply.body).toContain(`${lineOf(order, "L2").productName}: ahorita no hay.`);
    expect(reply.body).toContain("¿Te lo preparo así?");
    expect((await store.openOrder(s.context(), ids.customer))?.view).toEqual(order);
    expect((await env.DB.prepare(`SELECT excluded_from_total AS x FROM order_lines WHERE order_id = ? AND line_no = 2`).bind(order.orderId).first<{ x: number }>())?.x).toBe(1);
  });

  it("under the quantity tells how much there is, never changes the line, and the claim holds", async () => {
    const s = await stocked({ jabon: 1500 });
    const order = await place(s);
    const line = lineOf(order, "L3");
    expect(line).toMatchObject({ availability: "hay", quantity: "3", inStock: "1.5" });

    const reply = renderOutcome({ type: "readback", order }, CUSTOMER)!;
    expect(reply.body).toContain(`ahorita me aparecen 1.5. ¿Te mando 1.5 o lo quitamos?`);
    expect(reply.buttons).toEqual([]);
    expect(firstCheck(reply.claims, { kind: "outcome", outcome: { type: "readback", order }, customerId: ids.customer })).toBe(true);
    expect((await engine.verifyClaims(s.context(), flattenClaims(reply.claims))).every(Boolean)).toBe(true);

    const row = await env.DB.prepare(`SELECT qty_milli FROM order_lines WHERE order_id = ? AND line_no = 3`).bind(order.orderId).first<{ qty_milli: number }>();
    expect(row?.qty_milli).toBe(3000);
  });

  it("a quantity in decimals is compared exactly", async () => {
    const s = await stocked({ arroz: 3000 });
    await place(s);
    const more = await engine.onBurst(s.context({ nowMs: T0 + 1, jobId: "more" }), edit("L2", "3.001"), []);
    if (more.outcome.type !== "readback") throw new Error(more.outcome.type);
    expect(lineOf(more.outcome.order, "L2")).toMatchObject({ availability: "hay", quantity: "3.001", inStock: "3" });
    await save(more);
    const exact = await engine.onBurst(s.context({ nowMs: T0 + 2, jobId: "exact" }), edit("L2", "2.999"), []);
    if (exact.outcome.type !== "readback") throw new Error(exact.outcome.type);
    expect(lineOf(exact.outcome.order, "L2").availability).toBe("hay");
    expect(lineOf(exact.outcome.order, "L2").inStock).toBeUndefined();
  });

  it("a customer takes the lesser amount: a new version, read back, and only their confirm commits it", async () => {
    const s = await stocked({ jabon: 2000 });
    const v1 = await place(s);
    expect(lineOf(v1, "L3").inStock).toBe("2");

    const context = await engine.perceptionContext(s.context());
    expect(context.pendingQuestion).toBe("quantity");
    expect(context.openOrder?.lines[2]?.text).toContain("(solo hay 2)");

    const took = await engine.onBurst(s.context({ nowMs: T0 + 1, jobId: "esas-dos" }), edit("L3", "2"), []);
    if (took.outcome.type !== "readback") throw new Error(took.outcome.type);
    const v2 = took.outcome.order;
    expect(v2.version).toBe(2);
    expect(lineOf(v2, "L3")).toMatchObject({ availability: "hay", quantity: "2" });
    expect(lineOf(v2, "L3").inStock).toBeUndefined();
    await save(took);
    expect((await engine.perceptionContext(s.context())).pendingQuestion).toBeNull();

    const confirmed = await engine.onCustomerAction(s.context({ nowMs: T0 + 2, jobId: "confirm" }), tap(v2.orderId, 2));
    expect(confirmed.outcome.type).toBe("order_confirmed");
    await save(confirmed);
    const row = await env.DB.prepare(`SELECT o.state, l.qty_milli FROM orders o JOIN order_lines l ON l.order_id = o.id AND l.version = o.current_version WHERE o.id = ? AND l.line_no = 3`)
      .bind(v2.orderId)
      .first();
    expect(row).toEqual({ state: "confirmado", qty_milli: 2000 });
  });

  it("a customer leaves it out: the line goes, and the rest reads back", async () => {
    const s = await stocked({ jabon: 2000 });
    await place(s);
    const left = await engine.onBurst(s.context({ nowMs: T0 + 1, jobId: "quitar" }), edit("L3", null), []);
    if (left.outcome.type !== "readback") throw new Error(left.outcome.type);
    expect(left.outcome.order.lines).toHaveLength(3);
    expect(left.outcome.order.lines.some((line) => line.inStock !== undefined)).toBe(false);
  });

  describe("an answer read as the prompt asks: a clarification", () => {
    const answered = (answer: string, quantity: string | null): BurstReading => ({
      observations: [{ kind: "clarification", answer, pick: null, quantity, evidence: { source: "text", message: 0, start: 0, end: answer.length }, issues: [] }],
      calls: [],
    });
    const say = (s: Awaited<ReturnType<typeof stocked>>, answer: string, quantity: string | null = null) =>
      engine.onBurst(s.context({ nowMs: T0 + 1, jobId: `answer-${answer}` }), answered(answer, quantity), []);

    it.each([
      ["esas 2", "2"],
      ["esas 2", null],
      ["sí", null],
      ["dale, mandame esas", null],
      ["mejor 1", "1"],
    ])("%s (quantity %s) takes that amount as a new version, and only the customer's confirm commits it", async (words, quantity) => {
      const s = await stocked({ jabon: 2000 });
      const v1 = await place(s);
      const took = await say(s, words, quantity);
      if (took.outcome.type !== "readback") throw new Error(took.outcome.type);
      const v2 = took.outcome.order;
      expect(v2.version).toBe(2);
      expect(lineOf(v2, "L3")).toMatchObject({ availability: "hay", quantity: quantity ?? "2" });
      expect(lineOf(v2, "L3").inStock).toBeUndefined();
      await save(took);
      const row = () => env.DB.prepare(`SELECT o.state, l.qty_milli FROM orders o JOIN order_lines l ON l.order_id = o.id AND l.version = o.current_version WHERE o.id = ? AND l.line_no = 3`).bind(v1.orderId).first();
      expect(await row()).toEqual({ state: "por_confirmar", qty_milli: Number(quantity ?? "2") * 1000 });
      await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 2, jobId: "c" }), tap(v2.orderId, 2)));
      expect(await row()).toEqual({ state: "confirmado", qty_milli: Number(quantity ?? "2") * 1000 });
    });

    it.each(["quitar", "quitalo", "no lo quiero"])("%s removes the line", async (words) => {
      const s = await stocked({ jabon: 2000 });
      const v1 = await place(s);
      const left = await say(s, words);
      if (left.outcome.type !== "readback") throw new Error(left.outcome.type);
      expect(left.outcome.order.version).toBe(2);
      expect(left.outcome.order.lines.map((line) => line.productId)).toEqual(v1.lines.filter((line) => line.lineId !== "L3").map((line) => line.productId));
    });

    it.each([
      ["mmm no sé", null],
      ["no", null],
      ["no, esas no", null],
      ["no lo quites", null],
      ["5", "5"],
    ])("%s (quantity %s) can't be read as an answer: nothing saved, the same question again", async (words, quantity) => {
      const s = await stocked({ jabon: 2000 });
      const v1 = await place(s);
      const again = await say(s, words, quantity);
      expect(again.commits).toEqual([]);
      expect(again.outcome.type).toBe("readback");
      if (again.outcome.type !== "readback") return;
      expect(again.outcome.order).toMatchObject({ version: 1, orderId: v1.orderId });
      const reply = renderOutcome(again.outcome, CUSTOMER)!;
      expect(reply.body).toContain("ahorita me aparecen 2. ¿Te mando 2 o lo quitamos?");
      expect(reply.body).not.toContain("¿Cuántos");
      expect(reply.buttons).toEqual([]);
    });

    it("the second short line is asked next, one at a time", async () => {
      const s = await stocked({ arroz: 1000, jabon: 2000 });
      await place(s);
      const took = await say(s, "sí");
      if (took.outcome.type !== "readback") throw new Error(took.outcome.type);
      expect(lineOf(took.outcome.order, "L2")).toMatchObject({ quantity: "1" });
      expect(lineOf(took.outcome.order, "L3").inStock).toBe("2");
      expect(renderOutcome(took.outcome, CUSTOMER)!.body).toContain("ahorita me aparecen 2. ¿Te mando 2 o lo quitamos?");
    });

    it("with no short line a clarification changes nothing: the same version is read back", async () => {
      const s = await stocked({ jabon: 9000 });
      const v1 = await place(s);
      const outcome = await say(s, "sí");
      expect(outcome.outcome).toMatchObject({ type: "readback", order: { orderId: v1.orderId, version: 1 } });
      expect(outcome.commits).toEqual([]);
    });

    it("the handler's never-silent fallback restates stock's question, never ¿Cuántos querés?", async () => {
      const s = await stocked({ jabon: 2000 });
      await place(s);
      const context = s.context();
      const handler = createOrderHandler({
        engine,
        jobs: { unreadBurst: async () => [] },
        customers: { ofConversation: async () => ({ id: ids.customer, name: "Ana", nameAskedAtMs: null, lastReadback: null }) },
        clock: { now: () => T0 + 1 },
        log: { info: () => {}, warn: () => {}, error: () => {} },
        pendientes: { raise: async () => {} },
        reader: { read: async () => { throw new Error("not read"); } },
      } as unknown as OrderHandlerDeps);
      const { replies } = await handler.handle({
        lease: { businessId: context.businessId, conversationId: context.conversationId },
        job: { id: "j", kind: "text", textBody: "x", receivedAtMs: T0 + 1, attempts: 0 },
        isNewestOfBurst: true,
      } as unknown as JobInput);
      expect(replies).toHaveLength(1);
      expect(replies[0]!.body).toContain("ahorita me aparecen 2. ¿Te mando 2 o lo quitamos?");
      expect(replies[0]!.claims).toBeDefined();
    });
  });

  it("a stale tap reads back the stock question, with no Confirmar", async () => {
    const s = await stocked({ jabon: 9000 });
    const v1 = await place(s);
    await save(await engine.onBurst(s.context({ nowMs: T0 + 1, jobId: "ten" }), edit("L3", "10"), []));

    const stale = await engine.onCustomerAction(s.context({ nowMs: T0 + 2, jobId: "old-tap" }), tap(v1.orderId, 1));
    if (stale.outcome.type !== "rejected") throw new Error(stale.outcome.type);
    expect(stale.outcome.reason).toBe("stale_version");
    const reply = renderOutcome(stale.outcome, CUSTOMER)!;
    expect(reply.body).toContain("Tu pedido cambió desde ese mensaje.");
    expect(reply.body).toContain("ahorita me aparecen 9. ¿Te mando 9 o lo quitamos?");
    expect(reply.buttons).toEqual([]);
    expect(firstCheck(reply.claims, { kind: "outcome", outcome: stale.outcome, customerId: ids.customer })).toBe(true);
    expect((await engine.verifyClaims(s.context(), flattenClaims(reply.claims))).every(Boolean)).toBe(true);
  });

  it("a stale tap with enough stock still reads back as before, with the buttons", async () => {
    const s = await stocked({ jabon: 9000 });
    const v1 = await place(s);
    await save(await engine.onBurst(s.context({ nowMs: T0 + 1, jobId: "four" }), edit("L3", "4"), []));
    const stale = await engine.onCustomerAction(s.context({ nowMs: T0 + 2, jobId: "old-tap" }), tap(v1.orderId, 1));
    expect(renderOutcome(stale.outcome, CUSTOMER)!.buttons.map((button) => button.title)).toEqual(["Confirmar", "Corregir", "Cancelar"]);
  });

  describe("nothing to prepare is never confirmed", () => {
    const sold = "¿Qué más te mando? Si no querés nada más, respondé Cancelar.";
    const confirmTry = async (s: Awaited<ReturnType<typeof stocked>>, order: OrderView) => {
      const tried = await engine.onCustomerAction(s.context({ nowMs: T0 + 9, jobId: "try" }), tap(order.orderId, order.version));
      expect(tried.commits).toEqual([]);
      if (tried.outcome.type !== "readback") throw new Error(tried.outcome.type);
      const reply = renderOutcome(tried.outcome, CUSTOMER)!;
      expect(reply.body).toContain(sold);
      expect(reply.body).not.toContain("quedó anotado");
      expect(reply.buttons).toEqual([]);
      expect((await store.openOrder(s.context(), ids.customer))?.view).toMatchObject({ state: "por_confirmar", version: order.version });
    };
    const removeAll = (labels: readonly string[]): BurstReading => ({
      observations: [
        {
          kind: "order_change",
          edits: labels.map((ref) => ({ op: "remove" as const, target: { ref, said: "eso" }, evidence: { source: "text" as const, message: 0, start: 0, end: 3 } })),
          issues: [],
        },
      ],
      calls: [],
    });

    it("an order with no lines: it asks what else, and offers no Confirmar", async () => {
      const s = await stocked({});
      await place(s);
      const emptied = await engine.onBurst(s.context({ nowMs: T0 + 1, jobId: "all" }), removeAll(["L1", "L2", "L3", "L4"]), []);
      if (emptied.outcome.type !== "readback") throw new Error(emptied.outcome.type);
      await save(emptied);
      const reply = renderOutcome(emptied.outcome, CUSTOMER)!;
      expect(reply.body).toBe(sold);
      expect(reply.buttons).toEqual([]);
      await confirmTry(s, emptied.outcome.order);
    });

    it("an order with only sold-out lines", async () => {
      const s = await stocked({ arroz: 0, jabon: 0, azucar: 0 });
      await place(s);
      const out = await engine.onBurst(s.context({ nowMs: T0 + 1, jobId: "unmatched" }), removeAll(["L1"]), []);
      if (out.outcome.type !== "readback") throw new Error(out.outcome.type);
      await save(out);
      await confirmTry(s, out.outcome.order);
    });

    it("stock that sold out after the readback", async () => {
      const s = await stocked({ arroz: 5000, jabon: 5000, azucar: 5000 });
      await place(s);
      const out = await engine.onBurst(s.context({ nowMs: T0 + 1, jobId: "unmatched" }), removeAll(["L1"]), []);
      if (out.outcome.type !== "readback") throw new Error(out.outcome.type);
      await save(out);
      for (const productId of [s.arroz, s.jabon, s.azucar]) await setBalance(s.businessId, productId, 0);
      await confirmTry(s, out.outcome.order);
    });

    it("a sold-out line beside another line still confirms", async () => {
      const s = await stocked({ arroz: 0 });
      const order = await place(s);
      const confirmed = await engine.onCustomerAction(s.context({ nowMs: T0 + 1, jobId: "c" }), tap(order.orderId, 1));
      expect(confirmed.outcome.type).toBe("order_confirmed");
    });
  });

  it("a balance that changes before the confirm: the reply's claim stops holding, the version's guards decide", async () => {
    const s = await stocked({ jabon: 2000 });
    const v1 = await place(s);
    const reply = renderOutcome({ type: "readback", order: v1 }, CUSTOMER)!;
    const claims = flattenClaims(reply.claims);

    await setBalance(s.businessId, s.jabon, 1000);
    // The second check, right before sending: the amount in the reply isn't the records' anymore.
    expect(await engine.verifyClaims(s.context(), claims)).toContain(false);

    // Confirming the exact version they saw isn't refused by stock, and writes no stock.
    const before = await stockRows(s.businessId);
    const confirmed = await engine.onCustomerAction(s.context({ nowMs: T0 + 1, jobId: "c" }), tap(v1.orderId, 1));
    expect(confirmed.outcome.type).toBe("order_confirmed");
    await save(confirmed);
    expect(await stockRows(s.businessId)).toEqual(before);
  });

  it("a confirm decided before a newer version landed fails the commit's own guards", async () => {
    const s = await stocked({ jabon: 2000 });
    const v1 = await place(s);
    const confirm = await engine.onCustomerAction(s.context({ nowMs: T0 + 1, jobId: "race" }), tap(v1.orderId, 1));
    expect(confirm.outcome.type).toBe("order_confirmed");
    await save(await engine.onBurst(s.context({ nowMs: T0 + 2, jobId: "newer" }), edit("L3", "2"), []));
    await expect(save(confirm)).rejects.toThrow();
    expect((await store.openOrder(s.context(), ids.customer))?.view).toMatchObject({ version: 2, state: "por_confirmar" });
  });

  it("a restock shows on the next version: a sold-out line takes what's there now", async () => {
    const s = await stocked({ arroz: 0 });
    await place(s);
    await setBalance(s.businessId, s.arroz, 5000);
    const next = await engine.onBurst(s.context({ nowMs: T0 + 1, jobId: "next" }), edit("L3", "1"), []);
    if (next.outcome.type !== "readback") throw new Error(next.outcome.type);
    expect(lineOf(next.outcome.order, "L2").availability).toBe("hay");
  });

  it("another store's balance is ignored", async () => {
    const s = await stocked({});
    const other = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    await setBalance(other.businessId, s.jabon, 0);
    await setBalance(other.businessId, s.arroz, 1000);
    const order = await place(s);
    expect(order.lines.map((line) => line.availability)).toEqual(["no_se", "no_se", "no_se", "no_se"]);
    expect(await engine.verifyClaims(s.context(), [{ type: "availability", productId: s.jabon, availability: "se_acabo" }])).toEqual([false]);
  });

  it("reading writes no stock row", async () => {
    const s = await stocked({ arroz: 0, jabon: 1000, azucar: 9000 });
    const before = await stockRows(s.businessId);
    const order = await place(s);
    await engine.perceptionContext(s.context());
    await engine.verifyClaims(s.context(), [{ type: "availability", productId: s.arroz, availability: "se_acabo" }]);
    const confirmed = await engine.onCustomerAction(s.context({ nowMs: T0 + 1, jobId: "c2" }), tap(order.orderId, 1));
    await save(confirmed);
    expect(await stockRows(s.businessId)).toEqual(before);
    expect(before.movements).toBe(0);
    expect(before.balances).toHaveLength(3);
  });

  it("an availability claim holds only on a record of this store", async () => {
    const s = await stocked({ arroz: 0, jabon: 2000 });
    const verify = (claim: Claim) => engine.verifyClaims(s.context(), [claim]);
    expect(await verify({ type: "availability", productId: s.arroz, availability: "se_acabo" })).toEqual([true]);
    expect(await verify({ type: "availability", productId: s.arroz, availability: "hay" })).toEqual([false]);
    expect(await verify({ type: "availability", productId: s.jabon, availability: "hay" })).toEqual([true]);
    expect(await verify({ type: "availability", productId: s.jabon, availability: "hay", inStock: "2" })).toEqual([true]);
    expect(await verify({ type: "availability", productId: s.jabon, availability: "hay", inStock: "2.001" })).toEqual([false]);
    // No row: absent is never zero, and never "hay".
    expect(await verify({ type: "availability", productId: s.azucar, availability: "se_acabo" })).toEqual([false]);
    expect(await verify({ type: "availability", productId: s.azucar, availability: "hay" })).toEqual([false]);
  });
});
