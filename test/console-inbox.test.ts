import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addAndPickup, ids } from "./fixtures/contract";
import { fixtureImage, receiptFixtures } from "./fixtures/receipts";
import { csrfOf, login, send, storeWithStaff } from "./helpers/console";
import { harness } from "./helpers/harness";
import { engine, firstPickupOrder, newStore, placeFirstOrder, save, T0, tap } from "./helpers/orders";
import { newPhone, seedStore } from "./helpers/seed";

/** The owner's bell, with its count if any; undefined when the page has no bell. */
const bellOf = (page: string) => {
  const bell = /<a class="bell" href="\/console\/pendientes"[^>]*>([\s\S]*?)<\/a>/.exec(page)?.[1];
  return bell === undefined ? undefined : { badge: /<span class="badge">([^<]+)<\/span>/.exec(bell)?.[1] ?? null };
};

/** Inicio's "Por resolver" number, or undefined when the card isn't there. */
const porResolver = (page: string) => /<span class="label">Por resolver<\/span><strong>([^<]+)<\/strong>/.exec(page)?.[1];

/** A store from `newStore` (its catalog matches the order fixtures) with an owner and a staff member who can log in. */
async function storeWithSession() {
  const base = await seedStore({ members: [{ phone: newPhone(), role: "owner" }, { phone: newPhone(), role: "staff" }] });
  const s = await newStore();
  await env.DB.batch(
    base.members.map((m) =>
      env.DB.prepare(
        `INSERT INTO memberships (business_id, user_id, location_id, role, created_at_ms)
         SELECT ?1, ?2, id, ?3, 0 FROM locations WHERE business_id = ?1`,
      ).bind(s.businessId, m.userId, m.role),
    ),
  );
  return { s, ownerId: base.members[0]!.userId, staffId: base.members[1]!.userId };
}

/** A confirmed pickup order with "agregale un jabón más" waiting for the owner's answer. */
async function orderWithRequest(s: Awaited<ReturnType<typeof newStore>>) {
  const customerId = ids.customer;
  const v1 = await placeFirstOrder(s, customerId, T0, firstPickupOrder);
  await save(await engine.onCustomerAction(s.context({ customerId, nowMs: T0 + 1000 }), tap(v1.orderId, 1, { actor: { type: "customer", customerId } })));
  const result = await engine.onBurst(s.context({ nowMs: T0 + 3000 }), addAndPickup, []);
  await save(result);
  const requestId = result.outcome.type === "order_status" ? result.outcome.order!.openChangeRequest!.id : "";
  return { orderId: v1.orderId, requestId };
}

describe("one inbox: what waits for the owner's yes shows in Pendientes, the bell and Inicio", () => {
  it("lists a change request waiting for Aprobar / Rechazar as a link to its order, counted on the bell and Inicio", async () => {
    const h = harness({ engine });
    const { s, ownerId, staffId } = await storeWithSession();
    const { orderId, requestId } = await orderWithRequest(s);
    const owner = await login(h, s.businessId, ownerId);

    const page = await (await send(h, "/console/pendientes", { cookie: owner })).text();
    expect(page).toContain("Para aprobar (1)");
    expect(page).toContain(`<a class="card inbox change" href="/console/pedidos/${orderId}">`);
    expect(page).not.toContain("No hay nada pendiente.");
    expect(bellOf(page)).toMatchObject({ badge: "1" });
    expect(porResolver(await (await send(h, "/console/inicio", { cookie: owner })).text())).toBe("1");

    // Approving still happens on the order's own page; once answered it leaves the inbox.
    const history = await (await send(h, `/console/pedidos/${orderId}`, { cookie: owner })).text();
    const answered = await send(h, `/console/pedidos/${orderId}/revision`, {
      method: "POST",
      cookie: owner,
      form: { csrf: csrfOf(history)!, cambio: requestId, decision: "approve", motivo: "Sí hay" },
    });
    expect(answered.status).toBe(303);
    const after = await (await send(h, "/console/pendientes", { cookie: owner })).text();
    expect(after).not.toContain("Para aprobar");
    expect(after).toContain("No hay nada pendiente.");
    expect(bellOf(after)).toMatchObject({ badge: null });

    // Staff never get the inbox: no bell, no count, and Pendientes stays refused.
    const staff = await login(h, s.businessId, staffId);
    const forStaff = await (await send(h, "/console/inicio", { cookie: staff })).text();
    expect(bellOf(forStaff)).toBeUndefined();
    expect(porResolver(forStaff)).toBeUndefined();
    expect((await send(h, "/console/pendientes", { cookie: staff })).status).toBe(403);
  });

  it("lists a supplier invoice waiting for review as a link to it, counted on the bell", async () => {
    const h = harness({ engine });
    const store = await storeWithStaff();
    const owner = await login(h, store.businessId, store.members[0]!.userId);
    const csrf = csrfOf(await (await send(h, "/console/facturas/nueva", { cookie: owner })).text())!;
    const form = new FormData();
    form.set("csrf", csrf);
    form.set("foto", new File([fixtureImage(receiptFixtures.distribuidora)], "factura.png", { type: "image/png" }));
    const ctx = createExecutionContext();
    const uploaded = await h.worker.fetch(
      new Request("https://worker.test/console/facturas/nueva", { method: "POST", body: form, redirect: "manual", headers: { cookie: owner, origin: "https://worker.test" } }),
      h.env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(uploaded.status).toBe(303);
    const id = /\/console\/facturas\/(inv_[0-9a-f]+)/.exec(uploaded.headers.get("location")!)?.[1];
    expect(id).toBeDefined();

    const page = await (await send(h, "/console/pendientes", { cookie: owner })).text();
    expect(page).toContain("Para aprobar (1)");
    expect(page).toContain(`<a class="card inbox invoice" href="/console/facturas/${id}">`);
    expect(page).toContain("Por revisar");
    expect(bellOf(page)).toMatchObject({ badge: "1" });
  });
});

describe("Anotar is where a supplier invoice photo starts", () => {
  it("offers the owner 'Factura de proveedor', which opens the existing invoice upload; staff don't see it", async () => {
    const h = harness();
    const store = await storeWithStaff();
    const owner = await login(h, store.businessId, store.members[0]!.userId);
    const staff = await login(h, store.businessId, store.members[1]!.userId);

    const forOwner = await (await send(h, "/console/anotar", { cookie: owner })).text();
    expect(forOwner).toContain('<a class="choice" href="/console/facturas/nueva">Factura de proveedor');
    expect((await send(h, "/console/facturas/nueva", { cookie: owner })).status).toBe(200);

    const forStaff = await (await send(h, "/console/anotar", { cookie: staff })).text();
    expect(forStaff).not.toContain("Factura de proveedor");
    expect(forStaff).not.toContain("/console/facturas");
  });
});
