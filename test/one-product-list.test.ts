import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CatalogService } from "../src/application/catalog";
import type { MemberContext } from "../src/application/engine";
import { INVITE_TTL_MS } from "../src/domain/console-auth";
import { priceKey } from "../src/domain/price";
import { D1CatalogStore } from "../src/infrastructure/d1/catalog-store";
import { D1CommitRunner } from "../src/infrastructure/d1/commit-runner";
import { D1FactLedger } from "../src/infrastructure/d1/fact-ledger";
import { D1OrderStore } from "../src/infrastructure/d1/order-store";
import { D1RetrievalRepository } from "../src/infrastructure/d1/retrieval-repository";
import { D1StoreSetupRepository } from "../src/infrastructure/d1/store-setup-repository";
import { D1PretendEngine } from "../src/infrastructure/memory/d1-pretend-engine";
import { hashToken, newToken } from "../src/infrastructure/tokens";
import { firstOrder } from "./fixtures/contract";
import { type Harness, harness } from "./helpers/harness";
import { count, engine, save, T0 } from "./helpers/orders";
import { newPhone, seedStore } from "./helpers/seed";

const MINUTE = 60_000;
const ledger = new D1FactLedger(env.DB);
const runner = new D1CommitRunner(env.DB);
const ids = { newId: () => crypto.randomUUID() };
const catalogStore = new D1CatalogStore(env.DB);
const catalog = new CatalogService({ catalog: catalogStore, ledger, runner, ids, engine });
const setup = new D1StoreSetupRepository(env.DB);

async function shop() {
  const seeded = await seedStore({
    members: [
      { phone: newPhone(), role: "owner" },
      { phone: newPhone(), role: "staff" },
    ],
  });
  const as = (role: "owner" | "staff", nowMs = T0): MemberContext => ({
    businessId: seeded.businessId,
    memberId: seeded.members.find((m) => m.role === role)!.userId,
    role,
    canApproveFiado: false,
    nowMs,
  });
  return { businessId: seeded.businessId, as };
}

async function added(s: Awaited<ReturnType<typeof shop>>, name: string, price: number | null, nowMs = T0): Promise<string> {
  const result = await catalog.addProduct(s.as("owner", nowMs), { name, price });
  if (result.type !== "added") throw new Error(`expected added, got ${result.reason}`);
  return result.productId;
}

const rows = async (businessId: string, productId: string) => ({
  products: (await env.DB.prepare(`SELECT id, business_id, canonical_name FROM products WHERE id = ?`).bind(productId).all()).results,
  storeProducts: (await env.DB.prepare(`SELECT id, business_id, name, price_centavos FROM store_products WHERE id = ?`).bind(productId).all()).results,
  facts: await count(`facts WHERE business_id = ? AND kind = 'price' AND json_extract(body_json, '$.productId') = ?`, businessId, productId),
});

describe("one product list: the writer", () => {
  it("adding a product writes both rows with one ID, and its confirmed price fact", async () => {
    const s = await shop();
    const productId = await added(s, "  Frijoles  rojos ", 3550);
    expect(await rows(s.businessId, productId)).toEqual({
      products: [{ id: productId, business_id: s.businessId, canonical_name: "Frijoles rojos" }],
      storeProducts: [{ id: productId, business_id: s.businessId, name: "Frijoles rojos", price_centavos: 3550 }],
      facts: 1,
    });
    expect(await engine.verifyClaims(s, [{ type: "unit_price", productId, price: 3550 }])).toEqual([true]);
    expect(await catalog.product(s, productId)).toMatchObject({ name: "Frijoles rojos", price: 3550, unconfirmed: null, noHay: false });
  });

  it("a product with no price is 'sin precio' in both tables, never zero", async () => {
    const s = await shop();
    const productId = await added(s, "Pan dulce", null);
    expect(await rows(s.businessId, productId)).toMatchObject({ storeProducts: [{ price_centavos: null }], facts: 0 });
    expect(await catalog.product(s, productId)).toMatchObject({ price: null, unconfirmed: null });
  });

  it("a failing batch leaves neither row nor the fact", async () => {
    const s = await shop();
    // A ledger whose fact carries two member evidences: its guard fails after every statement ran, so all roll back.
    const broken = {
      statementsFor: (scope: MemberContext, fact: Parameters<typeof ledger.statementsFor>[1], at: number) =>
        ledger.statementsFor(scope, { ...fact, evidence: [{ kind: "member" as const, refId: "a", contentSha256: null }, { kind: "member" as const, refId: "b", contentSha256: null }] }, at),
    };
    const failing = new CatalogService({ catalog: catalogStore, ledger: broken, runner, ids, engine });
    await expect(failing.addProduct(s.as("owner"), { name: "Pan", price: 500 })).rejects.toThrow();
    expect(await count(`products WHERE business_id = ?`, s.businessId)).toBe(0);
    expect(await count(`store_products WHERE business_id = ?`, s.businessId)).toBe(0);
    expect(await count(`facts WHERE business_id = ? AND kind = 'price'`, s.businessId)).toBe(0);
  });

  it("a name the store has in either table is taken, accents and case aside", async () => {
    const s = await shop();
    await added(s, "Azúcar 1 lb", 1650);
    await env.DB.prepare(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) VALUES (?, ?, 'Jabón Xtra', 0)`).bind(crypto.randomUUID(), s.businessId).run();
    expect(await catalog.addProduct(s.as("owner"), { name: "azucar 1 LB", price: 1 })).toEqual({ type: "refused", reason: "name_taken" });
    expect(await catalog.addProduct(s.as("owner"), { name: "jabon xtra", price: null })).toEqual({ type: "refused", reason: "name_taken" });
    expect(await catalog.addProduct(s.as("staff"), { name: "Leche", price: null })).toEqual({ type: "refused", reason: "not_allowed" });
    expect(await count(`store_products WHERE business_id = ?`, s.businessId)).toBe(1);
  });

  it("a confirmed price is the fact and the column in one batch; a proposal moves neither price", async () => {
    const s = await shop();
    const productId = await added(s, "Arroz 1 lb", 1800);
    const later = T0 + 5 * MINUTE;
    expect(await catalog.changePrice(s.as("staff", later), productId, 1900, "propose_price")).toMatchObject({ outcome: { type: "action_saved" } });
    expect(await rows(s.businessId, productId)).toMatchObject({ storeProducts: [{ price_centavos: 1800 }], facts: 2 });
    expect(await catalog.product(s, productId)).toMatchObject({ price: 1800, proposed: 1900 });

    expect(await catalog.changePrice(s.as("owner", later), productId, 1900, "confirm_price")).toMatchObject({ outcome: { type: "action_saved" } });
    expect(await rows(s.businessId, productId)).toMatchObject({ storeProducts: [{ price_centavos: 1900 }], facts: 3 });
    expect(await catalog.product(s, productId)).toMatchObject({ price: 1900, proposed: null });
    expect(await engine.verifyClaims(s, [{ type: "unit_price", productId, price: 1900 }])).toEqual([true]);
  });

  it("the same confirmation again (same operation key) writes nothing more", async () => {
    const s = await shop();
    const productId = await added(s, "Aceite 1 L", 5800);
    const later = T0 + 5 * MINUTE;
    await catalog.changePrice(s.as("owner", later), productId, 6000, "confirm_price");
    const again = await catalog.changePrice(s.as("owner", later + 1000), productId, 6100, "confirm_price");
    expect(again).toMatchObject({ outcome: { type: "duplicate" } });
    expect(await rows(s.businessId, productId)).toMatchObject({ storeProducts: [{ price_centavos: 6000 }], facts: 2 });
    expect(await count(`facts WHERE business_id = ? AND operation_key = ?`, s.businessId, priceKey(productId, later, "confirm_price"))).toBe(1);
  });

  it("details: a rename renames both tables; other names, how it's sold and No hay stay on the product", async () => {
    const s = await shop();
    const productId = await added(s, "Pollo", 6000);
    expect(await catalog.updateDetails(s.as("owner"), productId, { name: "Pollo entero", otherNames: ["pollito"], selling: { soldBy: "weight", usualQuantity: "0.5" } })).toBe(
      "saved",
    );
    expect(await catalog.setNoHay(s.as("owner"), productId, true)).toBe(true);
    expect(await rows(s.businessId, productId)).toMatchObject({ products: [{ canonical_name: "Pollo entero" }], storeProducts: [{ name: "Pollo entero" }] });
    expect(await catalog.product(s, productId)).toMatchObject({ name: "Pollo entero", otherNames: ["pollito"], soldBy: "weight", usualQuantity: "0.5", noHay: true, price: 6000 });
    await added(s, "Huevos", null);
    expect(await catalog.updateDetails(s.as("owner"), productId, { name: "HUEVOS", otherNames: [] })).toBe("name_taken");
    expect(await catalog.updateDetails(s.as("staff"), productId, { name: "Pollo", otherNames: [] })).toBe("not_allowed");
  });

  it("the paste box adds new names with their price facts and confirms a new price for a known one, in one batch", async () => {
    const s = await shop();
    const arroz = await added(s, "Arroz 1 lb", 1800);
    const later = T0 + 5 * MINUTE;
    expect(await catalog.importPrices(s.as("owner", later), [{ name: "arroz 1 lb", price: 1900 }, { name: "Café 1 lb", price: 9000 }])).toEqual({ type: "saved" });
    expect(await catalog.product(s, arroz)).toMatchObject({ price: 1900 });
    const cafe = (await catalog.list(s)).find((row) => row.name === "Café 1 lb")!;
    expect(cafe).toMatchObject({ price: 9000 });
    expect(await rows(s.businessId, cafe.id)).toMatchObject({ products: [{ canonical_name: "Café 1 lb" }], storeProducts: [{ price_centavos: 9000 }], facts: 1 });
    expect(await rows(s.businessId, arroz)).toMatchObject({ storeProducts: [{ price_centavos: 1900 }], facts: 2 });
  });

  it("the paste box saves a long list (300 products) in groups, and pasting it again changes nothing", async () => {
    const s = await shop();
    const list = Array.from({ length: 300 }, (_, n) => ({ name: `Producto de prueba ${n + 1}`, price: 1000 + n }));
    expect(await catalog.importPrices(s.as("owner", T0 + MINUTE), list)).toEqual({ type: "saved" });
    const saved = await catalog.list(s);
    expect(saved).toHaveLength(300);
    const last = saved.find((row) => row.name === "Producto de prueba 300")!;
    expect(await rows(s.businessId, last.id)).toMatchObject({ storeProducts: [{ price_centavos: 1299 }], facts: 1 });
    expect(await catalog.importPrices(s.as("owner", T0 + 2 * MINUTE), list)).toEqual({ type: "saved" });
    expect(await catalog.list(s)).toHaveLength(300);
    expect(await rows(s.businessId, last.id)).toMatchObject({ facts: 1 });
  });

  it("store B can't read, price, edit, mark or remove store A's product by its ID", async () => {
    const a = await shop();
    const b = await shop();
    const productId = await added(a, "Leche 1 L", 3000);
    const later = T0 + 5 * MINUTE;
    expect(await catalog.list(b)).toEqual([]);
    expect(await catalog.product(b, productId)).toBeNull();
    expect(await catalog.changePrice(b.as("owner", later), productId, 1, "confirm_price")).toMatchObject({ outcome: { type: "rejected", reason: "not_found" } });
    expect(await catalog.updateDetails(b.as("owner"), productId, { name: "Mía", otherNames: [] })).toBe("missing");
    expect(await catalog.setNoHay(b.as("owner"), productId, true)).toBe(false);
    expect(await catalog.removeProduct(b.as("owner"), productId)).toBe(false);
    expect(await rows(a.businessId, productId)).toMatchObject({
      products: [{ business_id: a.businessId, canonical_name: "Leche 1 L" }],
      storeProducts: [{ business_id: a.businessId, name: "Leche 1 L", price_centavos: 3000 }],
      facts: 1,
    });
    expect(await catalog.product(a, productId)).toMatchObject({ noHay: false });
    expect(await count(`facts WHERE business_id = ?`, b.businessId)).toBe(0);
  });
});

describe("one product list: every reader sees the same product", () => {
  it("retrieval (the bot's matching) finds a product added in Productos, with its price and other names", async () => {
    const s = await shop();
    const productId = (await catalog.addProduct(s.as("owner"), { name: "Salsa de tomate", price: 2500, otherNames: ["catsup"] })) as { productId: string };
    const found = await new D1RetrievalRepository(env.DB).listProducts(s);
    expect(found).toEqual([expect.objectContaining({ productId: productId.productId, names: ["Salsa de tomate"], aliases: ["catsup"], hasPrice: true })]);
  });

  it("the real engine prices an order line for a product added in Productos, and leaves an unpriced one unknown", async () => {
    const s = await shop();
    const arroz = await added(s, "Arroz 1 lb", 1800);
    const jabon = await added(s, "Jabón Xtra", null);
    const context = { businessId: s.businessId, customerId: "customer-1", conversationId: "conversation-1", jobId: crypto.randomUUID(), nowMs: T0 + MINUTE };
    const result = await engine.onBurst(context, firstOrder, [
      { observation: 0, line: 1, productId: arroz, how: "exact_name" },
      { observation: 0, line: 2, productId: jabon, how: "exact_name" },
    ]);
    expect(result.outcome.type).toBe("readback");
    const lines = (result.outcome as Extract<typeof result.outcome, { type: "readback" }>).order.lines;
    expect(lines.find((line) => line.productId === arroz)).toMatchObject({ productName: "Arroz 1 lb", unitPrice: 1800 });
    expect(lines.find((line) => line.productId === jabon)).toMatchObject({ productName: "Jabón Xtra", unitPrice: null });
    await save(result);
  });

  it("the planner path's reads agree on a Productos product: the store setup's name and price, and the ledger's name, under one ID", async () => {
    // What the planner lane's SetupCatalogOrderStore and its prices read: the store setup (`store_products`),
    // and `products` for the names Deed, Libro and Pedidos show.
    const s = await shop();
    const productId = await added(s, "Leche en polvo", 12000);
    expect(await catalog.updateDetails(s.as("owner"), productId, { name: "Leche Ceteco", otherNames: [] })).toBe("saved");
    await catalog.changePrice(s.as("owner", T0 + 5 * MINUTE), productId, 12500, "confirm_price");
    expect(await rows(s.businessId, productId)).toMatchObject({ storeProducts: [{ id: productId, name: "Leche Ceteco", price_centavos: 12500 }] });
    expect((await setup.read(s)).products).toEqual([expect.objectContaining({ productId, name: "Leche Ceteco", price: 12500 })]);
    expect(await new D1OrderStore(env.DB).productNames(s, [productId])).toEqual(new Map([[productId, "Leche Ceteco"]]));
    expect(await engine.verifyClaims(s, [{ type: "unit_price", productId, price: 12500 }])).toEqual([true]);
  });

  it("the pretend engine sees a price set in Productos", async () => {
    const s = await shop();
    const productId = await added(s, "Café 1 lb", 9000);
    await catalog.changePrice(s.as("owner", T0 + 5 * MINUTE), productId, 9500, "confirm_price");
    const pretend = new D1PretendEngine(env.DB, { setup });
    expect(await pretend.verifyClaims(s, [{ type: "unit_price", productId, price: 9500 }, { type: "unit_price", productId, price: 9000 }])).toEqual([true, false]);
    expect((await setup.read(s)).products).toEqual([expect.objectContaining({ productId, name: "Café 1 lb", price: 9500 })]);
  });

  it("a product only in `products` (an invoice's) is in every list by its name, with its fact's price; its first edit gives it a row", async () => {
    const s = await shop();
    const productId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) VALUES (?, ?, 'Atún en lata', 0)`).bind(productId, s.businessId).run();
    expect(await setup.listProducts(s)).toEqual([expect.objectContaining({ productId, name: "Atún en lata", price: null, noHay: false })]);
    await catalog.changePrice(s.as("owner", T0), productId, 3200, "confirm_price");
    expect(await rows(s.businessId, productId)).toMatchObject({ storeProducts: [{ name: "Atún en lata", price_centavos: 3200 }], facts: 1 });
    expect(await setup.product(s, productId)).toMatchObject({ price: 3200 });
    expect(await catalog.setNoHay(s.as("owner"), productId, true)).toBe(true);
    expect(await setup.product(s, productId)).toMatchObject({ noHay: true, price: 3200 });
  });
});

describe("migration 0031 on a database with products in only one table", () => {
  it("gives every store_products row its products row (same ID, same store, its name), adds no price fact, and runs twice safely", async () => {
    const db = env.MIGRATION_TEST_DB;
    const all = env.TEST_MIGRATIONS;
    await applyD1Migrations(db, all.filter((migration) => migration.name !== "0031_one_product_list.sql"));
    await db.batch([
      db.prepare(`INSERT INTO businesses (id, name, created_at_ms) VALUES ('store-a', 'Tienda A', 0), ('store-b', 'Tienda B', 0)`),
      db.prepare(
        `INSERT INTO store_products (id, business_id, name, name_key, price_centavos, created_at_ms, updated_at_ms)
         VALUES ('p-arroz', 'store-a', 'Arroz 1 lb', 'arroz 1 lb', 1800, 5, 5), ('p-sal', 'store-b', 'Sal', 'sal', NULL, 6, 6)`,
      ),
      // Already in both tables: left as it is.
      db.prepare(`INSERT INTO store_products (id, business_id, name, name_key, created_at_ms, updated_at_ms) VALUES ('p-both', 'store-a', 'Café', 'cafe', 7, 7)`),
      db.prepare(`INSERT INTO products (id, business_id, canonical_name, created_at_ms) VALUES ('p-both', 'store-a', 'Café', 7), ('p-only', 'store-a', 'Jabón Xtra', 8)`),
    ]);
    await applyD1Migrations(db, all);
    const products = async () => (await db.prepare(`SELECT id, business_id, canonical_name, created_at_ms FROM products ORDER BY id`).all()).results;
    const expected = [
      { id: "p-arroz", business_id: "store-a", canonical_name: "Arroz 1 lb", created_at_ms: 5 },
      { id: "p-both", business_id: "store-a", canonical_name: "Café", created_at_ms: 7 },
      { id: "p-only", business_id: "store-a", canonical_name: "Jabón Xtra", created_at_ms: 8 },
      { id: "p-sal", business_id: "store-b", canonical_name: "Sal", created_at_ms: 6 },
    ];
    expect(await products()).toEqual(expected);
    expect((await db.prepare(`SELECT count(*) AS n FROM facts`).first<{ n: number }>())?.n).toBe(0);
    // The products-only row is not copied by SQL (its name key needs code); the readers list it anyway.
    expect((await db.prepare(`SELECT count(*) AS n FROM store_products WHERE id = 'p-only'`).first<{ n: number }>())?.n).toBe(0);
    const names = (await new D1StoreSetupRepository(db).listProducts({ businessId: "store-a" })).map((p) => [p.productId, p.name, p.price]);
    expect(names).toEqual([
      ["p-arroz", "Arroz 1 lb", 1800],
      ["p-both", "Café", null],
      ["p-only", "Jabón Xtra", null],
    ]);
    // A price typed before the ledger: the pretend engine keeps it; Productos shows it to confirm; no fact backs it.
    expect(await new D1CatalogStore(db).product({ businessId: "store-a" }, "p-arroz")).toMatchObject({ price: null, unconfirmed: 1800 });

    const migration = all.find((m) => m.name === "0031_one_product_list.sql")!;
    for (const query of migration.queries) await db.prepare(query).run();
    expect(await products()).toEqual(expected);
  });

  it("does nothing on an empty database", async () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name === "0031_one_product_list.sql")!;
    const before = await count(`products`);
    for (const query of migration.queries) await env.DB.prepare(query).run();
    expect(await count(`products`)).toBe(before);
  });
});

// --- The screens ---------------------------------------------------------------------------------

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
  await env.DB.prepare(`INSERT INTO console_invites (id, business_id, user_id, token_hash, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), businessId, member!.id, await hashToken(code), now + INVITE_TTL_MS, now)
    .run();
  const response = await send(h, "/console/entrar", { method: "POST", body: new URLSearchParams({ codigo: code }) });
  expect(response.status).toBe(303);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

async function screens() {
  const h = harness({ engine });
  const seeded = await seedStore({ members: [{ phone: newPhone(), role: "owner" }, { phone: newPhone(), role: "staff" }] });
  const owner = await login(h, seeded.businessId, "owner");
  const staff = await login(h, seeded.businessId, "staff");
  const get = async (path: string, cookie = owner) => send(h, path, { headers: { cookie } });
  const post = async (path: string, fields: Record<string, string>, cookie = owner) => {
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await get("/console/productos", cookie)).text())?.[1] ?? "";
    return send(h, path, { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, ...fields }) });
  };
  const tenant = { businessId: seeded.businessId };
  return { h, tenant, owner, staff, get, post };
}

describe("one product list: the screens", () => {
  it("Productos adds a product (price optional), and its details page edits name, other names, how it's sold and No hay", async () => {
    const s = await screens();
    expect((await s.post("/console/productos", { nombre: "Pollo", precio: "", otros: "pollito" })).headers.get("location")).toBe("/console/productos?aviso=agregado");
    const pollo = (await catalog.list(s.tenant)).find((row) => row.name === "Pollo")!;
    expect(pollo).toMatchObject({ price: null, otherNames: ["pollito"] });
    expect(await (await s.get("/console/productos")).text()).toContain(`href="/console/productos/${pollo.id}"`);

    const details = await (await s.get(`/console/productos/${pollo.id}`)).text();
    expect(details).toContain("Datos del producto");
    expect(details).toContain(`name="vende" value=""`);
    const saved = await s.post(`/console/productos/${pollo.id}`, { nombre: "Pollo entero", otros: "pollito\nchicken", vende: "libra", usual: "0.5" });
    expect(saved.headers.get("location")).toBe(`/console/productos/${pollo.id}?aviso=guardado`);
    expect(await catalog.product(s.tenant, pollo.id)).toMatchObject({ name: "Pollo entero", otherNames: ["pollito", "chicken"], soldBy: "weight", usualQuantity: "0.5" });
    expect((await s.post(`/console/productos/${pollo.id}`, { nombre: "Pollo entero", otros: "", vende: "unidad", usual: "1,5" })).headers.get("location")).toBe(
      `/console/productos/${pollo.id}?aviso=cantidad`,
    );
    expect((await s.post(`/console/productos/${pollo.id}/hay`, { no_hay: "1" })).headers.get("location")).toBe(`/console/productos/${pollo.id}?aviso=no_hay`);
    expect(await catalog.product(s.tenant, pollo.id)).toMatchObject({ noHay: true });
    const priced = await s.post(`/console/productos/${pollo.id}/precio`, { precio: "60", desde: "detalle" });
    expect(priced.headers.get("location")).toBe(`/console/productos/${pollo.id}?aviso=confirmado`);
    expect(await setup.product(s.tenant, pollo.id)).toMatchObject({ price: 6000, name: "Pollo entero", noHay: true });
  });

  it("staff can't open or change a product's details", async () => {
    const s = await screens();
    await s.post("/console/productos", { nombre: "Pan", precio: "5" });
    const pan = (await catalog.list(s.tenant))[0]!;
    expect((await s.get(`/console/productos/${pan.id}`, s.staff)).status).toBe(403);
    expect((await s.post(`/console/productos/${pan.id}`, { nombre: "Mío", otros: "" }, s.staff)).status).toBe(403);
    expect((await s.post(`/console/productos/${pan.id}/hay`, { no_hay: "1" }, s.staff)).status).toBe(403);
    expect(await (await s.get("/console/productos", s.staff)).text()).not.toContain(`href="/console/productos/${pan.id}"`);
    expect(await catalog.product(s.tenant, pan.id)).toMatchObject({ name: "Pan", noHay: false });
  });

  it("Más → Preparar la tienda points to Productos, and its product routes write the one list", async () => {
    const s = await screens();
    const tienda = await (await s.get("/console/tienda")).text();
    expect(tienda).toContain(`href="/console/productos"`);
    expect(tienda).toContain("Horario y envío");
    expect(tienda).not.toContain(`action="/console/tienda/agregar"`);

    expect((await s.post("/console/tienda/agregar", { nombre: "Sal", precio: "", otros: "" })).headers.get("location")).toBe("/console/tienda?aviso=agregado");
    expect((await s.post("/console/tienda/pegar/guardar", { lista: "Arroz 1 lb - 18\nSal - 7" })).headers.get("location")).toBe("/console/tienda?aviso=pegados");
    const list = await catalog.list(s.tenant);
    expect(list.map((row) => [row.name, row.price])).toEqual([
      ["Arroz 1 lb", 1800],
      ["Sal", 700],
    ]);
    for (const row of list) expect(await rows(s.tenant.businessId, row.id)).toMatchObject({ products: [{ id: row.id }], storeProducts: [{ id: row.id, price_centavos: row.price }] });
    const sal = list.find((row) => row.name === "Sal")!;
    expect((await s.get(`/console/tienda/editar?producto=${sal.id}`)).headers.get("location")).toBe(`/console/productos/${sal.id}`);
    expect((await s.post("/console/tienda/hay", { producto: sal.id, no_hay: "1" })).status).toBe(303);
    expect(await catalog.product(s.tenant, sal.id)).toMatchObject({ noHay: true });
    expect((await s.post("/console/tienda/quitar", { producto: sal.id })).headers.get("location")).toBe("/console/tienda?aviso=quitado");
    expect(await rows(s.tenant.businessId, sal.id)).toMatchObject({ products: [], storeProducts: [] });
  });
});
