import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Claim, OrderState } from "../src/domain/contract/outcomes";
import { ids, moreSugar } from "./fixtures/contract";
import { engine, newStore, placeFirstOrder, save, T0, tap } from "./helpers/orders";

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
