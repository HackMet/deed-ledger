import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ActionEnvelope, ConsoleAction, CustomerAction } from "../src/domain/contract/actions";
import type { Claim } from "../src/domain/contract/outcomes";
import { OrderEngine, staffKey } from "../src/application/engine/order-engine";
import type { DeedChecks } from "../src/application/engine/deed-checks";
import { priceKey } from "../src/domain/price";
import { D1DeedChecks, D1DeedReads } from "../src/infrastructure/d1/deed-checks";
import { D1FactLedger } from "../src/infrastructure/d1/fact-ledger";
import { firstOrder, ids } from "./fixtures/contract";
import { T0, count, newStore, placeFirstOrder, reviewer, save, store, tap } from "./helpers/orders";

const checked = (checks: DeedChecks = new D1DeedChecks(env.DB)) =>
  new OrderEngine({ store, ids: { newId: () => crypto.randomUUID() }, ledger: new D1FactLedger(env.DB), checks, clock: { now: () => T0 } });

/** The rows a store has, oldest first, without the ids (which are random). */
const rowsOf = async (businessId: string) =>
  (
    await env.DB.prepare(
      `SELECT source, result, reason_code, order_id, claim_kind, deciding_fact_id, operation_key FROM deed_checks
       WHERE business_id = ? ORDER BY at_ms, rowid`,
    )
      .bind(businessId)
      .all<{
        source: string;
        result: string;
        reason_code: string | null;
        order_id: string | null;
        claim_kind: string | null;
        deciding_fact_id: string | null;
        operation_key: string | null;
      }>()
  ).results;

const cancelTap = (orderId: string, version: number): ActionEnvelope<CustomerAction> => ({
  ...tap(orderId, version),
  operationKey: `cancel:${orderId}:v${version}`,
  action: { type: "cancel_order", orderId, version },
});

describe("the Deed's checks: one row per decision the engine refuses or verifies", () => {
  it("writes one pass and one fail row for claims, one row per claim, with the claim's kind and order", async () => {
    const s = await newStore();
    const order = await placeFirstOrder(s);
    const claims: Claim[] = [
      { type: "order_state", orderId: order.orderId, version: 1, state: "por_confirmar" },
      { type: "order_state", orderId: order.orderId, version: 1, state: "cancelado" },
    ];
    expect(await checked().verifyClaims(s, claims)).toEqual([true, false]);
    expect(await rowsOf(s.businessId)).toEqual([
      expect.objectContaining({ source: "verify_claims", result: "pass", reason_code: null, claim_kind: "order_state", order_id: order.orderId }),
      expect.objectContaining({ source: "verify_claims", result: "fail", reason_code: "not_backed", claim_kind: "order_state", order_id: order.orderId }),
    ]);
  });

  it("records a duplicate of a saved key as duplicate_key, and a stale version as stale_version", async () => {
    const s = await newStore();
    const order = await placeFirstOrder(s);
    const engine = checked();
    const confirm = tap(order.orderId, 1);
    await save(await engine.onCustomerAction(s.context(), confirm));
    expect((await engine.onCustomerAction(s.context(), confirm)).outcome.type).toBe("duplicate");
    const stale = tap(order.orderId, 9);
    expect((await engine.onCustomerAction(s.context(), stale)).outcome).toMatchObject({ type: "rejected", reason: "stale_version" });
    expect(await rowsOf(s.businessId)).toEqual([
      expect.objectContaining({ source: "duplicate_key", result: "fail", reason_code: "duplicate", order_id: order.orderId, operation_key: confirm.operationKey }),
      expect.objectContaining({ source: "stale_version", result: "fail", reason_code: "stale_version", order_id: order.orderId }),
    ]);
  });

  it("records a confirm on a cancelled order as a gate refusal, naming the cancel that decided it", async () => {
    const s = await newStore();
    const order = await placeFirstOrder(s);
    const engine = checked();
    await save(await engine.onCustomerAction(s.context(), cancelTap(order.orderId, 1)));
    const cancel = await env.DB.prepare(`SELECT id FROM facts WHERE business_id = ? AND kind = 'order_cancel'`).bind(s.businessId).first<{ id: string }>();
    const refused = await engine.onCustomerAction(s.context(), tap(order.orderId, 1));
    expect(refused.outcome).toMatchObject({ type: "rejected", reason: "invalid_state" });
    expect(await rowsOf(s.businessId)).toEqual([
      expect.objectContaining({ source: "gate", reason_code: "invalid_state", order_id: order.orderId, deciding_fact_id: cancel?.id }),
    ]);
  });

  it("records a key the engine didn't derive, an unknown order and a foreign actor as not_allowed or not_found", async () => {
    const s = await newStore();
    const order = await placeFirstOrder(s);
    const engine = checked();
    const foreign = { ...tap(order.orderId, 1), actor: { type: "customer" as const, customerId: "someone-else" } };
    expect((await engine.onCustomerAction(s.context(), foreign)).outcome).toMatchObject({ type: "rejected", reason: "not_allowed" });
    const missing = tap("no-such-order", 1);
    expect((await engine.onCustomerAction(s.context(), missing)).outcome).toMatchObject({ type: "rejected", reason: "not_found" });
    expect(await rowsOf(s.businessId)).toEqual([
      expect.objectContaining({ source: "not_allowed", reason_code: "not_allowed", order_id: null }),
      expect.objectContaining({ source: "not_found", reason_code: "not_found", order_id: null }),
    ]);
  });

  it("never writes a typed name or phone number into the key or the order id, for any writer", async () => {
    const s = await newStore();
    const other = await newStore();
    const order = await placeFirstOrder(s);
    const engine = checked();
    const typed = "Maria Lopez 50499998888";
    // A customer's typed key on a real order, and the same text as the order id.
    expect((await engine.onCustomerAction(s.context(), { ...tap(order.orderId, 1), operationKey: typed })).outcome).toMatchObject({
      type: "rejected",
      reason: "not_allowed",
    });
    expect((await engine.onCustomerAction(s.context(), { ...tap(typed, 1), operationKey: typed })).outcome).toMatchObject({
      type: "rejected",
      reason: "not_found",
    });
    // A claim whose order id is the text.
    expect(await engine.verifyClaims(s, [{ type: "order_state", orderId: typed, version: 1, state: "por_confirmar" }])).toEqual([false]);
    // A staff member's typed key on a real order, and a store's member who names another store's order under its own key.
    const staff = (orderId: string, operationKey: string): ActionEnvelope<ConsoleAction> => ({
      operationKey,
      actor: { type: "member", memberId: ids.staff, role: "owner" },
      action: { type: "start_preparing", orderId, version: 1 },
    });
    expect((await engine.onConsoleAction(reviewer(s), staff(order.orderId, typed))).outcome).toMatchObject({ reason: "not_allowed" });
    // A price has no order: a typed key there names nothing in the store, so it stays out too.
    const price: ActionEnvelope<ConsoleAction> = {
      operationKey: typed,
      actor: { type: "member", memberId: ids.staff, role: "owner" },
      action: { type: "propose_price", productId: "any-product", price: 100 },
    };
    expect((await engine.onConsoleAction(reviewer(s), price)).outcome).toMatchObject({ reason: "not_allowed" });
    const foreignKey = staffKey({ type: "start_preparing", orderId: order.orderId, version: 1 });
    expect((await engine.onConsoleAction(reviewer(other), staff(order.orderId, foreignKey))).outcome).toMatchObject({ reason: "not_found" });
    // The five paths the review measured (B1). Each key is the one the engine derives from a typed id or version,
    // so it passes the derived-key check and only the resolution of its ids keeps it out of the row.
    const member = { type: "member" as const, memberId: ids.staff, role: "owner" as const };
    const review: any = { type: "review_change", changeRequestId: typed, decision: "approve", reason: "x" };
    expect((await engine.onConsoleAction(reviewer(s), { operationKey: `rev:${typed}`, actor: member, action: review })).outcome).toMatchObject({
      reason: "not_found",
    });
    const proposal: any = { type: "propose_price", productId: typed, price: 100 };
    const proposalEnvelope = { operationKey: priceKey(typed, reviewer(s).nowMs, "propose_price"), actor: member, action: proposal };
    expect((await engine.onConsoleAction(reviewer(s), proposalEnvelope)).outcome).toMatchObject({ reason: "not_found" });
    const line: any = { type: "mark_line", orderId: order.orderId, version: 9, lineId: typed, mark: "listo" };
    expect((await engine.onConsoleAction(reviewer(s), { operationKey: staffKey(line), actor: member, action: line })).outcome).toMatchObject({
      reason: "stale_version",
    });
    const removed = {
      ...tap(order.orderId, 9),
      operationKey: `remove:${order.orderId}:v9:${typed}`,
      action: { type: "remove_line", orderId: order.orderId, version: 9, lineId: typed } as any,
    };
    expect((await engine.onCustomerAction(s.context(), removed)).outcome).toMatchObject({ reason: "stale_version" });
    const cancelled: any = {
      ...tap(order.orderId, 1),
      operationKey: `cancel:${order.orderId}:v${typed}`,
      action: { type: "cancel_order", orderId: order.orderId, version: typed },
    };
    expect((await engine.onCustomerAction(s.context(), cancelled)).outcome).toMatchObject({ reason: "stale_version" });
    const ready: any = { type: "mark_ready", orderId: order.orderId, version: typed };
    expect((await engine.onConsoleAction(reviewer(s), { operationKey: staffKey(ready), actor: member, action: ready })).outcome).toMatchObject({
      reason: "stale_version",
    });

    // Oldest first: the customer's calls and the claim are at T0, the staff's at T0 + 50 s.
    expect(await rowsOf(s.businessId)).toEqual([
      expect.objectContaining({ source: "not_allowed", operation_key: null, order_id: null }),
      expect.objectContaining({ source: "not_found", operation_key: null, order_id: null }),
      expect.objectContaining({ source: "verify_claims", result: "fail", operation_key: null, order_id: null, claim_kind: "order_state" }),
      expect.objectContaining({ source: "stale_version", operation_key: null, order_id: order.orderId }),
      expect.objectContaining({ source: "stale_version", operation_key: null, order_id: order.orderId }),
      expect.objectContaining({ source: "not_allowed", operation_key: null, order_id: null }),
      expect.objectContaining({ source: "not_allowed", operation_key: null, order_id: null }),
      expect.objectContaining({ source: "not_found", operation_key: null, order_id: null }),
      expect.objectContaining({ source: "not_found", operation_key: null, order_id: null }),
      expect.objectContaining({ source: "stale_version", operation_key: null, order_id: order.orderId }),
      expect.objectContaining({ source: "stale_version", operation_key: null, order_id: order.orderId }),
    ]);
    expect(await rowsOf(other.businessId)).toEqual([expect.objectContaining({ source: "not_found", operation_key: null, order_id: null })]);
    const everything = JSON.stringify(await env.DB.prepare(`SELECT * FROM deed_checks`).all());
    expect(everything).not.toContain("50499998888");
    expect(everything).not.toContain("Maria");
    // The order id is stored on a refusal that names the order, so only the key column is checked against it.
    const keys = JSON.stringify(await env.DB.prepare(`SELECT operation_key FROM deed_checks`).all());
    expect(keys).not.toContain(order.orderId);
  });

  it("B1: a typed line label or change request id reaches no row, even on a refusal that names the order", async () => {
    const s = await newStore();
    const order = await placeFirstOrder(s);
    const typed = "Maria Lopez 50499998888";
    const actor = { type: "member" as const, memberId: ids.staff, role: "owner" as const };
    const line: any = { type: "mark_line", orderId: order.orderId, version: 9, lineId: typed, mark: "listo" };
    await checked().onConsoleAction(reviewer(s), { operationKey: staffKey(line), actor, action: line });
    await checked().onConsoleAction(reviewer(s), { operationKey: `rev:${typed}`, actor,
      action: { type: "review_change", changeRequestId: typed, decision: "approve", reason: "x" } as any });
    expect(JSON.stringify(await rowsOf(s.businessId))).not.toContain("50499998888");
  });

  it("B2: a version the order never had, typed as a number, reaches no key on either path", async () => {
    const s = await newStore();
    const order = await placeFirstOrder(s);
    const engine = checked();
    const member = { type: "member" as const, memberId: ids.staff, role: "owner" as const };
    // The review's 8-digit number on both paths, then an 11-digit one (a Honduran number with its country code).
    for (const typed of [99887766, 50499998888]) {
      await engine.onCustomerAction(s.context(), cancelTap(order.orderId, typed));
      const ready: any = { type: "mark_ready", orderId: order.orderId, version: typed };
      await engine.onConsoleAction(reviewer(s), { operationKey: staffKey(ready), actor: member, action: ready });
    }
    const rows = await rowsOf(s.businessId);
    expect(rows.map((row) => [row.source, row.operation_key])).toEqual([
      ["stale_version", null],
      ["stale_version", null],
      ["stale_version", null],
      ["stale_version", null],
    ]);
    const everything = JSON.stringify(await env.DB.prepare(`SELECT * FROM deed_checks`).all());
    expect(everything).not.toContain("99887766");
    expect(everything).not.toContain("50499998888");
  });

  it("keeps the outcome identical when the recorder throws, for a refusal and for a claim", async () => {
    const s = await newStore();
    const order = await placeFirstOrder(s);
    const broken: DeedChecks = {
      record: async () => {
        throw new Error("d1 is down");
      },
    };
    const stale = tap(order.orderId, 9);
    const silent: DeedChecks = { record: async () => {} };
    const plain = await checked(silent).onCustomerAction(s.context(), stale);
    const withBroken = await checked(broken).onCustomerAction(s.context(), stale);
    expect(withBroken).toEqual(plain);
    const claims: Claim[] = [{ type: "order_state", orderId: order.orderId, version: 1, state: "por_confirmar" }];
    expect(await checked(broken).verifyClaims(s, claims)).toEqual([true]);
    expect(await rowsOf(s.businessId)).toEqual([]);
  });

  it("never writes message text: a burst's sentence stays out of every column", async () => {
    const s = await newStore();
    const sentence = "MENSAJE-SECRETO-ÑANDÚ-no-debe-guardarse";
    const reading = {
      ...firstOrder,
      observations: firstOrder.observations.map((observation) =>
        observation.kind === "customer_order" ? { ...observation, lines: observation.lines.map((line) => ({ ...line, text: sentence })) } : observation,
      ),
    };
    const engine = checked();
    const context = s.context();
    await save(await engine.onBurst(context, reading, s.matches));
    const again = await engine.onBurst(context, reading, s.matches);
    expect(again.outcome.type).toBe("duplicate");
    const everything = JSON.stringify(await env.DB.prepare(`SELECT * FROM deed_checks`).all());
    expect(everything).toContain("duplicate_key");
    expect(everything).not.toContain(sentence);
    expect(everything).not.toContain("MENSAJE");
  });

  it("is append-only: an update or a delete is refused by the database", async () => {
    const s = await newStore();
    const order = await placeFirstOrder(s);
    await checked().verifyClaims(s, [{ type: "order_state", orderId: order.orderId, version: 1, state: "por_confirmar" }]);
    await expect(env.DB.prepare(`UPDATE deed_checks SET result = 'fail'`).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare(`DELETE FROM deed_checks`).run()).rejects.toThrow(/append-only/);
    expect(await count(`deed_checks WHERE business_id = ?`, s.businessId)).toBe(1);
  });

  it("counts the checks and the refusals by reason, for the store only", async () => {
    const s = await newStore();
    const other = await newStore();
    const order = await placeFirstOrder(s);
    await placeFirstOrder(other, ids.customer);
    const engine = checked();
    await engine.verifyClaims(s, [{ type: "order_state", orderId: order.orderId, version: 1, state: "cancelado" }]);
    await engine.onCustomerAction(s.context(), tap(order.orderId, 9));
    const counters = await new D1DeedReads(env.DB).counters(s);
    // A failed claim is a claim that did not hold, not a refused attempt.
    expect(counters).toMatchObject({ attempts: 1, claims: 1, claimsPassed: 0 });
    expect(counters.refusedByReason.get("stale_version")).toBe(1);
    expect(counters.refusedByReason.has("not_backed")).toBe(false);
    expect(await new D1DeedReads(env.DB).feed(other)).toEqual([]);
  });
});
