import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { burstKey } from "../src/application/engine/order-engine";
import type { BurstReading } from "../src/domain/contract/observation";
import { addAndPickup, firstOrder, ids, injectedInstructions, moreSugar } from "./fixtures/contract";
import { count, engine, footprint, newStore, placeFirstOrder, save, store, T0, tap } from "./helpers/orders";

describe("order engine on local D1", () => {
  it("(a) turns a first order into v1 read back, and the confirming tap saves it once", async () => {
    const s = await newStore();
    const result = await engine.onBurst(s.context(), firstOrder, s.matches);

    expect(result.outcome.type).toBe("readback");
    if (result.outcome.type !== "readback") return;
    const order = result.outcome.order;
    expect(order).toMatchObject({ version: 1, state: "por_confirmar", fulfillment: null, total: null, queuePosition: null });
    expect(order.lines.map((l) => [l.lineId, l.text, l.quantity, l.unit])).toEqual([
      ["L1", "1 aceite clover", "1", null],
      ["L2", "3 lb arroz", "3", "libra"],
      ["L3", "3 jabon xtra", "3", null],
      ["L4", "dos libras de azúcar", "2", "libra"],
    ]);
    // Line 0 waits for its size: no match, no product.
    expect(order.lines.map((l) => l.productId)).toEqual([null, ...s.matches.map((m) => m.productId)]);
    expect(await footprint(s.businessId)).toMatchObject({ orders: 0, operations: 0 });

    await save(result);
    // Read back from the records, it is exactly what the customer was shown.
    expect((await store.openOrder(s.context(), ids.customer))?.view).toEqual(order);
    expect(await count(`orders WHERE business_id = ? AND created_at_ms = ?`, s.businessId, T0)).toBe(1);

    const confirmAt = T0 + 60_000;
    const confirmed = await engine.onCustomerAction(s.context({ nowMs: confirmAt }), tap(order.orderId, 1));
    expect(confirmed.outcome).toEqual({ type: "order_confirmed", order: { ...order, state: "confirmado", queuePosition: 1 } });
    await save(confirmed);

    const row = await env.DB.prepare(`SELECT state, current_version, first_confirmed_at_ms FROM orders WHERE id = ?`)
      .bind(order.orderId)
      .first();
    expect(row).toEqual({ state: "confirmado", current_version: 1, first_confirmed_at_ms: confirmAt });
    expect(await footprint(s.businessId)).toEqual({ orders: 1, versions: 1, lines: 4, operations: 2, audit: 2 });
  });

  it("(b) answers a repeated operation key from the read: duplicate with the first outcome, saved once", async () => {
    const s = await newStore();
    const context = s.context();
    const first = await engine.onBurst(context, firstOrder, s.matches);
    await save(first);
    const before = await footprint(s.businessId);

    // The same job retried.
    const again = await engine.onBurst(context, firstOrder, s.matches);
    expect(again.outcome).toEqual({ type: "duplicate", first: first.outcome });
    // Answered by the read: no commit was even built, so no UNIQUE could have been the one to answer.
    expect(again.commits).toEqual([]);
    await save(again);
    expect(await footprint(s.businessId)).toEqual(before);
    expect(await count(`operations WHERE business_id = ? AND operation_key = ?`, s.businessId, burstKey(context.jobId))).toBe(1);

    // The same tap twice (a double tap, or typed "confirmar" after the button): the same holds.
    if (first.outcome.type !== "readback") throw new Error("expected readback");
    const envelope = tap(first.outcome.order.orderId, 1);
    const confirmed = await engine.onCustomerAction(s.context(), envelope);
    await save(confirmed);
    const typed = await engine.typedAction(s.context(), "confirm_order");
    expect(typed).toBeNull(); // nothing waits for an answer any more
    const twice = await engine.onCustomerAction(s.context(), envelope);
    expect(twice).toEqual({ outcome: { type: "duplicate", first: confirmed.outcome }, notices: [], commits: [] });
    expect(await count(`operations WHERE business_id = ? AND operation_key = ?`, s.businessId, envelope.operationKey)).toBe(1);
  });

  it("(c) rejects a button key from another customer's order as not_found and writes nothing", async () => {
    const s = await newStore();
    const carlas = await placeFirstOrder(s);
    const mine = await placeFirstOrder(s, "customer-other");
    const before = await footprint(s.businessId);

    const intruder = s.context({ customerId: "customer-other" });
    const foreign = tap(carlas.orderId, 1, { actor: { type: "customer", customerId: "customer-other" } });
    const result = await engine.onCustomerAction(intruder, foreign);
    // Their own open order comes back so the screen can refresh; Carla's is never shown.
    expect(result).toEqual({ outcome: { type: "rejected", reason: "not_found", order: mine }, notices: [], commits: [] });
    await save(result);
    expect(await footprint(s.businessId)).toEqual(before);
    expect((await store.openOrder(s.context(), ids.customer))?.view.state).toBe("por_confirmar");

    // The same order id from another store's customer with the same id: not found there either.
    const other = await newStore();
    const elsewhere = await engine.onCustomerAction(other.context(), tap(carlas.orderId, 1));
    expect(elsewhere.outcome).toEqual({ type: "rejected", reason: "not_found", order: null });
    expect(elsewhere.commits).toEqual([]);

    // A tap whose actor isn't the conversation's customer is refused before any lookup.
    const spoofed = await engine.onCustomerAction(intruder, tap(carlas.orderId, 1));
    expect(spoofed).toEqual({ outcome: { type: "rejected", reason: "not_allowed", order: null }, notices: [], commits: [] });
  });

  it("(c2) a used operation key never leaks Carla's order to another customer or a spoofed actor", async () => {
    const s = await newStore();
    const carlas = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context(), tap(carlas.orderId, 1)));
    await placeFirstOrder(s, "customer-other");
    const before = await footprint(s.businessId);
    const intruder = s.context({ customerId: "customer-other" });

    const foreign = await engine.onCustomerAction(intruder, tap(carlas.orderId, 1, { actor: { type: "customer", customerId: "customer-other" } }));
    expect(foreign.outcome.type).toBe("rejected");
    expect(foreign.outcome).toMatchObject({ reason: "not_found" });
    expect(JSON.stringify(foreign)).not.toContain(carlas.orderId);
    expect(foreign.commits).toEqual([]);

    const spoofed = await engine.onCustomerAction(intruder, tap(carlas.orderId, 1));
    expect(spoofed.outcome).toEqual({ type: "rejected", reason: "not_allowed", order: null });
    expect(spoofed.commits).toEqual([]);
    expect(await footprint(s.businessId)).toEqual(before);

    // Carla's own replay still answers duplicate.
    const replay = await engine.onCustomerAction(s.context(), tap(carlas.orderId, 1));
    expect(replay.outcome.type).toBe("duplicate");
  });

  it("(e) binds the operation key to the action and the order: no foreign duplicate, no reused key", async () => {
    const s = await newStore();
    const carla = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context(), tap(carla.orderId, 1)));
    const bob = await placeFirstOrder(s, "customer-bob");
    const bobs = s.context({ customerId: "customer-bob" });
    const before = await footprint(s.businessId);

    // Bob's own order with Carla's used key: refused, never her first outcome.
    const probe = await engine.onCustomerAction(bobs, {
      operationKey: `confirm:${carla.orderId}:v1`,
      actor: { type: "customer", customerId: "customer-bob" },
      action: { type: "confirm_order", orderId: bob.orderId, version: 1 },
    });
    expect(probe).toEqual({ outcome: { type: "rejected", reason: "not_allowed", order: null }, notices: [], commits: [] });
    expect(JSON.stringify(probe)).not.toContain(carla.orderId);

    // An arbitrary key, and a key of another action, on Bob's own order: refused, nothing saved.
    for (const operationKey of ["arbitrary", `cancel:${bob.orderId}:v1`, `confirm:${bob.orderId}:v2`]) {
      const refused = await engine.onCustomerAction(bobs, tap(bob.orderId, 1, { operationKey, actor: { type: "customer", customerId: "customer-bob" } }));
      expect(refused.outcome).toEqual({ type: "rejected", reason: "not_allowed", order: null });
      expect(refused.commits).toEqual([]);
    }
    // A confirm key never answers a cancel of the same order.
    const mixed = await engine.onCustomerAction(s.context(), tap(carla.orderId, 1, {
      action: { type: "cancel_order", orderId: carla.orderId, version: 1 },
    }));
    expect(mixed.outcome.type).toBe("rejected");
    expect(mixed.commits).toEqual([]);
    expect(await footprint(s.businessId)).toEqual(before);

    // The derived keys are the ones that work: remove and cancel each save once.
    const removeKey = `remove:${bob.orderId}:v1:L1`;
    const removed = await engine.onCustomerAction(bobs, {
      operationKey: removeKey,
      actor: { type: "customer", customerId: "customer-bob" },
      action: { type: "remove_line", orderId: bob.orderId, version: 1, lineId: "L1" },
    });
    expect(removed.outcome.type).toBe("readback");
    expect(removed.commits).toHaveLength(1);
  });

  it("(d) a change after confirming makes v2 in por_confirmar; a tap on v1 saves nothing; v2 keeps its place", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), tap(v1.orderId, 1)));
    // Someone else confirms later: behind Carla.
    const later = await placeFirstOrder(s, "customer-later", T0 + 2000);
    await save(await engine.onCustomerAction(s.context({ customerId: "customer-later", nowMs: T0 + 3000 }), {
      ...tap(later.orderId, 1),
      actor: { type: "customer", customerId: "customer-later" },
    }));

    const change = await engine.onBurst(s.context({ nowMs: T0 + 4000 }), moreSugar, []);
    expect(change.outcome.type).toBe("order_changed");
    if (change.outcome.type !== "order_changed") return;
    const v2 = change.outcome.order;
    expect(v2).toMatchObject({ orderId: v1.orderId, version: 2, state: "por_confirmar", queuePosition: null });
    expect(v2.lines.map((l) => l.quantity)).toEqual(["1", "3", "3", "2"]);
    await save(change);
    expect((await store.openOrder(s.context(), ids.customer))?.view).toEqual(v2);
    const before = await footprint(s.businessId);

    // A cancel tap on v1 (its key is unused): refused as stale, nothing saved.
    const stale = await engine.onCustomerAction(s.context(), tap(v1.orderId, 1, {
      operationKey: `cancel:${v1.orderId}:v1`,
      action: { type: "cancel_order", orderId: v1.orderId, version: 1 },
    }));
    expect(stale).toEqual({ outcome: { type: "rejected", reason: "stale_version", order: v2 }, notices: [], commits: [] });
    // The old button again: its key was used, so it answers with the first save and saves nothing.
    const replay = await engine.onCustomerAction(s.context(), tap(v1.orderId, 1));
    expect(replay.outcome.type).toBe("duplicate");
    expect(replay.commits).toEqual([]);
    await save(stale);
    await save(replay);
    expect(await footprint(s.businessId)).toEqual(before);

    // Confirmed again: back in line ahead of the later order, first confirmation time untouched.
    const typed = await engine.typedAction(s.context({ nowMs: T0 + 5000 }), "confirm_order");
    expect(typed?.operationKey).toBe(`confirm:${v1.orderId}:v2`);
    const reconfirmed = await engine.onCustomerAction(s.context({ nowMs: T0 + 5000 }), typed!);
    expect(reconfirmed.outcome).toEqual({ type: "order_confirmed", order: { ...v2, state: "confirmado", queuePosition: 1 } });
    await save(reconfirmed);
    const row = await env.DB.prepare(`SELECT first_confirmed_at_ms AS at FROM orders WHERE id = ?`).bind(v1.orderId).first();
    expect(row).toEqual({ at: T0 + 1000 });
  });

  it("adds to the open order (D-39): a change and a pickup in one burst make one new version", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    const result = await engine.onBurst(s.context(), addAndPickup, []);
    expect(result.outcome.type).toBe("readback"); // never confirmed: a plain readback
    if (result.outcome.type !== "readback") return;
    const v2 = result.outcome.order;
    expect(v2).toMatchObject({ orderId: v1.orderId, version: 2, fulfillment: { mode: "pickup" } });
    expect(v2.lines.map((l) => l.text)).toEqual([...v1.lines.map((l) => l.text), "un jabón más"]);
    await save(result);

    // Another order message while this one is open adds to it, not a second order.
    const more = await engine.onBurst(s.context(), firstOrder, s.matches);
    await save(more);
    expect(more.outcome.type === "readback" && more.outcome.order).toMatchObject({ orderId: v1.orderId, version: 3 });
    expect(await count(`orders WHERE business_id = ?`, s.businessId)).toBe(1);
  });

  it("saves nothing for instructions inside a photo, a label it can't resolve, or a console kind", async () => {
    const s = await newStore();
    await placeFirstOrder(s);
    const before = await footprint(s.businessId);

    const injected = await engine.onBurst(s.context(), injectedInstructions, []);
    expect(injected).toEqual({ outcome: { type: "out_of_scope" }, notices: [], commits: [] });

    const unknownLabel: BurstReading = {
      observations: [{ kind: "order_change", edits: [{ op: "remove", target: { ref: "L9", said: "eso" }, evidence: { source: "text", message: 0, start: 0, end: 3 } }], issues: [] }],
      calls: [],
    };
    const ask = await engine.onBurst(s.context(), unknownLabel, []);
    expect(ask.outcome).toMatchObject({ type: "ask", question: "ambiguous_product" });
    expect(ask.commits).toEqual([]);

    const sale: BurstReading = { observations: [{ kind: "sale_report", lines: [], issues: [] }], calls: [] };
    const refused = await engine.onBurst(s.context(), sale, []);
    expect(refused).toEqual({ outcome: { type: "rejected", reason: "not_allowed", order: null }, notices: [], commits: [] });

    expect(await footprint(s.businessId)).toEqual(before);
  });

  it("lets the guard settle a race the read could not see", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    // Two confirmations decided on the same read; only the first lands.
    const a = await engine.onCustomerAction(s.context(), tap(v1.orderId, 1));
    const b = await engine.onCustomerAction(s.context(), tap(v1.orderId, 1));
    await save(a);
    await expect(save(b)).rejects.toThrow(/order_moved/);
    expect(await count(`operations WHERE business_id = ?`, s.businessId)).toBe(2);
  });
});
