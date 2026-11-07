/**
 * O1: a customer's change still waiting while staff pack the order. The packing screens say a change
 * waits, so it is answered before Listo; once the order is ready the change can only be declined
 * (D-43's window), and the order page, To do and the engine agree on that. Run on the Worker as
 * deployed (DEED_ENGINE=1, with and without CONVERSATION=planner).
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { staffKey } from "../src/application/engine/order-engine";
import { INVITE_TTL_MS } from "../src/domain/console-auth";
import { formatStoreTime } from "../src/domain/store-time";
import { hashToken, newToken } from "../src/infrastructure/tokens";
import { addAndPickup, ids } from "./fixtures/contract";
import { type Harness, harness, testEnv } from "./helpers/harness";
import { engine, firstPickupOrder, newStore, placeFirstOrder, save, T0, tap } from "./helpers/orders";
import { FakeClock } from "./helpers/fakes";
import { newPhone, seedStore } from "./helpers/seed";

type Store = Awaited<ReturnType<typeof newStore>>;

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function send(h: Harness, path: string, cookie: string, fields?: Record<string, string>) {
  const ctx = createExecutionContext();
  const init: RequestInit<IncomingRequestCfProperties> =
    fields === undefined
      ? { headers: { cookie }, redirect: "manual" }
      : { method: "POST", headers: { origin: "https://worker.test", cookie }, body: new URLSearchParams(fields), redirect: "manual" };
  const response = await h.worker.fetch(new IncomingRequest(`https://worker.test${path}`, init), h.env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const page = async (h: Harness, path: string, cookie: string) => (await send(h, path, cookie)).text();
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

/** A store with an owner and a staff member (as console-pedidos.test.ts builds it); returns the store. */
async function storeWithSession(): Promise<Store> {
  const base = await seedStore({
    members: [
      { phone: newPhone(), role: "owner" },
      { phone: newPhone(), role: "staff" },
    ],
  });
  const s = await newStore();
  await env.DB.batch(
    base.members.map((m) =>
      env.DB.prepare(
        `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms)
         SELECT ?1, ?2, id, ?3, 0 FROM locations WHERE business_id = ?1`,
      ).bind(s.businessId, m.userId, m.role),
    ),
  );
  return s;
}

/** A session for the store's staff member (or owner), opened through the real invite. Returns the cookie. */
async function login(h: Harness, s: Store, role: "staff" | "owner" = "staff"): Promise<string> {
  const member = await env.DB.prepare(`SELECT user_id AS id FROM memberships WHERE business_id = ? AND role = ?`)
    .bind(s.businessId, role)
    .first<{ id: string }>();
  const code = newToken();
  const now = h.clock.now();
  await env.DB.prepare(
    `INSERT INTO console_invites (id, business_id, user_id, token_hash, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), s.businessId, member!.id, await hashToken(code), now + INVITE_TTL_MS, now)
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

/** A confirmed pickup order with "agregale un jabón más, lo paso a traer" waiting for the store. */
async function orderWithWaitingChange(s: Store) {
  const v1 = await placeFirstOrder(s, ids.customer, T0, firstPickupOrder);
  await save(await engine.onCustomerAction(s.context({ nowMs: T0 + 1000 }), tap(v1.orderId, 1, { actor: { type: "customer", customerId: ids.customer } })));
  const requested = await engine.onBurst(s.context({ nowMs: T0 + 3000 }), addAndPickup, []);
  await save(requested);
  const requestId = requested.outcome.type === "order_status" ? requested.outcome.order!.openChangeRequest!.id : "";
  expect(requestId).not.toBe("");
  return { orderId: v1.orderId, requestId };
}

/** A staff tap from the packing page, as its form posts it. */
async function staffTap(h: Harness, cookie: string, csrf: string, type: "start_preparing" | "mark_ready", orderId: string) {
  const response = await send(h, "/console/acciones", cookie, {
    csrf,
    type,
    orderId,
    version: "1",
    operationKey: staffKey({ type, orderId, version: 1 }),
  });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).not.toContain("aviso=");
}

/** The card for one order on the preparation list, from its anchor to its end. */
const cardOf = (html: string, orderId: string) => html.slice(html.indexOf(`id="${orderId}"`)).split("</a>")[0]!;

const DEPLOYED = [
  ["DEED_ENGINE=1 (classic conversation)", { DEED_ENGINE: "1" }],
  ["DEED_ENGINE=1 with CONVERSATION=planner (production)", { DEED_ENGINE: "1", CONVERSATION: "planner" }],
] as const;

describe.each(DEPLOYED)("O1: a change still waiting while the order is packed, on %s", (_name, flags) => {
  it("is flagged before packing; once ready it can only be declined, and every screen agrees", async () => {
    const h = harness({ env: testEnv(flags as Partial<Env>) });
    const s = await storeWithSession();
    const { orderId, requestId } = await orderWithWaitingChange(s);
    const cookie = await login(h, s);

    // (a) The Orders card and the packing page show the waiting change before anyone packs.
    expect(cardOf(await page(h, "/console/preparacion", cookie), orderId)).toContain("Cambio sin responder");
    const packing = await page(h, `/console/preparacion/${orderId}`, cookie);
    expect(packing).toContain("El cliente pidió un cambio que espera respuesta.");
    expect(packing).toContain("Revisalo antes de marcar Listo: después ya no se puede aprobar.");
    expect(packing).toContain(`<a href="/console/pedidos/${orderId}">Ver el cambio</a>`);

    // Staff pack it anyway: Empezar, then Listo.
    await staffTap(h, cookie, csrfOf(packing), "start_preparing", orderId);
    await staffTap(h, cookie, csrfOf(packing), "mark_ready", orderId);
    const ready = await page(h, `/console/preparacion/${orderId}`, cookie);
    expect(ready).toContain("El pedido ya está listo, así que ya no se puede aprobar.");
    expect(cardOf(await page(h, "/console/preparacion", cookie), orderId)).toContain("Cambio sin responder");

    // (b) The order page offers only Rechazar, and says why.
    const order = await page(h, `/console/pedidos/${orderId}`, cookie);
    expect(order).toContain("El cliente pidió un cambio");
    expect(order).toContain("Agregar: jabón más × 1");
    expect(order).not.toContain("Aprobar ✓");
    expect(order).toContain("Rechazar ✗");
    expect(order).toContain("este cambio ya no se puede aprobar");
    expect(order.match(/name="cambio" value="/g)).toHaveLength(1);
    // (c) To do (the owner's) lists it while it waits.
    const owner = await login(h, s, "owner");
    expect(await page(h, "/console/pendientes", owner)).toContain("tiene un cambio");

    // An approval from a page opened before Listo is refused, and the screen says what is left to do.
    const path = `/console/pedidos/${orderId}/revision`;
    const late = await send(h, path, cookie, { csrf: csrfOf(order), cambio: requestId, decision: "approve", motivo: "Va" });
    expect(late.headers.get("location")).toBe(`/console/pedidos/${orderId}?aviso=tarde`);
    const afterLate = await page(h, `/console/pedidos/${orderId}?aviso=tarde`, cookie);
    expect(afterLate).toContain("El pedido ya avanzó y ese cambio ya no se puede aprobar.");
    expect(afterLate).not.toContain("Ese cambio ya no está pendiente");
    expect(afterLate).toContain("El cliente pidió un cambio");

    // Declined: the change is closed everywhere at once, and the order is ready as it was.
    const declined = await send(h, path, cookie, { csrf: csrfOf(order), cambio: requestId, decision: "decline", motivo: "Ya estaba listo" });
    expect(declined.headers.get("location")).toBe(`/console/pedidos/${orderId}?aviso=rechazado`);
    const closed = await page(h, `/console/pedidos/${orderId}`, cookie);
    expect(closed).not.toContain("El cliente pidió un cambio");
    expect(closed).toContain("Rechazado: Ya estaba listo");
    expect(await page(h, "/console/pendientes", owner)).not.toContain("tiene un cambio");
    expect(cardOf(await page(h, "/console/preparacion", cookie), orderId)).toContain(">Listo<");
    expect(await page(h, `/console/preparacion/${orderId}`, cookie)).not.toContain("espera respuesta");
  });

  it("can still be approved while packing, and then the card says when it changed", async () => {
    // Two hours after the order was confirmed, so the change's time and the confirmation's differ.
    const h = harness({ clock: new FakeClock(T0 + 2 * 3_600_000), env: testEnv(flags as Partial<Env>) });
    const s = await storeWithSession();
    const { orderId, requestId } = await orderWithWaitingChange(s);
    const cookie = await login(h, s);
    const packing = await page(h, `/console/preparacion/${orderId}`, cookie);
    await staffTap(h, cookie, csrfOf(packing), "start_preparing", orderId);

    const order = await page(h, `/console/pedidos/${orderId}`, cookie);
    expect(order).toContain("Aprobar ✓");
    expect(order).not.toContain("ya no se puede aprobar");
    const approved = await send(h, `/console/pedidos/${orderId}/revision`, cookie, { csrf: csrfOf(order), cambio: requestId, decision: "approve", motivo: "Sí hay" });
    expect(approved.headers.get("location")).toBe(`/console/pedidos/${orderId}?aviso=aprobado`);

    // O3: the card's time is the change's (the approval), not the first confirmation's (T0 + 1 s).
    const card = cardOf(await page(h, "/console/preparacion", cookie), orderId);
    expect(card).toContain("Cambió");
    const now = h.clock.now();
    expect(formatStoreTime(now, now)).not.toBe(formatStoreTime(T0 + 1000, now));
    expect(card).toContain(`<span class="when">cambió ${formatStoreTime(now, now)}</span>`);
    expect(await page(h, `/console/preparacion/${orderId}`, cookie)).toContain(`cambió a las ${formatStoreTime(now, now)} Revisá`);
    expect(await page(h, `/console/preparacion/${orderId}`, cookie)).not.toContain("espera respuesta");
  });
});
