import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Claim, OrderState } from "../src/domain/contract/outcomes";
import { addAndPickup, ids, moreSugar } from "./fixtures/contract";
import { engine, newStore, placeFirstOrder, save, store, T0, tap } from "./helpers/orders";

type Store = Awaited<ReturnType<typeof newStore>>;

/** The customer's confirming tap on a version, saved. */
async function confirm(s: Store, orderId: string, version: number, nowMs = T0 + 1000, customerId: string = ids.customer) {
  await save(
    await engine.onCustomerAction(s.context({ customerId, nowMs }), {
      ...tap(orderId, version),
      actor: { type: "customer", customerId },
    }),
  );
}

/** The customer's cancel tap, saved. */
async function cancel(s: Store, orderId: string, version: number) {
  const result = await engine.onCustomerAction(
    s.context(),
    tap(orderId, version, { operationKey: `cancel:${orderId}:v${version}`, action: { type: "cancel_order", orderId, version } }),
  );
  expect(result.outcome.type).toBe("order_cancelled");
  await save(result);
}

/** No line is priced yet, so a total only exists once a test sets one. */
const priceVersion = (orderId: string, version: number, total: number) =>
  env.DB.prepare(`UPDATE order_versions SET total_centavos = ? WHERE order_id = ? AND version = ?`).bind(total, orderId, version).run();

const stateClaim = (orderId: string, version: number, state: OrderState): Claim => ({ type: "order_state", orderId, version, state });
const totalClaim = (orderId: string, version: number, total: number): Claim => ({ type: "order_total", orderId, version, total });

describe("verifyClaims: true only when the records back the claim now", () => {
  it("backs order_state and order_total, then turns false after a cancel", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await confirm(s, v1.orderId, 1);
    await priceVersion(v1.orderId, 1, 34_500);

    expect(
      await engine.verifyClaims(s.context(), [
        stateClaim(v1.orderId, 1, "confirmado"),
        totalClaim(v1.orderId, 1, 34_500),
        stateClaim(v1.orderId, 1, "listo"),
        totalClaim(v1.orderId, 1, 34_400),
      ]),
    ).toEqual([true, true, false, false]);

    await cancel(s, v1.orderId, 1);
    expect(
      await engine.verifyClaims(s.context(), [stateClaim(v1.orderId, 1, "confirmado"), stateClaim(v1.orderId, 1, "cancelado")]),
    ).toEqual([false, true]);
  });

  it("turns false after a change makes a new version", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await confirm(s, v1.orderId, 1);
    await priceVersion(v1.orderId, 1, 34_500);
    const claims = [stateClaim(v1.orderId, 1, "confirmado"), totalClaim(v1.orderId, 1, 34_500)];
    expect(await engine.verifyClaims(s.context(), claims)).toEqual([true, true]);

    await save(await engine.onBurst(s.context({ nowMs: T0 + 2000 }), moreSugar, []));
    expect(await engine.verifyClaims(s.context(), claims)).toEqual([false, false]);
    expect(await engine.verifyClaims(s.context(), [stateClaim(v1.orderId, 2, "por_confirmar")])).toEqual([true]);

    // Confirmed again at the same total: the same state and total, but on v2, so v1's claims stay false.
    await confirm(s, v1.orderId, 2, T0 + 3000);
    await priceVersion(v1.orderId, 2, 34_500);
    expect(await engine.verifyClaims(s.context(), claims)).toEqual([false, false]);
    expect(
      await engine.verifyClaims(s.context(), [stateClaim(v1.orderId, 2, "confirmado"), totalClaim(v1.orderId, 2, 34_500)]),
    ).toEqual([true, true]);
  });

  it("is false for an unknown total, what isn't stored, an unknown shape and another store's order", async () => {
    const s = await newStore();
    const other = await newStore();
    const v1 = await placeFirstOrder(s);
    const claims = [
      // The total is unknown (no line priced): it never equals anything.
      totalClaim(v1.orderId, 1, 0),
      { type: "unit_price", productId: "p", price: 100 },
      { type: "availability", productId: "p", availability: "hay" },
      { type: "payment_confirmed", paymentClaimId: "c", amount: 100 },
      { type: "balance", customerId: ids.customer, balance: 0 },
      { type: "store_hours", hours: [] },
      { type: "made_up" },
      null,
      { type: "order_state", orderId: 7, version: 1, state: "por_confirmar" },
    ] as unknown as Claim[];
    expect(await engine.verifyClaims(s.context(), claims)).toEqual(claims.map(() => false));

    // The same claim is true here and false from another store.
    expect(await engine.verifyClaims(s.context(), [stateClaim(v1.orderId, 1, "por_confirmar")])).toEqual([true]);
    expect(await engine.verifyClaims(other.context(), [stateClaim(v1.orderId, 1, "por_confirmar")])).toEqual([false]);
    expect(await engine.verifyClaims(s.context(), [])).toEqual([]);
  });
});

/** Moves an order the way staff will (item 3 of #12 builds the taps); here only the read is under test. */
const setState = (orderId: string, state: OrderState) =>
  env.DB.prepare(`UPDATE orders SET state = ? WHERE id = ?`).bind(state, orderId).run();

describe("preparationList: confirmado, preparando and listo, oldest confirmation first", () => {
  it("lists the three states in confirmation order and leaves out cancelled and unconfirmed orders", async () => {
    const s = await newStore();
    const other = await newStore();
    const ready = await placeFirstOrder(s, "customer-ready");
    const packing = await placeFirstOrder(s, "customer-packing");
    const waiting = await placeFirstOrder(s, "customer-waiting");
    const cancelled = await placeFirstOrder(s, "customer-cancelled");
    await placeFirstOrder(s, "customer-unconfirmed");
    await placeFirstOrder(other, "customer-elsewhere");
    // Confirmed out of creation order: the list follows the first confirmation.
    await confirm(s, waiting.orderId, 1, T0 + 1000, "customer-waiting");
    await confirm(s, cancelled.orderId, 1, T0 + 1500, "customer-cancelled");
    await confirm(s, ready.orderId, 1, T0 + 2000, "customer-ready");
    await confirm(s, packing.orderId, 1, T0 + 3000, "customer-packing");
    await confirm(other, (await store.openOrder(other.context(), "customer-elsewhere"))!.view.orderId, 1, T0, "customer-elsewhere");
    await setState(ready.orderId, "listo");
    await setState(packing.orderId, "preparando");
    await setState(cancelled.orderId, "cancelado");

    const list = await engine.preparationList(s.context());
    expect(list.map((card) => [card.order.orderId, card.order.state, card.confirmedAtMs])).toEqual([
      [waiting.orderId, "confirmado", T0 + 1000],
      [ready.orderId, "listo", T0 + 2000],
      [packing.orderId, "preparando", T0 + 3000],
    ]);
    // Each card carries the order exactly as the customer's reader builds it, and no name yet.
    for (const card of list) {
      const customerId = card.order.orderId === waiting.orderId ? "customer-waiting" : card.order.orderId === ready.orderId ? "customer-ready" : "customer-packing";
      expect(card.order).toEqual((await store.customerOrder(s.context(), customerId, card.order.orderId))?.view);
      expect(card.customerName).toBeNull();
      expect(card.changedLineIds).toEqual([]);
    }
    expect(list[0]?.order.queuePosition).toBe(1);
    expect(list[1]?.order.queuePosition).toBeNull();
  });

  it("reports the lines that changed in the current version", async () => {
    const s = await newStore();
    const v1 = await placeFirstOrder(s);
    await confirm(s, v1.orderId, 1);
    // "Y otro jabón" plus pickup: v2 adds L5 and keeps L1-L4 as they were.
    const change = await engine.onBurst(s.context({ nowMs: T0 + 2000 }), addAndPickup, []);
    expect(change.outcome.type).toBe("order_changed");
    await save(change);
    await confirm(s, v1.orderId, 2, T0 + 3000);

    // A quantity edited in place on v2 counts too, and a line equal to v1 doesn't.
    await env.DB.prepare(`UPDATE order_lines SET qty_milli = 5000 WHERE order_id = ? AND version = 2 AND line_no = 2`).bind(v1.orderId).run();
    const [card] = await engine.preparationList(s.context());
    expect(card?.order).toMatchObject({ orderId: v1.orderId, version: 2, state: "confirmado" });
    expect(card?.changedLineIds).toEqual(["L2", "L5"]);
    // Still listed at its first confirmation (D-38).
    expect(card?.confirmedAtMs).toBe(T0 + 1000);

    // Each compared field on its own: unit, the customer's words, the product (null counts as a value).
    const edit = (sql: string, lineNo: number) =>
      env.DB.prepare(`UPDATE order_lines SET ${sql} WHERE order_id = ? AND version = 2 AND line_no = ?`).bind(v1.orderId, lineNo).run();
    await edit(`unit = 'caja'`, 1);
    await edit(`customer_text = '3 lb arroz blanco'`, 3);
    await edit(`product_id = NULL`, 4);
    expect((await engine.preparationList(s.context()))[0]?.changedLineIds).toEqual(["L1", "L2", "L3", "L4", "L5"]);

    // v3 is compared with v2, not v1: only the line it adds is new.
    const again = await engine.onBurst(s.context({ nowMs: T0 + 4000 }), addAndPickup, []);
    await save(again);
    await confirm(s, v1.orderId, 3, T0 + 5000);
    expect((await engine.preparationList(s.context()))[0]?.changedLineIds).toEqual(["L6"]);
  });
});
