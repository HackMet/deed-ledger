import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import { staffKey } from "../src/application/engine/order-engine";
import type { ActionEnvelope, ConsoleAction } from "../src/domain/contract/actions";
import { INVITE_TTL_MS } from "../src/domain/console-auth";
import { orderCode } from "../src/domain/order-code";
import { hashToken, newToken } from "../src/infrastructure/tokens";
import { ids, moreSugar, staleReady } from "./fixtures/contract";
import { type Harness, harness } from "./helpers/harness";
import { engine, newStore, placeFirstOrder, save, T0, tap } from "./helpers/orders";
import { newPhone, seedStore } from "./helpers/seed";

type Store = Awaited<ReturnType<typeof newStore>>;

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function get(h: Harness, path: string, cookie?: string) {
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(
    new IncomingRequest(`https://worker.test${path}`, { headers: cookie === undefined ? {} : { cookie }, redirect: "manual" }),
    h.env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** A session for the store's member, opened through the real invite. Returns the cookie. */
async function login(h: Harness, store: Store, role: "owner" | "staff" = "staff"): Promise<string> {
  const member = await env.DB.prepare(
    `SELECT user_id AS id FROM memberships WHERE business_id = ? AND role = ?`,
  )
    .bind(store.businessId, role)
    .first<{ id: string }>();
  const code = newToken();
  const now = h.clock.now();
  await env.DB.prepare(
    `INSERT INTO console_invites (id, business_id, user_id, token_hash, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), store.businessId, member!.id, await hashToken(code), now + INVITE_TTL_MS, now)
    .run();
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(
    new IncomingRequest("https://worker.test/console/entrar", {
      method: "POST",
      headers: { origin: "https://worker.test" },
      body: new URLSearchParams({ codigo: code }),
      redirect: "manual",
    }),
    h.env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(303);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

/** A store with an owner and one staff member, seeded the way `newStore` does, plus both roles. */
async function storeWithSession() {
  const base = await seedStore({
    members: [
      { phone: newPhone(), role: "owner" },
      { phone: newPhone(), role: "staff" },
    ],
  });
  const s = await newStore();
  // newStore seeds its own business; sessions need members, so reuse its business with the same
  // member rows through memberships of the second store.
  const members = base.members;
  await env.DB.batch(
    members.map((m) =>
      env.DB.prepare(
        `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms)
         SELECT ?1, ?2, id, ?3, 0 FROM locations WHERE business_id = ?1`,
      ).bind(s.businessId, m.userId, m.role),
    ),
  );
  return s;
}

const member = (s: Store, nowMs: number): MemberContext => ({
  businessId: s.businessId,
  memberId: ids.staff,
  role: "staff",
  canApproveFiado: false,
  nowMs,
});

const staffTap = (type: "start_preparing" | "mark_ready" | "mark_delivered", orderId: string, version: number): ActionEnvelope<ConsoleAction> => {
  const action = { type, orderId, version } as const;
  return { ...staleReady, operationKey: staffKey(action), action };
};

/** An order placed and confirmed through the engine; returns its id. */
async function confirmed(s: Store, customerId: string = ids.customer, at = T0): Promise<string> {
  const v1 = await placeFirstOrder(s, customerId, at);
  await save(await engine.onCustomerAction(s.context({ customerId, nowMs: at + 1000 }), tap(v1.orderId, 1, { actor: { type: "customer", customerId } })));
  return v1.orderId;
}

const cancelOrder = async (s: Store, orderId: string, version: number, customerId: string = ids.customer) =>
  save(
    await engine.onCustomerAction(
      s.context({ customerId, nowMs: T0 + 9000 }),
      tap(orderId, version, {
        operationKey: `cancel:${orderId}:v${version}`,
        actor: { type: "customer", customerId },
        action: { type: "cancel_order", orderId, version } }),
    ),
  );

const row = (html: string, orderId: string) => new RegExp(`<li class="order (\\w+)"><a href="/console/pedidos/${orderId}">`).exec(html)?.[1];

describe("K5: the Orders screen reads the ledger", () => {
  it("paints each order by its facts: none, changed, cancelled, delivered", async () => {
    const h = harness();
    const s = await storeWithSession();
    const customers = [1, 2, 3, 4].map(() => crypto.randomUUID());
    const plain = await confirmed(s, customers[0]);
    const changed = await confirmed(s, customers[1]);
    await save(await engine.onBurst(s.context({ customerId: customers[1]!, nowMs: T0 + 3000 }), moreSugar, []));
    const cancelled = await confirmed(s, customers[2]);
    await cancelOrder(s, cancelled, 1, customers[2]);
    const delivered = await confirmed(s, customers[3]);
    for (const [i, type] of (["start_preparing", "mark_ready", "mark_delivered"] as const).entries()) {
      await save(await engine.onConsoleAction(member(s, T0 + 5000 + i), staffTap(type, delivered, 1)));
    }

    const response = await get(h, "/console/pedidos", await login(h, s));
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(row(page, plain)).toBe("none");
    expect(row(page, changed)).toBe("yellow");
    expect(row(page, cancelled)).toBe("red");
    expect(row(page, delivered)).toBe("check");
    expect(page).toContain("✓ Entregado");
    expect(page).toContain("Cliente");
  });

  it("shows no check for an order that is ready but not delivered", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    for (const [i, type] of (["start_preparing", "mark_ready"] as const).entries()) {
      await save(await engine.onConsoleAction(member(s, T0 + 5000 + i), staffTap(type, orderId, 1)));
    }
    const page = await (await get(h, "/console/pedidos", await login(h, s))).text();
    expect(row(page, orderId)).toBe("none");
    expect(page).toContain("Listo para entregar");
  });

  it("colours a changed order yellow from its live v2 fact", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    await save(await engine.onBurst(s.context({ nowMs: T0 + 3000 }), moreSugar, []));
    const page = await (await get(h, "/console/pedidos", await login(h, s))).text();
    expect(row(page, orderId)).toBe("yellow");
  });

  it("ignores orders.state: a tampered cache changes neither colour nor derived state", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    await env.DB.prepare(`UPDATE orders SET state = 'cancelado' WHERE id = ?`).bind(orderId).run();
    const page = await (await get(h, "/console/pedidos", await login(h, s))).text();
    expect(row(page, orderId)).toBe("none");
  });

  it("shows the trail with the closure and its reason, and both dependency lists", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    await save(await engine.onBurst(s.context({ nowMs: T0 + 3000 }), moreSugar, []));
    const cookie = await login(h, s);
    const response = await get(h, `/console/pedidos/${orderId}`, cookie);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Pedido recibido");
    expect(page).toContain("Pedido confirmado");
    expect(page).toMatch(/class="closed">cerrado por .*Pedido recibido \(paso 3\).*\(reemplazado\)/s);
    expect(page).toContain("Depende de: Pedido recibido (paso 1)");
    expect(page).toContain("Bloquea: Pedido confirmado (paso 2), Pedido recibido (paso 3)");
    expect(page).toContain("mensaje");

    await cancelOrder(s, orderId, 2);
    const after = await (await get(h, `/console/pedidos/${orderId}`, cookie)).text();
    expect(after).toMatch(/cerrado por .*Pedido cancelado \(paso 4\).*\(cancelado\)/s);
    expect(after).toContain("Cancelado");
  });

  it("names a staff tap's actor and its member evidence", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    await save(await engine.onConsoleAction(member(s, T0 + 5000), staffTap("start_preparing", orderId, 1)));
    const page = await (await get(h, `/console/pedidos/${orderId}`, await login(h, s))).text();
    expect(page).toContain("Cambio de estado");
    expect(page).toContain("Personal");
    expect(page).toContain("miembro");
    expect(page).toContain("Depende de: Pedido confirmado (paso 2)");
  });

  it("answers 404 for another store's order, the same as for a missing one", async () => {
    const h = harness();
    const mine = await storeWithSession();
    const theirs = await newStore();
    const foreign = await confirmed(theirs);
    const cookie = await login(h, mine);
    const a = await get(h, `/console/pedidos/${foreign}`, cookie);
    const b = await get(h, `/console/pedidos/${crypto.randomUUID()}`, cookie);
    expect([a.status, b.status]).toEqual([404, 404]);
    expect(await a.text()).toBe(await b.text());
    expect(await (await get(h, "/console/pedidos", cookie)).text()).not.toContain(foreign);
  });

  it("sends nobody without a session to the orders", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    for (const path of ["/console/pedidos", `/console/pedidos/${orderId}`]) {
      const response = await get(h, path);
      expect(response.status).toBe(401);
      const page = await response.text();
      expect(page).toContain("escaneá el código");
      expect(page).not.toContain(orderId);
    }
  });

  it("lets the owner view too, and writes nothing", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    const counts = async () => (await env.DB.prepare(`SELECT (SELECT count(*) FROM facts) AS f, (SELECT count(*) FROM orders) AS o`).first())!;
    const before = await counts();
    const cookie = await login(h, s, "owner");
    expect((await get(h, "/console/pedidos", cookie)).status).toBe(200);
    expect((await get(h, `/console/pedidos/${orderId}`, cookie)).status).toBe(200);
    expect(await counts()).toEqual(before);
  });

  it("derives a stable code from the confirm fact, and none before a confirm", async () => {
    const h = harness();
    const s = await storeWithSession();
    const pending = await placeFirstOrder(s);
    const cookie = await login(h, s);
    const page = await (await get(h, "/console/pedidos", cookie)).text();
    expect(page).toContain(`<a href="/console/pedidos/${pending.orderId}">\n<div class="head"><strong>—</strong>`);

    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), tap(pending.orderId, 1)));
    const confirmFact = (await env.DB.prepare(`SELECT confirm_fact_id AS id FROM orders WHERE id = ?`).bind(pending.orderId).first<{ id: string }>())!.id;
    const code = await orderCode(confirmFact);
    expect(code).toMatch(/^#[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(await orderCode(confirmFact)).toBe(code);
    expect(await orderCode(`${confirmFact}x`)).not.toBe(code);
    expect(await orderCode(null)).toBeNull();
    const after = await (await get(h, "/console/pedidos", cookie)).text();
    expect(after).toContain(`<strong>${code}</strong>`);
    expect(await (await get(h, "/console/pedidos", cookie)).text()).toContain(`<strong>${code}</strong>`);
  });

  it("encodes Crockford base32 from the SHA-256 of the fact id", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("fact-1")));
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const bits = [...digest.slice(0, 4)].map((b) => b.toString(2).padStart(8, "0")).join("");
    const expected = [0, 5, 10, 15, 20].map((i) => alphabet[parseInt(bits.slice(i, i + 5), 2)]).join("");
    expect(await orderCode("fact-1")).toBe(`#${expected}`);
  });
});

