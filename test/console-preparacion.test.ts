import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import type { ActionEnvelope, ConsoleAction } from "../src/domain/contract/actions";
import { formatLempiras } from "../src/domain/contract/numbers";
import { demoOrders } from "../src/infrastructure/memory/demo-orders";
import { MemoryEngine, type StoredOrder } from "../src/infrastructure/memory/memory-engine";
import { harness, testEnv } from "./helpers/harness";

const staff: MemberContext = { businessId: "store-a", memberId: "m-staff", role: "staff", canApproveFiado: false, nowMs: 0 };
const owner: MemberContext = { ...staff, memberId: "m-owner", role: "owner" };

function act(action: ConsoleAction, operationKey: string = crypto.randomUUID(), who = staff): ActionEnvelope<ConsoleAction> {
  return { operationKey, actor: { type: "member", memberId: who.memberId, role: who.role }, action };
}

function engineWithDemo() {
  return new MemoryEngine(() => demoOrders(1_000_000));
}

describe("the pretend engine follows the contract", () => {
  it("lists orders on the preparation list, oldest confirmation first", async () => {
    const list = await engineWithDemo().preparationList(staff);
    expect(list.map((card) => card.order.orderId)).toEqual(["demo-order-1", "demo-order-2", "demo-order-3"]);
  });

  it("refuses a tap on an old version and returns the current order", async () => {
    const engine = engineWithDemo();
    const { outcome } = await engine.onConsoleAction(staff, act({ type: "mark_ready", orderId: "demo-order-1", version: 1 }));
    expect(outcome).toMatchObject({ type: "rejected", reason: "stale_version", order: { version: 2, state: "preparando" } });
  });

  it("saves a double tap once and answers the second with the first outcome", async () => {
    const engine = engineWithDemo();
    const tap = act({ type: "mark_ready", orderId: "demo-order-1", version: 2 }, "same-key");
    const first = await engine.onConsoleAction(staff, tap);
    const second = await engine.onConsoleAction(staff, tap);
    expect(first.outcome).toMatchObject({ type: "action_saved", order: { state: "listo" } });
    expect(first.notices).toMatchObject([{ customerId: "demo-customer-1", notice: { type: "order_ready" } }]);
    expect(second).toEqual({ outcome: { type: "duplicate", first: first.outcome }, notices: [], commits: [] });
  });

  it("tells the customer about No hay, and marks the product se acabó", async () => {
    const engine = engineWithDemo();
    const { outcome, notices } = await engine.onConsoleAction(
      staff,
      act({ type: "mark_line", orderId: "demo-order-2", version: 1, lineId: "d2-1", mark: "no_hay", substituteProductId: null }),
    );
    expect(outcome).toMatchObject({ type: "action_saved", order: { state: "preparando" } });
    const line = outcome.type === "action_saved" ? outcome.order!.lines.find((l) => l.lineId === "d2-1") : null;
    expect(line).toMatchObject({ mark: "no_hay", availability: "se_acabo" });
    expect(notices).toMatchObject([{ notice: { type: "line_unavailable", lineId: "d2-1" } }]);
  });

  it("refuses actions that don't fit the order's state", async () => {
    const engine = engineWithDemo();
    const delivered = await engine.onConsoleAction(staff, act({ type: "mark_delivered", orderId: "demo-order-2", version: 1 }));
    expect(delivered.outcome).toMatchObject({ type: "rejected", reason: "invalid_state" });
    const missing = await engine.onConsoleAction(staff, act({ type: "mark_ready", orderId: "nope", version: 1 }));
    expect(missing.outcome).toMatchObject({ type: "rejected", reason: "not_found" });
  });

  it("leaves owner actions to the owner", async () => {
    const engine = engineWithDemo();
    const byStaff = await engine.onConsoleAction(staff, act({ type: "confirm_payment", paymentClaimId: "pc-1" }));
    expect(byStaff.outcome).toMatchObject({ type: "rejected", reason: "not_allowed" });
    const byOwner = await engine.onConsoleAction(owner, act({ type: "confirm_payment", paymentClaimId: "pc-1" }, undefined, owner));
    expect(byOwner.outcome).not.toMatchObject({ reason: "not_allowed" });
  });

  it("keeps each store's orders apart", async () => {
    const engine = new MemoryEngine((tenant) => (tenant.businessId === "store-a" ? demoOrders(0) : []));
    expect(await engine.preparationList({ businessId: "store-b" })).toEqual([]);
    const { outcome } = await engine.onConsoleAction(
      { ...staff, businessId: "store-b" },
      act({ type: "mark_ready", orderId: "demo-order-1", version: 2 }),
    );
    expect(outcome).toMatchObject({ type: "rejected", reason: "not_found" });
  });

  it("backs a claim only when the order is in that state at that version", async () => {
    const engine = engineWithDemo();
    const claims = [
      { type: "order_state", orderId: "demo-order-1", version: 2, state: "listo" },
      { type: "order_total", orderId: "demo-order-1", version: 2, total: 34500 },
    ] as const;
    expect(await engine.verifyClaims(staff, claims)).toEqual([false, true]);
    await engine.onConsoleAction(staff, act({ type: "mark_ready", orderId: "demo-order-1", version: 2 }));
    expect(await engine.verifyClaims(staff, claims)).toEqual([true, true]);
  });
});

describe("the dev console's preparation list", () => {
  const devEnv = () => testEnv({ DEV_CONSOLE: "1" } as unknown as Partial<Env>);

  async function post(h: ReturnType<typeof harness>, fields: Record<string, string>) {
    const ctx = createExecutionContext();
    const response = await h.worker.fetch(
      new Request("https://worker.test/console/acciones", {
        method: "POST",
        headers: { origin: "https://worker.test" },
        body: new URLSearchParams({ csrf: "dev", ...fields }),
        redirect: "manual",
      }),
      h.env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("asks for a login unless dev mode is on", async () => {
    const h = harness({ engine: engineWithDemo() });
    const response = await h.get("/console/preparacion");
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("escaneá el código");
  });

  it("shows each order with its lines, version, total and buttons", async () => {
    const h = harness({ env: devEnv(), engine: engineWithDemo() });
    const response = await h.get("/console/preparacion");
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("1. Carla");
    expect(page).toContain("Versión 2");
    expect(page).toContain(`Total ${formatLempiras(34500)}`);
    expect(page).toContain("Total: falta precio");
    expect(page).toContain("Para llevar: frente a la iglesia, casa verde");
    expect(page).toContain("Cliente sin nombre");
    expect(page).toContain("Pedido listo");
    expect(page).toContain("Cambió");
  });

  it("escapes what customers wrote", async () => {
    const hostile: StoredOrder = {
      ...demoOrders(0)[1]!,
      customerName: "<script>alert(1)</script>",
    };
    const h = harness({ env: devEnv(), engine: new MemoryEngine(() => [hostile]) });
    const page = await (await h.get("/console/preparacion")).text();
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
  });

  it("shows a shared location as a map link built from its numbers, and the place as written (#29)", async () => {
    const base = demoOrders(0)[1]!;
    const pinned: StoredOrder = {
      ...base,
      order: {
        ...base.order,
        fulfillment: { mode: "delivery", placeId: null, placeText: "<b>casa</b>", fee: null, pin: { latitude: 10.123456, longitude: -80.654321 } },
      },
    };
    const h = harness({ env: devEnv(), engine: new MemoryEngine(() => [pinned]) });
    const page = await (await h.get("/console/preparacion")).text();
    expect(page).toContain("Para llevar: &lt;b&gt;casa&lt;/b&gt;");
    expect(page).toContain('href="https://www.google.com/maps?q=10.123456,-80.654321"');
    expect(page).toContain("Ver ubicación");
    expect(page).not.toContain("Envío");
  });

  it("saves a tap and goes back to the list; a tap on an old version says the order changed", async () => {
    const engine = engineWithDemo();
    const h = harness({ env: devEnv(), engine });
    const ready = await post(h, { type: "mark_ready", orderId: "demo-order-1", version: "2", operationKey: "k-1" });
    expect(ready.status).toBe(303);
    expect(ready.headers.get("location")).toBe("/console/preparacion#demo-order-1");
    expect((await engine.preparationList(devStore())).find((c) => c.order.orderId === "demo-order-1")?.order.state).toBe("listo");

    const stale = await post(h, { type: "mark_line", orderId: "demo-order-3", version: "9", lineId: "d3-1", mark: "listo", operationKey: "k-2" });
    expect(stale.headers.get("location")).toBe("/console/preparacion?aviso=cambio#demo-order-3");
    const page = await (await h.get("/console/preparacion?aviso=cambio")).text();
    expect(page).toContain("Este pedido cambió. Revisá la versión nueva.");
  });

  it("rejects a form it doesn't expect", async () => {
    const h = harness({ env: devEnv(), engine: engineWithDemo() });
    const forms: Record<string, string>[] = [
      { type: "confirm_payment", orderId: "demo-order-1", version: "2", operationKey: "k" },
      { type: "mark_line", orderId: "demo-order-1", version: "2", lineId: "d1-1", mark: "ofrecer_otro", operationKey: "k" },
      { type: "mark_ready", orderId: "demo-order-1", version: "dos", operationKey: "k" },
      { type: "mark_ready", orderId: "demo-order-1", version: "2" },
    ];
    for (const fields of forms) {
      expect((await post(h, fields)).status, JSON.stringify(fields)).toBe(400);
    }
  });
});

function devStore() {
  return { businessId: "dev-store" };
}
