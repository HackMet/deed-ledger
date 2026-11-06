import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Engine, EngineResult, MemberContext } from "../src/application/engine";
import { staffKey } from "../src/application/engine/order-engine";
import type { ActionEnvelope, ConsoleAction } from "../src/domain/contract/actions";
import { INVITE_TTL_MS } from "../src/domain/console-auth";
import { orderCode } from "../src/domain/order-code";
import { hashToken, newToken } from "../src/infrastructure/tokens";
import { addAndPickup, ids, moreSugar, staleReady } from "./fixtures/contract";
import { type Harness, harness } from "./helpers/harness";
import { AGENT_ID, changeAndApprove, engine, firstDeliveryOrder, firstPickupOrder, forgetFulfillment, newStore, placeFirstOrder, save, T0, tap } from "./helpers/orders";
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

/** A pickup order placed and confirmed through the engine; returns its id. Pickup: K13 delivers only a known fulfillment. */
async function confirmed(s: Store, customerId: string = ids.customer, at = T0): Promise<string> {
  const v1 = await placeFirstOrder(s, customerId, at, firstPickupOrder);
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

  it("names the customer on the list once they gave a name, escaped, and says Cliente until then", async () => {
    const h = harness();
    const s = await storeWithSession();
    const named = `customer-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO customers (id, business_id, phone, name, name_saved_at_ms, created_at_ms) VALUES (?, ?, ?, ?, 1, 0)`)
      .bind(named, s.businessId, newPhone(), "Ana <b>")
      .run();
    await confirmed(s, named);
    await confirmed(s);
    const page = await (await get(h, "/console/pedidos", await login(h, s))).text();
    expect(page).toContain("Ana &lt;b&gt; · Nuevo");
    expect(page).toContain("Cliente · Nuevo");
  });

  it("colours an order yellow while a change waits for review (K12)", async () => {
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
    const cookie = await login(h, s);
    const page = await (await get(h, "/console/pedidos", cookie)).text();
    expect(row(page, orderId)).toBe("none");
    expect(page).toContain("Cliente · Nuevo");
    expect(page).not.toContain("Cancelado");
    const trail = await (await get(h, `/console/pedidos/${orderId}`, cookie)).text();
    expect(trail).toContain("Nuevo · Versión 1");
    expect(trail).not.toContain("Cancelado");
  });

  it("shows the trail with the closure and its reason, and both dependency lists", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    // K12: v2 comes from an approved change: request (3), review (4), v2 (5), v2's confirm (6).
    await changeAndApprove(s, moreSugar, T0 + 3000);
    const cookie = await login(h, s);
    const response = await get(h, `/console/pedidos/${orderId}`, cookie);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Pedido recibido");
    expect(page).toContain("Pedido confirmado");
    expect(page).toMatch(/class="closed">cerrado por .*Pedido recibido \(paso 5\).*\(reemplazado\)/s);
    expect(page).toContain("Depende de: Pedido recibido (paso 1)");
    expect(page).toContain("Bloquea: Pedido confirmado (paso 2), Pedido recibido (paso 5)");
    expect(page).toContain("mensaje");

    await cancelOrder(s, orderId, 2);
    const after = await (await get(h, `/console/pedidos/${orderId}`, cookie)).text();
    expect(after).toMatch(/cerrado por .*Pedido cancelado \(paso 7\).*\(cancelado\)/s);
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

  it("shows the agent beside each customer fact, and none beside a staff tap (C11)", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    await save(await engine.onConsoleAction(member(s, T0 + 5000), staffTap("start_preparing", orderId, 1)));
    const page = await (await get(h, `/console/pedidos/${orderId}`, await login(h, s))).text();
    // The order_version and the order_confirm are the customer's; the staff tap's line names no agent.
    expect(page.split(`agente ${AGENT_ID}`)).toHaveLength(3);
    expect(page).toContain(`Personal</p>`);
    expect(page).not.toContain(`Personal · agente`);
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

  it("keeps the console's menu on an order's page, with a way back to the list", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    const cookie = await login(h, s);
    const page = await (await get(h, `/console/pedidos/${encodeURIComponent(orderId)}`, cookie)).text();
    expect(page).toContain(`<nav class="tabs">`);
    expect(page).toContain(`<a class="back" href="/console/pedidos"`);
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
    const detail = await (await get(h, `/console/pedidos/${pending.orderId}`, cookie)).text();
    expect(detail).toContain(code);
    expect(await (await get(h, "/console/pedidos", cookie)).text()).toContain(`<strong>${code}</strong>`);
  });

  it("encodes Crockford base32 from the SHA-256 of the fact id", async () => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("fact-1")));
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const bits = [...digest.slice(0, 4)].map((b) => b.toString(2).padStart(8, "0")).join("");
    const expected = [0, 5, 10, 15, 20].map((i) => alphabet[parseInt(bits.slice(i, i + 5), 2)]).join("");
    expect(await orderCode("fact-1")).toBe(`#${expected}`);
  });


  it("shows the live version as current: its lines in the list, its number and state in the trail", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    await changeAndApprove(s, addAndPickup, T0 + 3000);
    const cookie = await login(h, s);
    const page = await (await get(h, "/console/pedidos", cookie)).text();
    expect(page).toContain("jabón más × 1");
    expect(page).toContain("azucar-1lb × 2");
    expect(page).toContain("Cliente · Nuevo");
    const trail = await (await get(h, `/console/pedidos/${orderId}`, cookie)).text();
    // Approved: the new version, and no longer yellow (K12).
    expect(trail).toContain("Nuevo · Versión 2</p>");
  });

  it("ignores orders.current_version: a tampered cache changes neither version, lines nor state", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    await env.DB.prepare(`UPDATE orders SET current_version = 2 WHERE id = ?`).bind(orderId).run();
    const cookie = await login(h, s);
    const page = await (await get(h, "/console/pedidos", cookie)).text();
    expect(page).toContain("Cliente · Nuevo");
    expect(page).not.toContain("Por confirmar");
    expect(row(page, orderId)).toBe("none");
    const trail = await (await get(h, `/console/pedidos/${orderId}`, cookie)).text();
    expect(trail).toContain("Nuevo · Versión 1");
    expect(trail).not.toContain("Versión 2");
  });

  it("does not count a delivered tap whose confirm was closed: no check, state from live facts", async () => {
    const h = harness();
    const s = await storeWithSession();
    const orderId = await confirmed(s);
    for (const [i, type] of (["start_preparing", "mark_ready", "mark_delivered"] as const).entries()) {
      await save(await engine.onConsoleAction(member(s, T0 + 5000 + i), staffTap(type, orderId, 1)));
    }
    // The engine refuses a change after delivery, so close the confirm directly, as a supersede would.
    const confirmFact = (await env.DB.prepare(`SELECT confirm_fact_id AS id FROM orders WHERE id = ?`).bind(orderId).first<{ id: string }>())!.id;
    await env.DB.prepare(
      `INSERT INTO fact_closures (business_id, fact_id, closed_by_fact_id, reason, closed_at_ms) VALUES (?, ?, 'not-its-ancestor', 'superseded', ?)`,
    )
      .bind(s.businessId, confirmFact, T0 + 9000)
      .run();
    const cookie = await login(h, s);
    const page = await (await get(h, "/console/pedidos", cookie)).text();
    expect(row(page, orderId)).toBe("none");
    expect(page).not.toContain("✓");
    expect(page).toContain("Cliente · Por confirmar");
    const trail = await (await get(h, `/console/pedidos/${orderId}`, cookie)).text();
    expect(trail).toContain("Por confirmar · Versión 1");
    expect(trail).not.toContain("✓");
    expect(trail).not.toContain("Entregado");
  });

  it("ignores another store's facts, evidence, closures and dependencies, even when their ids collide", async () => {
    const h = harness();
    const mine = await storeWithSession();
    const theirs = await newStore();
    const orderId = await confirmed(mine);
    const [version, confirm] = (
      await env.DB.prepare(`SELECT id FROM facts WHERE business_id = ? AND kind IN ('order_version', 'order_confirm') ORDER BY rowid`)
        .bind(mine.businessId)
        .all<{ id: string }>()
    ).results.map((r) => r.id) as [string, string];
    const foreignCancel = crypto.randomUUID();
    const insertFact = (id: string, kind: string, body: object) =>
      env.DB.prepare(
        `INSERT INTO facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json) VALUES (?, ?, ?, ?, 'x', ?, ?, ?)`,
      ).bind(id, theirs.businessId, kind, `op-${id}`, T0 + 4000, T0 + 4000, JSON.stringify(body));
    await env.DB.batch([
      // A live cancel of "my" order id, in the other store.
      insertFact(foreignCancel, "order_cancel", { orderId, version: 1 }),
      // Evidence, a closure and an edge about my fact ids, in the other store.
      env.DB.prepare(`INSERT INTO fact_evidence (business_id, fact_id, kind, ref_id) VALUES (?, ?, 'member', 'foreign-member')`).bind(theirs.businessId, confirm),
      env.DB.prepare(
        `INSERT INTO fact_closures (business_id, fact_id, closed_by_fact_id, reason, closed_at_ms) VALUES (?, ?, ?, 'cancelled', ?)`,
      ).bind(theirs.businessId, confirm, foreignCancel, T0 + 4000),
      env.DB.prepare(`INSERT INTO fact_dependencies (business_id, fact_id, depends_on_fact_id) VALUES (?, ?, ?)`).bind(theirs.businessId, version, confirm),
      // An ancestor edge of the other store that would reach a fact closed in MY store.
      env.DB.prepare(`INSERT INTO fact_dependencies (business_id, fact_id, depends_on_fact_id) VALUES (?, ?, 'ghost')`).bind(theirs.businessId, confirm),
      env.DB.prepare(
        `INSERT INTO fact_closures (business_id, fact_id, closed_by_fact_id, reason, closed_at_ms) VALUES (?, 'ghost', 'ghost-closer', 'cancelled', ?)`,
      ).bind(mine.businessId, T0 + 4000),
    ]);
    const cookie = await login(h, mine);
    const page = await (await get(h, "/console/pedidos", cookie)).text();
    expect(row(page, orderId)).toBe("none");
    expect(page).toContain("Cliente · Nuevo");
    const trail = await (await get(h, `/console/pedidos/${orderId}`, cookie)).text();
    expect(trail).toContain("Nuevo · Versión 1");
    expect(trail).not.toContain("Cancelado");
    expect(trail).not.toContain("Pedido cancelado");
    expect(trail).not.toContain("cerrado por");
    expect(trail).not.toContain("Personal");
    expect(trail).not.toContain("Depende de: Pedido confirmado");
  });
});

/** The real engine, keeping each console result so a test can check what the engine decided; the route saves it (#63). */
function recordingEngine() {
  const results: EngineResult[] = [];
  const wrapped: Engine = {
    onBurst: (context, reading, matches) => engine.onBurst(context, reading, matches),
    onCustomerAction: (...a) => engine.onCustomerAction(...a),
    verifyClaims: (...a) => engine.verifyClaims(...a),
    preparationList: (...a) => engine.preparationList(...a),
    onConsoleAction: async (...a) => {
      const result = await engine.onConsoleAction(...a);
      results.push(result);
      return result;
    },
  };
  return { wrapped, results };
}

async function post(h: Harness, path: string, cookie: string, fields: Record<string, string>) {
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(
    new IncomingRequest(`https://worker.test${path}`, {
      method: "POST",
      headers: { origin: "https://worker.test", cookie },
      body: new URLSearchParams(fields),
      redirect: "manual",
    }),
    h.env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";

describe("K12: Pedidos shows a change waiting for review and sends the answer to the engine", () => {
  /** A confirmed order with "agregale un jabón más, lo paso a traer" waiting for review. */
  async function withRequest(s: Store) {
    const orderId = await confirmed(s);
    const result = await engine.onBurst(s.context({ nowMs: T0 + 3000 }), addAndPickup, []);
    await save(result);
    const requestId = result.outcome.type === "order_status" ? result.outcome.order!.openChangeRequest!.id : "";
    return { orderId, requestId };
  }

  it("shows the request yellow with its diff and both answers, each with a required reason", async () => {
    const h = harness();
    const s = await storeWithSession();
    const { orderId, requestId } = await withRequest(s);
    const cookie = await login(h, s);
    expect(row(await (await get(h, "/console/pedidos", cookie)).text(), orderId)).toBe("yellow");
    const page = await (await get(h, `/console/pedidos/${orderId}`, cookie)).text();
    expect(page).toContain("El cliente pidió un cambio");
    expect(page).toContain("Agregar: jabón más × 1");
    expect(page).toContain("Aprobar ✓");
    expect(page).toContain("Rechazar ✗");
    expect(page.match(/<input name="motivo" required maxlength="200"/g)).toHaveLength(2);
    expect(page.match(new RegExp(`name="cambio" value="${requestId}"`, "g"))).toHaveLength(2);
    expect(page).toContain("Cambio pedido por el cliente");
  });

  it("approves through the engine; the trail shows the review with its reason, and the row is normal again", async () => {
    const { wrapped, results } = recordingEngine();
    const h = harness({ engine: wrapped });
    const s = await storeWithSession();
    const { orderId, requestId } = await withRequest(s);
    const cookie = await login(h, s, "owner");
    const csrf = csrfOf(await (await get(h, `/console/pedidos/${orderId}`, cookie)).text());
    const response = await post(h, `/console/pedidos/${orderId}/revision`, cookie, { csrf, cambio: requestId, decision: "approve", motivo: " Va, sí hay " });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/console/pedidos/${orderId}?aviso=aprobado`);
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toMatchObject({ type: "action_saved", order: { version: 2, lastReview: { decision: "approve", reason: "Va, sí hay" } } });

    const page = await (await get(h, `/console/pedidos/${orderId}?aviso=aprobado`, cookie)).text();
    expect(page).toContain("Cambio aprobado. Le avisamos al cliente.");
    expect(page).not.toContain("El cliente pidió un cambio");
    expect(page).toContain("Cambio revisado");
    expect(page).toContain("Aprobado: Va, sí hay");
    expect(page).toContain("Versión 2");
    expect(row(await (await get(h, "/console/pedidos", cookie)).text(), orderId)).toBe("none");
  });

  it("declines with the reason in the trail; a missing reason never reaches the engine", async () => {
    const { wrapped, results } = recordingEngine();
    const h = harness({ engine: wrapped });
    const s = await storeWithSession();
    const { orderId, requestId } = await withRequest(s);
    const cookie = await login(h, s);
    const csrf = csrfOf(await (await get(h, `/console/pedidos/${orderId}`, cookie)).text());
    const path = `/console/pedidos/${orderId}/revision`;

    const empty = await post(h, path, cookie, { csrf, cambio: requestId, decision: "decline", motivo: "   " });
    expect(empty.headers.get("location")).toBe(`/console/pedidos/${orderId}?aviso=motivo`);
    expect((await post(h, path, cookie, { csrf, cambio: requestId, decision: "maybe", motivo: "x" })).status).toBe(400);
    expect(results).toHaveLength(0);

    const declined = await post(h, path, cookie, { csrf, cambio: requestId, decision: "decline", motivo: "No hay jabón" });
    expect(declined.headers.get("location")).toBe(`/console/pedidos/${orderId}?aviso=rechazado`);
    const page = await (await get(h, `/console/pedidos/${orderId}`, cookie)).text();
    expect(page).toContain("Rechazado: No hay jabón");
    expect(page).toContain("Versión 1");
    // The same answer again is the first one's duplicate: the screen says it saved.
    const again = await post(h, path, cookie, { csrf, cambio: requestId, decision: "approve", motivo: "Mejor sí" });
    expect(again.headers.get("location")).toBe(`/console/pedidos/${orderId}?aviso=rechazado`);
    expect(results[1]!.outcome.type).toBe("duplicate");
  });
});

describe("K13: Pedidos dispatches a ready delivery order with a courier and shows it blue until delivered", () => {
  /** Names the store's members, so the screen and the notice can show them; returns the staff member's id. */
  async function nameMembers(s: Store): Promise<string> {
    await env.DB.prepare(
      `UPDATE users SET display_name = CASE (SELECT role FROM memberships WHERE business_id = ?1 AND user_id = users.id)
         WHEN 'staff' THEN 'Marvin' ELSE 'Doña Johana' END
       WHERE id IN (SELECT user_id FROM memberships WHERE business_id = ?1)`,
    )
      .bind(s.businessId)
      .run();
    return (await env.DB.prepare(`SELECT user_id FROM memberships WHERE business_id = ? AND role = 'staff'`).bind(s.businessId).first<{ user_id: string }>())!
      .user_id;
  }

  /** An order placed with `reading`, confirmed and taken to listo through the engine; returns its id. */
  async function readyOrder(s: Store, reading = firstDeliveryOrder): Promise<string> {
    const v1 = await placeFirstOrder(s, ids.customer, T0, reading);
    await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), tap(v1.orderId, 1)));
    for (const [i, type] of (["start_preparing", "mark_ready"] as const).entries()) {
      await save(await engine.onConsoleAction(member(s, T0 + 5000 + i), staffTap(type, v1.orderId, 1)));
    }
    return v1.orderId;
  }

  it("lists only active members, dispatches through the engine, then shows blue with the courier until delivered", async () => {
    const { wrapped, results } = recordingEngine();
    const h = harness({ engine: wrapped });
    const s = await storeWithSession();
    const marvin = await nameMembers(s);
    const orderId = await readyOrder(s);
    const cookie = await login(h, s);
    // Added after signing in, so the login helper's staff member is the active one.
    const goneId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, phone, display_name, created_at_ms) VALUES (?, ?, 'Ya no trabaja', 0)`).bind(goneId, newPhone()),
      env.DB.prepare(`INSERT INTO memberships (business_id, user_id, role, active, created_at_ms) VALUES (?, ?, 'staff', 0, 0)`).bind(s.businessId, goneId),
    ]);
    const ready = await (await get(h, `/console/pedidos/${orderId}`, cookie)).text();
    expect(ready).toContain("¿Quién lo lleva?");
    expect(ready).toContain(`<option value="${marvin}">Marvin</option>`);
    expect(ready).toContain("Doña Johana");
    expect(ready).not.toContain("Ya no trabaja");
    expect(ready).not.toContain("Entregado ✓");

    const path = `/console/pedidos/${orderId}/paso`;
    const csrf = csrfOf(ready);
    const sent = await post(h, path, cookie, { csrf, paso: "despachar", version: "1", repartidor: marvin });
    expect(sent.headers.get("location")).toBe(`/console/pedidos/${orderId}?aviso=despachado`);
    expect(results[0]).toMatchObject({
      outcome: { type: "action_saved", order: { state: "en_camino" } },
      notices: [{ notice: { type: "order_dispatched", courierName: "Marvin" } }],
    });

    const list = await (await get(h, "/console/pedidos", cookie)).text();
    expect(row(list, orderId)).toBe("blue");
    expect(list).toContain("Cliente · En camino · Lo lleva Marvin");
    const out = await (await get(h, `/console/pedidos/${orderId}?aviso=despachado`, cookie)).text();
    expect(out).toContain("Va en camino. Le avisamos al cliente.");
    expect(out).toContain("En camino con Marvin");
    expect(out).toContain("Entregado ✓");
    expect(out).not.toContain("¿Quién lo lleva?");

    // A second dispatch tap is the first one's duplicate: the screen reports it saved.
    expect((await post(h, path, cookie, { csrf, paso: "despachar", version: "1", repartidor: marvin })).headers.get("location")).toBe(
      `/console/pedidos/${orderId}?aviso=despachado`,
    );
    expect(results[1]!.outcome.type).toBe("duplicate");

    const done = await post(h, path, cookie, { csrf, paso: "entregar", version: "1" });
    expect(done.headers.get("location")).toBe(`/console/pedidos/${orderId}?aviso=entregado`);
    expect(row(await (await get(h, "/console/pedidos", cookie)).text(), orderId)).toBe("check");
    const trail = await (await get(h, `/console/pedidos/${orderId}`, cookie)).text();
    expect(trail).toContain("En camino con Marvin");
    expect(trail).not.toContain("Entregado ✓</button>");
  });

  it("a courier the store doesn't have is named in the notice; a bad form never reaches the engine", async () => {
    const { wrapped, results } = recordingEngine();
    const h = harness({ engine: wrapped });
    const s = await storeWithSession();
    await nameMembers(s);
    const orderId = await readyOrder(s);
    const cookie = await login(h, s);
    const csrf = csrfOf(await (await get(h, `/console/pedidos/${orderId}`, cookie)).text());
    const path = `/console/pedidos/${orderId}/paso`;
    for (const fields of [{ paso: "volar", version: "1" }, { paso: "despachar", version: "1" }, { paso: "entregar", version: "uno" }]) {
      expect((await post(h, path, cookie, { csrf, ...fields })).status).toBe(400);
    }
    expect(results).toHaveLength(0);
    const refused = await post(h, path, cookie, { csrf, paso: "despachar", version: "1", repartidor: "member-made-up" });
    expect(refused.headers.get("location")).toBe(`/console/pedidos/${orderId}?aviso=repartidor`);
    expect((await post(h, path, cookie, { csrf, paso: "entregar", version: "1" })).headers.get("location")).toBe(
      `/console/pedidos/${orderId}?aviso=paso`,
    );
  });

  it("pickup offers Entregado at listo; with no fulfillment recorded, it says what is missing instead", async () => {
    const h = harness({ engine: recordingEngine().wrapped });
    const s = await storeWithSession();
    const pickupId = await readyOrder(s, firstPickupOrder);
    const cookie = await login(h, s);
    const pickupPage = await (await get(h, `/console/pedidos/${pickupId}`, cookie)).text();
    expect(pickupPage).toContain("Entregado ✓");
    expect(pickupPage).not.toContain("¿Quién lo lleva?");

    const t = await storeWithSession();
    const unknownId = await readyOrder(t, firstPickupOrder);
    await forgetFulfillment(t.businessId, unknownId);
    const unknownCookie = await login(h, t);
    const unknownPath = `/console/pedidos/${unknownId}`;
    const unknownPage = await (await get(h, unknownPath, unknownCookie)).text();
    expect(unknownPage).toContain("Falta saber si lo recogen o se lo llevamos.");
    expect(unknownPage).not.toContain("Entregado ✓");
    expect(unknownPage).not.toContain("¿Quién lo lleva?");

    // The way out: a person says the customer has it, and the order is closed with nothing guessed.
    expect(unknownPage).toContain("Ya lo tiene el cliente ✓");
    const csrf = csrfOf(unknownPage);
    const closed = await post(h, `${unknownPath}/paso`, unknownCookie, { csrf, paso: "entregar", version: "1" });
    expect(closed.headers.get("location")).toBe(`${unknownPath}?aviso=entregado`);
    expect(await env.DB.prepare(`SELECT state FROM orders WHERE id = ?`).bind(unknownId).first()).toEqual({ state: "entregado" });
  });
});
