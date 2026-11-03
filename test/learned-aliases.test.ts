/**
 * Learned aliases and how products are sold (D-49, migration 0011), against local D1: the store's
 * products as retrieval reads them, proposals from a confirmed order, the owner's one-tap approval
 * in Pendientes, and store isolation. Products and words are synthetic.
 */
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type AliasBook, proposeAliasesFromConfirmedOrder, retrieveForStore } from "../src/application/learned-aliases";
import type { LogFields, Logger, Tenant } from "../src/application/ports";
import { D1RetrievalRepository } from "../src/infrastructure/d1/retrieval-repository";
import { D1StoreSetupRepository } from "../src/infrastructure/d1/store-setup-repository";
import { csrfFor, login, send, storeWithStaff } from "./helpers/console";
import { type Harness, harness, rows, testEnv } from "./helpers/harness";
import type { SeededStore } from "./helpers/seed";

const repo = () => new D1RetrievalRepository(env.DB);
const setup = () => new D1StoreSetupRepository(env.DB);
const NOW = Date.UTC(2026, 10, 2, 18);

/** A store with an owner and staff, and a few synthetic products. */
async function storeWithCatalog() {
  const store = await storeWithStaff();
  await setup().addProduct(store, { name: "Salsa de tomate Naturas 400 g", otherNames: ["ketchup"], price: 3500 }, 1);
  await setup().addProduct(store, { name: "Salsa inglesa", otherNames: [], price: null }, 1);
  await setup().addProduct(store, { name: "Pollo entero", otherNames: [], price: 6000 }, 1);
  const products = await setup().listProducts(store);
  const id = (name: string) => products.find((p) => p.name === name)!.productId;
  return { store, owner: store.members[0]!.userId, salsa: id("Salsa de tomate Naturas 400 g"), inglesa: id("Salsa inglesa"), pollo: id("Pollo entero") };
}

const said = (words: string) => [{ label: "N1", said: words, unit: null }];

/** What retrieval offers one line, with how. */
async function offered(tenant: Tenant, words: string) {
  const table = await retrieveForStore(repo(), tenant, said(words));
  const byLabel = new Map(table.candidates.map((c) => [c.label, c.productId]));
  return [...table.howByLine.get("N1")!].map(([label, how]) => ({ productId: byLabel.get(label), how }));
}

const aliasRows = (businessId: string) =>
  rows<{ id: string; words: string; said: string; product_id: string; state: string; source: string; source_order_id: string | null; decided_by_user_id: string | null; decided_at_ms: number | null }>(
    `SELECT id, words, said, product_id, state, source, source_order_id, decided_by_user_id, decided_at_ms FROM store_aliases WHERE business_id = ? ORDER BY words`,
    businessId,
  );

function recordingLog() {
  const events: { level: string; event: string; fields: LogFields | undefined }[] = [];
  const at = (level: string) => (event: string, fields?: LogFields) => void events.push({ level, event, fields });
  const log: Logger = { info: at("info"), warn: at("warn"), error: at("error") };
  return { log, events };
}

// ---------------------------------------------------------------------------------------------

describe("the store's products as retrieval reads them", () => {
  it("has a price only when the owner set one, No hay is se_acabo, and how it's sold when said", async () => {
    const { store, salsa, inglesa, pollo } = await storeWithCatalog();
    await setup().setNoHay(store, inglesa, true, 2);
    expect(await setup().updateProduct(store, pollo, { name: "Pollo entero", otherNames: [], price: 6000 }, 2, { soldBy: "weight", usualQuantity: "0.50" })).toBe(
      "saved",
    );
    const products = await repo().listProducts(store);
    expect(products.find((p) => p.productId === salsa)).toEqual({
      productId: salsa,
      names: ["Salsa de tomate Naturas 400 g"],
      aliases: ["ketchup"],
      barcode: null,
      soldBy: null,
      usualQuantity: null,
      hasPrice: true,
      availability: "no_se",
      restricted: false,
    });
    expect(products.find((p) => p.productId === inglesa)).toMatchObject({ hasPrice: false, availability: "se_acabo" });
    // Unmarked is never "hay"; the usual amount reads back exact.
    expect(products.find((p) => p.productId === pollo)).toMatchObject({ soldBy: "weight", usualQuantity: "0.5", availability: "no_se" });
  });

  it("another store's product ID saves nothing, and the database refuses a zero amount or an unknown way of selling", async () => {
    const a = await storeWithCatalog();
    const b = await storeWithCatalog();
    const fields = { name: "Robado", otherNames: [], price: 1 };
    expect(await setup().updateProduct(b.store, a.pollo, fields, 3, { soldBy: "unit", usualQuantity: "1" })).toBe("missing");
    expect(await rows(`SELECT 1 FROM store_product_selling WHERE product_id = ?`, a.pollo)).toEqual([]);
    const insert = (soldBy: string | null, milli: number | null) =>
      env.DB.prepare(`INSERT INTO store_product_selling (business_id, product_id, sold_by, usual_quantity_milli, updated_at_ms) VALUES (?, ?, ?, ?, 1)`)
        .bind(a.store.businessId, a.pollo, soldBy, milli)
        .run();
    await expect(insert("unit", 0)).rejects.toThrow(/CHECK/);
    await expect(insert("caja", null)).rejects.toThrow(/CHECK/);
    // A row can't point at another store's product.
    await expect(
      env.DB.prepare(`INSERT INTO store_product_selling (business_id, product_id, sold_by, updated_at_ms) VALUES (?, ?, 'unit', 1)`)
        .bind(b.store.businessId, a.pollo)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe("learned aliases", () => {
  it("a proposed alias doesn't match; once the owner approves it, it's an exact match next time", async () => {
    const { store, owner, salsa } = await storeWithCatalog();
    const before = await offered(store, "salsa roja");
    expect(before.map((c) => c.how)).not.toContain("learned_alias");

    expect(await repo().proposeAlias(store, { said: "Salsa  roja", productId: salsa, orderId: "order-1" }, NOW)).toBe(true);
    expect(await repo().listApprovedAliases(store)).toEqual([]);
    expect(await offered(store, "salsa roja")).toEqual(before);

    const [proposal] = await aliasRows(store.businessId);
    expect(proposal).toMatchObject({ words: "salsa roja", said: "Salsa roja", state: "proposed", source: "order", source_order_id: "order-1" });
    expect(await repo().approveAlias(store, proposal!.id, owner, NOW + 1)).toBe(true);
    expect(await repo().approveAlias(store, proposal!.id, owner, NOW + 2)).toBe(false);
    expect(await aliasRows(store.businessId)).toEqual([expect.objectContaining({ state: "approved", decided_by_user_id: owner, decided_at_ms: NOW + 1 })]);

    expect(await offered(store, "la salsa roja")).toEqual([{ productId: salsa, how: "learned_alias" }]);
  });

  it("proposing again adds nothing; a No isn't asked again for the same product, only for another", async () => {
    const { store, owner, salsa, inglesa } = await storeWithCatalog();
    const propose = (productId: string, orderId: string) => repo().proposeAlias(store, { said: "salsa roja", productId, orderId }, NOW);
    expect(await propose(salsa, "order-1")).toBe(true);
    expect(await propose(salsa, "order-1")).toBe(false);
    expect(await propose(inglesa, "order-2")).toBe(false);
    expect(await aliasRows(store.businessId)).toHaveLength(1);

    const [proposal] = await aliasRows(store.businessId);
    expect(await repo().rejectAlias(store, proposal!.id, owner, NOW + 1)).toBe(true);
    expect(await propose(salsa, "order-3")).toBe(false);
    expect(await repo().listProposed(store)).toEqual([]);

    expect(await propose(inglesa, "order-4")).toBe(true);
    expect(await aliasRows(store.businessId)).toEqual([
      expect.objectContaining({ id: proposal!.id, product_id: inglesa, state: "proposed", source_order_id: "order-4", decided_by_user_id: null, decided_at_ms: null }),
    ]);
    expect(await repo().listProposed(store)).toEqual([{ id: proposal!.id, said: "salsa roja", productName: "Salsa inglesa", proposedAtMs: NOW }]);
  });

  it("another store never sees, uses or approves it", async () => {
    const a = await storeWithCatalog();
    const b = await storeWithCatalog();
    await repo().proposeAlias(a.store, { said: "salsa roja", productId: a.salsa, orderId: "order-a" }, NOW);
    const [proposal] = await aliasRows(a.store.businessId);

    expect(await repo().listProposed(b.store)).toEqual([]);
    expect(await repo().countProposed(b.store)).toBe(0);
    expect(await repo().approveAlias(b.store, proposal!.id, b.owner, NOW)).toBe(false);
    expect(await repo().rejectAlias(b.store, proposal!.id, b.owner, NOW)).toBe(false);
    // Store B can't raise one for store A's product either.
    expect(await repo().proposeAlias(b.store, { said: "salsa verde", productId: a.salsa, orderId: "order-b" }, NOW)).toBe(false);
    expect(await aliasRows(b.store.businessId)).toEqual([]);

    expect(await repo().approveAlias(a.store, proposal!.id, a.owner, NOW)).toBe(true);
    expect(await repo().listApprovedAliases(b.store)).toEqual([]);
    expect((await offered(b.store, "salsa roja")).map((c) => c.how)).not.toContain("learned_alias");
    expect((await offered(b.store, "salsa roja")).map((c) => c.productId)).not.toContain(a.salsa);
    expect(await offered(a.store, "salsa roja")).toEqual([{ productId: a.salsa, how: "learned_alias" }]);

    // Only a member of that store can be the one who decided.
    await expect(
      env.DB.prepare(
        `INSERT INTO store_aliases (id, business_id, words, said, product_id, state, source, source_order_id, proposed_at_ms, decided_at_ms, decided_by_user_id)
         VALUES (?, ?, 'otra', 'otra', ?, 'approved', 'order', 'o', 1, 1, ?)`,
      )
        .bind(crypto.randomUUID(), a.store.businessId, a.salsa, b.owner)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("keeps one alias per words per store, who decided and when, and goes with its product", async () => {
    const { store, owner, salsa } = await storeWithCatalog();
    const insert = (words: string, state: string, decided: string | null) =>
      env.DB.prepare(
        `INSERT INTO store_aliases (id, business_id, words, said, product_id, state, source, source_order_id, proposed_at_ms, decided_at_ms, decided_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, 'order', 'o', 1, ?, ?)`,
      )
        .bind(crypto.randomUUID(), store.businessId, words, words, salsa, state, decided === null ? null : 2, decided)
        .run();
    await insert("salsa roja", "proposed", null);
    await expect(insert("salsa roja", "proposed", null)).rejects.toThrow(/UNIQUE/);
    await expect(insert("roja", "approved", null)).rejects.toThrow(/CHECK/);
    await expect(insert("roja", "proposed", owner)).rejects.toThrow(/CHECK/);
    await insert("roja", "approved", owner);

    expect(await setup().removeProduct(store, salsa)).toBe(true);
    expect(await aliasRows(store.businessId)).toEqual([]);
  });
});

describe("after a confirmed order (the spine's call)", () => {
  it("proposes the customer's words for lines the planner matched, unless they already find the product", async () => {
    const { store, salsa, pollo } = await storeWithCatalog();
    const { log, events } = recordingLog();
    const order = {
      orderId: "order-1",
      lines: [
        { said: "salsa roja", productId: salsa, how: "planner_pick" },
        // "Catsup" already finds the product through its other name "ketchup": nothing to learn.
        { said: "Catsup", productId: salsa, how: "planner_pick" },
        { said: "pollo entero", productId: pollo, how: "exact_name" },
        { said: "pollito", productId: pollo, how: "label_pick" },
        { said: "algo raro", productId: null, how: "planner_pick" },
      ],
    };
    expect(await proposeAliasesFromConfirmedOrder(repo(), log, store, order, NOW)).toBe(1);
    expect(await repo().listProposed(store)).toEqual([{ id: expect.any(String), said: "salsa roja", productName: "Salsa de tomate Naturas 400 g", proposedAtMs: NOW }]);
    // A retried confirmation raises nothing new.
    expect(await proposeAliasesFromConfirmedOrder(repo(), log, store, order, NOW + 1)).toBe(0);
    expect(events).toEqual([{ level: "info", event: "alias_proposed", fields: { businessId: store.businessId, count: 1 } }]);
  });

  it("never throws: a failure is logged with IDs only and the order stays as it is", async () => {
    const store = await storeWithStaff();
    const { log, events } = recordingLog();
    const broken: AliasBook = {
      listProducts: () => Promise.reject(new Error("D1 is down: salsa roja")),
      listApprovedAliases: () => Promise.resolve([]),
      proposeAlias: () => Promise.resolve(true),
    };
    const order = { orderId: "order-1", lines: [{ said: "salsa roja", productId: "p", how: "planner_pick" }] };
    expect(await proposeAliasesFromConfirmedOrder(broken, log, store, order, NOW)).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "error", event: "alias_proposal_failed", fields: { businessId: store.businessId } });
    // Nothing else reads a planner-free order.
    expect(await proposeAliasesFromConfirmedOrder(broken, log, store, { orderId: "o", lines: [] }, NOW)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

async function owners(h: Harness, store: SeededStore) {
  const owner = await login(h, store.businessId, store.members[0]!.userId);
  const csrf = await csrfFor(h, owner);
  return {
    get: async (path: string) => (await send(h, path, { cookie: owner })).text(),
    post: (path: string, form: Record<string, string>) => send(h, path, { method: "POST", form: { csrf, ...form }, cookie: owner }),
  };
}

const badgeOf = (page: string) => /href="\/console\/pendientes"[^>]*>Pendientes<span class="badge">([^<]+)<\/span>/.exec(page)?.[1] ?? null;

describe("Pendientes: the owner says if the words are the product, with one tap", () => {
  it("shows the question in plain words, counts it on the tab, and Sí makes it match", async () => {
    const h = harness();
    const { store, owner, salsa } = await storeWithCatalog();
    await repo().proposeAlias(store, { said: "salsa roja", productId: salsa, orderId: "order-1" }, NOW);
    const s = await owners(h, store);

    const page = await s.get("/console/pendientes");
    expect(page).toContain("Cómo piden los clientes (1)");
    expect(page).toContain("¿«salsa roja» es Salsa de tomate Naturas 400 g?");
    expect(page).toContain(">Sí</button>");
    expect(page).toContain(">No</button>");
    expect(page).not.toContain("No hay nada pendiente.");
    expect(badgeOf(page)).toBe("1");

    const [proposal] = await aliasRows(store.businessId);
    const tapped = await s.post("/console/pendientes/nombre", { nombre: proposal!.id, respuesta: "si" });
    expect(tapped.headers.get("location")).toBe("/console/pendientes?aviso=nombre_si");
    expect(await aliasRows(store.businessId)).toEqual([expect.objectContaining({ state: "approved", decided_by_user_id: owner })]);
    const after = await s.get("/console/pendientes?aviso=nombre_si");
    expect(after).toContain("Listo. La próxima vez el asistente lo reconoce.");
    expect(after).toContain("No hay nada pendiente.");
    expect(badgeOf(after)).toBeNull();
    expect(await offered(store, "salsa roja")).toEqual([{ productId: salsa, how: "learned_alias" }]);
  });

  it("No drops it; a second tap or a made-up answer changes nothing", async () => {
    const h = harness();
    const { store, salsa } = await storeWithCatalog();
    await repo().proposeAlias(store, { said: "salsa roja", productId: salsa, orderId: "order-1" }, NOW);
    const [proposal] = await aliasRows(store.businessId);
    const s = await owners(h, store);
    expect((await s.post("/console/pendientes/nombre", { nombre: proposal!.id, respuesta: "talvez" })).headers.get("location")).toBe(
      "/console/pendientes?aviso=falta",
    );
    expect((await s.post("/console/pendientes/nombre", { nombre: proposal!.id, respuesta: "no" })).headers.get("location")).toBe(
      "/console/pendientes?aviso=nombre_no",
    );
    expect((await s.post("/console/pendientes/nombre", { nombre: proposal!.id, respuesta: "si" })).headers.get("location")).toBe(
      "/console/pendientes?aviso=falta",
    );
    expect(await aliasRows(store.businessId)).toEqual([expect.objectContaining({ state: "rejected" })]);
    expect(await repo().listApprovedAliases(store)).toEqual([]);
  });

  it("is the owner's: staff are refused, and another store's owner can't decide it", async () => {
    const h = harness();
    const a = await storeWithCatalog();
    const b = await storeWithCatalog();
    await repo().proposeAlias(a.store, { said: "salsa roja", productId: a.salsa, orderId: "order-1" }, NOW);
    const [proposal] = await aliasRows(a.store.businessId);

    const staff = await login(h, a.store.businessId, a.store.members[1]!.userId);
    const staffCsrf = await csrfFor(h, staff);
    const refused = await send(h, "/console/pendientes/nombre", { method: "POST", form: { csrf: staffCsrf, nombre: proposal!.id, respuesta: "si" }, cookie: staff });
    expect(refused.status).toBe(403);

    const outsider = await owners(h, b.store);
    expect(await outsider.get("/console/pendientes")).not.toContain("salsa roja");
    expect((await outsider.post("/console/pendientes/nombre", { nombre: proposal!.id, respuesta: "si" })).headers.get("location")).toBe(
      "/console/pendientes?aviso=falta",
    );
    expect(await aliasRows(a.store.businessId)).toEqual([expect.objectContaining({ state: "proposed" })]);
  });
});

describe("Tienda: how a product is sold", () => {
  it("the owner sets por libra and a usual amount; a bad amount is refused and nothing changes", async () => {
    const h = harness({ env: testEnv({ PRETEND_ENGINE: "1" } as unknown as Partial<Env>) });
    const { store, pollo } = await storeWithCatalog();
    const s = await owners(h, store);
    const base = { producto: pollo, nombre: "Pollo entero", precio: "60" };

    const form = await s.get(`/console/tienda/editar?producto=${pollo}`);
    expect(form).toContain("Cómo se vende");
    expect(form).toContain(`name="vende" value="" checked`);

    expect((await s.post("/console/tienda/editar", { ...base, vende: "libra", usual: "0.5" })).headers.get("location")).toBe("/console/tienda?aviso=guardado");
    expect(await rows(`SELECT sold_by, usual_quantity_milli FROM store_product_selling WHERE product_id = ?`, pollo)).toEqual([
      { sold_by: "weight", usual_quantity_milli: 500 },
    ]);
    expect(await s.get("/console/tienda")).toContain("Se vende por libra · De siempre: 0.5 lb");
    expect(await s.get(`/console/tienda/editar?producto=${pollo}`)).toContain(`name="vende" value="libra" checked`);

    for (const usual of ["1,5", "0", "media"]) {
      const refused = await s.post("/console/tienda/editar", { ...base, precio: "99", vende: "unidad", usual });
      expect(refused.headers.get("location"), usual).toBe(`/console/tienda/editar?producto=${pollo}&aviso=cantidad`);
    }
    expect((await s.post("/console/tienda/editar", { ...base, vende: "caja", usual: "" })).status).toBe(400);
    expect((await setup().product(store, pollo))!).toMatchObject({ price: 6000, soldBy: "weight", usualQuantity: "0.5" });

    // Back to not said.
    await s.post("/console/tienda/editar", { ...base, vende: "", usual: "" });
    expect((await setup().product(store, pollo))!).toMatchObject({ soldBy: null, usualQuantity: null });
    expect(await s.get("/console/tienda")).not.toContain("Se vende por");
  });
});

describe("migration 0011 on a database that already has the store's products", () => {
  it("runs after 0019 as a deployed database runs it, and the new tables point at existing products", async () => {
    const db = env.MIGRATION_TEST_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS.filter((migration) => migration.name !== "0011_store_aliases.sql"));
    await db.batch([
      db.prepare(`INSERT INTO businesses (id, name, created_at_ms) VALUES ('store-a', 'Tienda A', 0)`),
      db.prepare(
        `INSERT INTO store_products (id, business_id, name, name_key, created_at_ms, updated_at_ms) VALUES ('p-1', 'store-a', 'Salsa de tomate', 'salsa de tomate', 0, 0)`,
      ),
    ]);
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    const { results } = await db.prepare(`SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1`).all<{ name: string }>();
    expect(results).toEqual([{ name: "0011_store_aliases.sql" }]);

    const retrieval = new D1RetrievalRepository(db);
    const store = { businessId: "store-a" };
    expect(await retrieval.proposeAlias(store, { said: "catsup", productId: "p-1", orderId: "o-1" }, 1)).toBe(true);
    expect(await new D1StoreSetupRepository(db).updateProduct(store, "p-1", { name: "Salsa de tomate", otherNames: [], price: null }, 2, { soldBy: "unit", usualQuantity: "1" })).toBe(
      "saved",
    );
    expect(await retrieval.listProducts(store)).toEqual([expect.objectContaining({ productId: "p-1", soldBy: "unit", usualQuantity: "1" })]);
    expect(await retrieval.listProposed(store)).toEqual([{ id: expect.any(String), said: "catsup", productName: "Salsa de tomate", proposedAtMs: 1 }]);
  });
});
