import { staffKey } from "../src/application/engine/order-engine";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import type { ActionEnvelope, ConsoleAction } from "../src/domain/contract/actions";
import { formatLempiras } from "../src/domain/contract/numbers";
import type { OrderView, PreparationCard } from "../src/domain/contract/outcomes";
import { demoOrders } from "../src/infrastructure/memory/demo-orders";
import { MemoryEngine, type StoredOrder } from "../src/infrastructure/memory/memory-engine";
import { chipFor, LATE_AFTER_MINUTES } from "../src/interfaces/http/console/preparacion";
import { login, send, storeWithStaff } from "./helpers/console";
import { FakeClock } from "./helpers/fakes";
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

/** The list's cards as a person reads them: where the card goes, the name, the chip, the muted line. */
const cardsOf = (page: string) =>
  [
    ...page.matchAll(
      /<a class="card order[^"]*" id="[^"]*" href="([^"]+)">\s*<span class="row"><strong class="name">([^<]*)<\/strong><span class="chip[^"]*">([^<]*)<\/span><\/span>\s*<span class="muted">([^<]*)<span class="when">([^<]*)<\/span><\/span>/g,
    ),
  ].map(([, href = "", name, chip, start, when]) => ({ href, name, chip, line: `${start}${when}` }));

/** One order line on the order's page, by product name. */
const lineOf = (page: string, name: string) => [...page.matchAll(/<li class="line[^"]*">[\s\S]*?<\/li>/g)].map(([li]) => li).find((li) => li.includes(name));

const MINUTE = 60_000;

describe("the dev console's preparation list", () => {
  const devEnv = () => testEnv({ DEV_CONSOLE: "1" } as unknown as Partial<Env>);

  /** The dev console on a fake clock at 8:00 a. m. store time, its orders confirmed relative to it. */
  function devConsole(orders: (nowMs: number) => StoredOrder[] = demoOrders) {
    const clock = new FakeClock();
    const engine = new MemoryEngine(() => orders(clock.now()));
    return { h: harness({ env: devEnv(), engine, clock }), engine, clock };
  }

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

  it("lists each order as one compact card, oldest first: name, chip, products, how it leaves, and when", async () => {
    const { h } = devConsole();
    const response = await h.get("/console/preparacion");
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("<h1>Pedidos</h1>");
    expect(page).toContain('<p class="sub">Hoy · 3 por preparar</p>');
    expect(cardsOf(page)).toEqual([
      { href: "/console/preparacion/demo-order-1", name: "Carla", chip: "Cambió", line: "4 productos · Recoge en tienda · cambió 7:35 a. m." },
      {
        href: "/console/preparacion/demo-order-2",
        name: "Don Mario",
        chip: "Nuevo",
        line: "2 productos · Entrega: frente a la iglesia, casa verde · confirmado 7:48 a. m.",
      },
      { href: "/console/preparacion/demo-order-3", name: "Cliente sin nombre", chip: "Nuevo", line: "2 productos · Recoge en tienda · confirmado 7:56 a. m." },
    ]);
    // The list is for finding an order: its buttons and total are on the order's page.
    expect(page).not.toContain("<form");
    expect(page).not.toContain("Total");
    expect(page).toContain('<meta http-equiv="refresh" content="15;url=/console/preparacion">');
  });

  it("shows how long an order has waited once it passes the limit, and puts packed orders last", async () => {
    const base = demoOrders(0)[2]!;
    const at = (orderId: string, state: OrderView["state"], minutesAgo: number, customerName: string) =>
      (nowMs: number): StoredOrder => ({ ...base, customerName, confirmedAtMs: nowMs - minutesAgo * MINUTE, order: { ...base.order, orderId, state } });
    const { h } = devConsole((nowMs) =>
      [at("o-ready", "listo", 90, "Sofía"), at("o-late", "confirmado", 95, "Ana"), at("o-wait", "confirmado", 47, "Luis"), at("o-new", "preparando", 5, "Rosa")].map((f) =>
        f(nowMs),
      ),
    );
    const page = await (await h.get("/console/preparacion")).text();
    expect(cardsOf(page).map(({ name, chip }) => [name, chip])).toEqual([
      ["Ana", "1 h 35 min"],
      ["Luis", "47 min"],
      ["Rosa", "Preparando"],
      ["Sofía", "Listo"],
    ]);
    expect(page).toContain('<p class="sub">Hoy · 3 por preparar</p>');
    expect(page).toContain('<a class="card order packed" id="o-ready"');
  });

  it("picks one chip per card: ready, then changed, then waiting too long, then new or preparing", () => {
    const order = demoOrders(0)[2]!.order;
    const card = (over: Partial<PreparationCard>, state: OrderView["state"] = "confirmado"): PreparationCard => ({
      order: { ...order, state },
      customerName: null,
      confirmedAtMs: 0,
      changedLineIds: [],
      ...over,
    });
    const limit = LATE_AFTER_MINUTES * MINUTE;
    expect(chipFor(card({}), limit - MINUTE)).toEqual({ label: "Nuevo", tone: "new" });
    expect(chipFor(card({}), limit)).toEqual({ label: `${LATE_AFTER_MINUTES} min`, tone: "late" });
    expect(chipFor(card({}, "preparando"), 0)).toEqual({ label: "Preparando", tone: "" });
    expect(chipFor(card({ changedLineIds: ["d3-1"] }), limit * 3)).toEqual({ label: "Cambió", tone: "chg" });
    expect(chipFor(card({ changedLineIds: ["d3-1"] }, "listo"), limit * 3)).toEqual({ label: "Listo", tone: "ok" });
    expect(chipFor(card({}), 120 * MINUTE)).toEqual({ label: "2 h", tone: "late" });
  });

  it("opens an order from its card: version, the change, every line, the total and Listo", async () => {
    const { h } = devConsole();
    const [first] = cardsOf(await (await h.get("/console/preparacion")).text());
    const response = await h.get(first!.href);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('<a class="back" href="/console/preparacion" aria-label="Volver">←</a>');
    expect(page).toContain("<h1>Carla</h1>");
    expect(page).toContain('<p class="sub">Versión 2 · Recoge en tienda</p>');
    expect(page).toContain("Carla cambió el pedido a las 7:35 a. m. Revisá la línea marcada.");
    expect(page).toContain(`Total ${formatLempiras(34500)}`);
    expect(page).toContain("Al marcar Listo se le avisa a Carla con el total.");
    expect(page).toContain('<button class="primary">Listo</button>');
    // Only the changed line is highlighted.
    expect(lineOf(page, "Azúcar 1 lb")).toMatch(/^<li class="line changed">[\s\S]*<span class="chip chg">Cambió<\/span>/);
    expect(lineOf(page, "Aceite Clover 1 L")).toMatch(/^<li class="line">/);
    // An unticked line has its check and "No hay"; a ticked one has neither button.
    expect(lineOf(page, "Aceite Clover 1 L")).toContain('aria-label="Ya está: Aceite Clover 1 L"');
    expect(lineOf(page, "Aceite Clover 1 L")).toContain('<button class="no_hay">No hay</button>');
    expect(lineOf(page, "Arroz 1 lb")).toContain('<span class="box done" role="img" aria-label="Ya está">✓</span>');
    expect(lineOf(page, "Arroz 1 lb")).not.toContain("<button");
    // Every form carries the version on screen.
    expect(new Set([...page.matchAll(/name="version" value="(\d+)"/g)].map(([, v]) => v))).toEqual(new Set(["2"]));
  });

  it("puts the engine's own key on each tap (D-44), so the real engine accepts it and a double tap saves once", async () => {
    const { h } = devConsole();
    const page = await (await h.get("/console/preparacion/demo-order-1")).text();
    expect(page).toContain(`name="operationKey" value="${staffKey({ type: "mark_ready", orderId: "demo-order-1", version: 2 })}"`);
    expect(page).toContain(`name="operationKey" value="${staffKey({ type: "mark_line", orderId: "demo-order-1", version: 2, lineId: "d1-1", mark: "listo", substituteProductId: null })}"`);
  });

  it("shows a new order with Empezar, a delivery's place, and no total promised when a price is missing", async () => {
    const { h } = devConsole();
    const page = await (await h.get("/console/preparacion/demo-order-2")).text();
    expect(page).toContain('<p class="sub">Versión 1 · Entrega a domicilio</p>');
    expect(page).toContain("Entrega: frente a la iglesia, casa verde");
    expect(page).toContain("Total: falta precio");
    expect(page).toContain('<button class="wide">Empezar a preparar</button>');
    expect(page).toContain("Al marcar Listo se le avisa a Don Mario.");
    expect(page).not.toContain("changed-note");
    expect(lineOf(page, "la manteca de la roja")).toContain("&quot;la manteca de la roja&quot;");

    const unnamed = await (await h.get("/console/preparacion/demo-order-3")).text();
    expect(unnamed).toContain("<h1>Cliente sin nombre</h1>");
    expect(unnamed).toContain("Al marcar Listo se le avisa al cliente con el total.");
  });

  it("escapes what customers wrote, on the list and on the order", async () => {
    const hostile: StoredOrder = {
      ...demoOrders(0)[1]!,
      customerName: "<script>alert(1)</script>",
    };
    const { h } = devConsole(() => [hostile]);
    for (const path of ["/console/preparacion", "/console/preparacion/demo-order-2"]) {
      const page = await (await h.get(path)).text();
      expect(page, path).not.toContain("<script>alert(1)</script>");
      expect(page, path).toContain("&lt;script&gt;");
    }
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
    const { h } = devConsole(() => [pinned]);
    expect(await (await h.get("/console/preparacion")).text()).toContain("Entrega: &lt;b&gt;casa&lt;/b&gt;");
    const page = await (await h.get("/console/preparacion/demo-order-2")).text();
    expect(page).toContain("Entrega: &lt;b&gt;casa&lt;/b&gt;");
    expect(page).toContain('href="https://www.google.com/maps?q=10.123456,-80.654321"');
    expect(page).toContain("Ver ubicación");
    expect(page).not.toContain("Envío");
  });

  it("a tick stays on the order; Listo goes back to the list; a tap on an old version says the order changed", async () => {
    const { h, engine } = devConsole();
    const tick = await post(h, { type: "mark_line", orderId: "demo-order-1", version: "2", lineId: "d1-1", mark: "listo", operationKey: "k-0" });
    expect(tick.status).toBe(303);
    expect(tick.headers.get("location")).toBe("/console/preparacion/demo-order-1");

    const ready = await post(h, { type: "mark_ready", orderId: "demo-order-1", version: "2", operationKey: "k-1" });
    expect(ready.status).toBe(303);
    expect(ready.headers.get("location")).toBe("/console/preparacion#demo-order-1");
    expect((await engine.preparationList(devStore())).find((c) => c.order.orderId === "demo-order-1")?.order.state).toBe("listo");
    const list = await (await h.get("/console/preparacion")).text();
    expect(cardsOf(list).at(-1)).toMatchObject({ name: "Carla", chip: "Listo" });
    expect(list).toContain("Hoy · 2 por preparar");
    const handed = await (await h.get("/console/preparacion/demo-order-1")).text();
    expect(handed).toContain('<button class="primary">Entregado</button>');
    expect(handed).not.toContain('<button class="no_hay">');

    const staleListo = await post(h, { type: "mark_ready", orderId: "demo-order-3", version: "9", operationKey: "k-2" });
    expect(staleListo.headers.get("location")).toBe("/console/preparacion/demo-order-3?aviso=cambio");
    const page = await (await h.get("/console/preparacion/demo-order-3?aviso=cambio")).text();
    expect(page).toContain("Este pedido cambió. Revisá la versión nueva.");
    expect(page).toContain("Versión 1");
    expect((await engine.preparationList(devStore())).find((c) => c.order.orderId === "demo-order-3")?.order.state).toBe("confirmado");

    const staleLine = await post(h, { type: "mark_line", orderId: "demo-order-3", version: "9", lineId: "d3-1", mark: "listo", operationKey: "k-3" });
    expect(staleLine.headers.get("location")).toBe("/console/preparacion/demo-order-3?aviso=cambio");

    const gone = await post(h, { type: "mark_ready", orderId: "no-such-order", version: "1", operationKey: "k-4" });
    expect(gone.headers.get("location")).toBe("/console/preparacion?aviso=falta");
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

describe("an order's page", () => {
  /** Store A has the demo orders; store B has none. Each read is recorded with its store. */
  async function twoStores() {
    const a = await storeWithStaff();
    const b = await storeWithStaff();
    const engine = new MemoryEngine((tenant) => (tenant.businessId === a.businessId ? demoOrders(0) : []));
    const reads: string[] = [];
    const list = engine.preparationList.bind(engine);
    engine.preparationList = async (tenant) => {
      reads.push(tenant.businessId);
      return list(tenant);
    };
    const h = harness({ engine });
    return { h, a, b, reads };
  }

  it("opens for its own store's staff", async () => {
    const { h, a } = await twoStores();
    const cookie = await login(h, a.businessId, a.members[1]!.userId);
    const response = await send(h, "/console/preparacion/demo-order-1", { cookie });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Carla</h1>");
  });

  it("never shows another store's order: the ID from the address is looked up in the session's own list only", async () => {
    const { h, a, b, reads } = await twoStores();
    const outsider = await login(h, b.businessId, b.members[0]!.userId);
    const response = await send(h, "/console/preparacion/demo-order-1", { cookie: outsider });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/console/preparacion?aviso=falta");
    const body = await response.text();
    expect(body).not.toContain("Carla");
    expect(reads).toEqual([b.businessId]);
    expect(reads).not.toContain(a.businessId);

    const page = await (await send(h, "/console/preparacion?aviso=falta", { cookie: outsider })).text();
    expect(page).toContain("Ese pedido ya no está en la lista.");
    expect(page).not.toContain("Carla");
  });

  it("finds nothing for an odd address", async () => {
    const { h, a } = await twoStores();
    const cookie = await login(h, a.businessId, a.members[1]!.userId);
    for (const id of ["%3Cscript%3E", "demo-order-1%2F..", "x".repeat(200)]) {
      const response = await send(h, `/console/preparacion/${id}`, { cookie });
      expect(response.status, id).toBe(302);
      expect(response.headers.get("location"), id).toBe("/console/preparacion?aviso=falta");
    }
  });
});

function devStore() {
  return { businessId: "dev-store" };
}
