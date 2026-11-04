import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { INVITE_TTL_MS } from "../src/domain/console-auth";
import { hashToken, newToken } from "../src/infrastructure/tokens";
import { type Harness, harness } from "./helpers/harness";
import { engine } from "./helpers/orders";
import { newPhone, seedStore } from "./helpers/seed";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function send(h: Harness, path: string, init: { method?: string; headers?: Record<string, string>; body?: URLSearchParams } = {}) {
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(
    new IncomingRequest(`https://worker.test${path}`, { redirect: "manual", ...init, headers: { origin: "https://worker.test", ...init.headers } }),
    h.env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function login(h: Harness, businessId: string, role: "owner" | "staff"): Promise<string> {
  const member = await env.DB.prepare(`SELECT user_id AS id FROM memberships WHERE business_id = ? AND role = ?`).bind(businessId, role).first<{ id: string }>();
  const code = newToken();
  const now = h.clock.now();
  await env.DB.prepare(
    `INSERT INTO console_invites (id, business_id, user_id, token_hash, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), businessId, member!.id, await hashToken(code), now + INVITE_TTL_MS, now)
    .run();
  const response = await send(h, "/console/entrar", { method: "POST", body: new URLSearchParams({ codigo: code }) });
  expect(response.status).toBe(303);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

const csrfOf = (page: string) => /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";

async function setup() {
  const h = harness({ engine });
  const seeded = await seedStore({ members: [{ phone: newPhone(), role: "owner" }, { phone: newPhone(), role: "staff" }] });
  const productId = `${seeded.businessId}:product-leche`;
  await env.DB.prepare(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) VALUES (?, ?, 'leche', 0)`).bind(productId, seeded.businessId).run();
  const owner = await login(h, seeded.businessId, "owner");
  const staff = await login(h, seeded.businessId, "staff");
  const page = async (path: string, cookie: string) => send(h, path, { headers: { cookie } });
  const post = async (path: string, cookie: string, fields: Record<string, string>) => {
    const csrf = csrfOf(await (await page("/console/productos", cookie)).text());
    return send(h, path, { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, ...fields }) });
  };
  return { h, businessId: seeded.businessId, productId, owner, staff, page, post };
}

const priceOf = async (businessId: string, productId: string) =>
  (await env.DB.prepare(
    `SELECT json_extract(body_json, '$.status') AS status, json_extract(body_json, '$.price') AS price FROM facts
     WHERE business_id = ? AND kind = 'price' AND json_extract(body_json, '$.productId') = ? ORDER BY rowid DESC LIMIT 1`,
  ).bind(businessId, productId).first()) ?? null;

describe("K6: the Productos screen", () => {
  it("lists products with 'sin precio', and the owner adds one and confirms a price", async () => {
    const s = await setup();
    const list = await (await s.page("/console/productos", s.owner)).text();
    expect(list).toContain("leche");
    expect(list).toContain("sin precio");

    const added = await s.post("/console/productos", s.owner, { nombre: "Frijoles", precio: "35,50" });
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe("/console/productos?aviso=agregado");
    const after = await (await s.page("/console/productos", s.owner)).text();
    expect(after).toContain("Frijoles");
    expect(after).toContain("L 35.50");

    const changed = await s.post(`/console/productos/${encodeURIComponent(s.productId)}/precio`, s.owner, { precio: "12.50" });
    expect(changed.headers.get("location")).toBe("/console/productos?aviso=confirmado");
    expect(await priceOf(s.businessId, s.productId)).toEqual({ status: "confirmed", price: 1250 });
    expect(await (await s.page("/console/productos", s.owner)).text()).toContain("L 12.50");
  });

  it("refuses a price in the wrong format with the expected format, and writes nothing", async () => {
    const s = await setup();
    const response = await s.post(`/console/productos/${encodeURIComponent(s.productId)}/precio`, s.owner, { precio: "12.505" });
    expect(response.headers.get("location")).toBe("/console/productos?aviso=formato");
    const notice = await (await s.page("/console/productos?aviso=formato", s.owner)).text();
    expect(notice).toContain("12.50 o 12,50");
    expect(await priceOf(s.businessId, s.productId)).toBeNull();
  });

  it("staff can propose but not add a product, and the owner confirms the proposal", async () => {
    const s = await setup();
    const refused = await s.post("/console/productos", s.staff, { nombre: "Pan", precio: "5" });
    expect(refused.status).toBe(403);
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM products WHERE business_id = ? AND canonical_name = 'Pan'`).bind(s.businessId).first("n")).toBe(0);
    expect(await (await s.page("/console/productos", s.staff)).text()).not.toContain("Agregar producto");

    const proposed = await s.post(`/console/productos/${encodeURIComponent(s.productId)}/precio`, s.staff, { precio: "20" });
    expect(proposed.headers.get("location")).toBe("/console/productos?aviso=propuesto");
    expect(await priceOf(s.businessId, s.productId)).toEqual({ status: "proposed", price: 2000 });
    const ownerList = await (await s.page("/console/productos", s.owner)).text();
    expect(ownerList).toContain("Propuesto: L 20");
    expect(ownerList).toContain("sin precio");
  });
});

describe("K6: the Mi tienda screen", () => {
  it("is owner only, and the owner's save is read back through BusinessContext", async () => {
    const s = await setup();
    expect((await s.page("/console/negocio", s.staff)).status).toBe(403);
    const denied = await s.post("/console/negocio", s.staff, { nombre: "Hack" });
    expect(denied.status).toBe(403);

    const form = await (await s.page("/console/negocio", s.owner)).text();
    expect(form).toContain("Nombre de la tienda");
    const saved = await s.post("/console/negocio", s.owner, {
      nombre: "Punto de Ventas Johan",
      tipo: "mercadito",
      abre1: "08:00",
      cierra1: "18:00",
      direccion: "Tocoa",
      zonas: "Centro",
      notas: "Solo efectivo",
    });
    expect(saved.headers.get("location")).toBe("/console/negocio?aviso=guardado");
    const after = await (await s.page("/console/negocio", s.owner)).text();
    expect(after).toContain('value="Punto de Ventas Johan"');
    expect(after).toContain('name="abre1" value="08:00"');
  });

  it("names the problem when the hours are half-filled", async () => {
    const s = await setup();
    const response = await s.post("/console/negocio", s.owner, { nombre: "Johan", abre2: "08:00" });
    expect(response.headers.get("location")).toBe("/console/negocio?aviso=hours");
    expect(await (await s.page("/console/negocio?aviso=hours", s.owner)).text()).toContain("Revisá el horario");
  });
});
