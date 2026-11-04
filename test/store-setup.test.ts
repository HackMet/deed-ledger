/**
 * Store setup (#40): the paste box, exact prices, hours from the form, each store's records kept
 * apart, owner-only screens, and the pretend engine (PRETEND_ENGINE) reading the store's own
 * products, "No hay" marks, hours and delivery fee. Products and prices are synthetic.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "../src/application/ports";
import { buildRuntime } from "../src/composition";
import { COPY } from "../src/domain/replies";
import { daysOf, hoursFromDays, parseFee, parseLempiras, parseOtherNames, parsePasteBox } from "../src/domain/store-setup";
import { D1StoreSetupRepository } from "../src/infrastructure/d1/store-setup-repository";
import { D1PretendEngine } from "../src/infrastructure/memory/d1-pretend-engine";
import { line, quote } from "./fixtures/model/recorded";
import { csrfFor, login, send, storeWithStaff } from "./helpers/console";
import { type Harness, harness, rows, testEnv } from "./helpers/harness";
import { newPhone, seedIntroducedCustomer, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const repo = () => new D1StoreSetupRepository(env.DB);
const pretendEnv = () => testEnv({ PRETEND_ENGINE: "1" } as unknown as Partial<Env>);

// ---------------------------------------------------------------------------------------------

describe("prices typed by the owner", () => {
  it("reads lempiras exactly, with or without L and decimals", () => {
    expect(parseLempiras("18")).toEqual({ price: 1800 });
    expect(parseLempiras("18.50")).toEqual({ price: 1850 });
    expect(parseLempiras("18.5")).toEqual({ price: 1850 });
    expect(parseLempiras("L 18")).toEqual({ price: 1800 });
    expect(parseLempiras("L.18.05")).toEqual({ price: 1805 });
    expect(parseLempiras("Lps 120")).toEqual({ price: 12000 });
    expect(parseLempiras("0.10")).toEqual({ price: 10 });
    // Floats would make 0.29 * 100 = 28.999…; the parse never goes through one.
    expect(parseLempiras("0.29")).toEqual({ price: 29 });
    expect(parseLempiras("1234.99")).toEqual({ price: 123499 });
  });

  it("refuses what it can't read instead of guessing, and never makes a zero price", () => {
    expect(parseLempiras("")).toEqual({ problem: "no_price" });
    expect(parseLempiras("18,50")).toEqual({ problem: "comma" });
    expect(parseLempiras("1,200")).toEqual({ problem: "comma" });
    expect(parseLempiras("18.505")).toEqual({ problem: "unreadable" });
    expect(parseLempiras("dieciocho")).toEqual({ problem: "unreadable" });
    expect(parseLempiras("-5")).toEqual({ problem: "unreadable" });
    expect(parseLempiras("0")).toEqual({ problem: "zero" });
    expect(parseLempiras("0.00")).toEqual({ problem: "zero" });
    expect(parseLempiras("1234567")).toEqual({ problem: "too_big" });
  });

  it("a fee may be zero on purpose; blank is not set", () => {
    expect(parseFee("")).toEqual({ fee: null });
    expect(parseFee("  ")).toEqual({ fee: null });
    expect(parseFee("0")).toEqual({ fee: 0 });
    expect(parseFee("25")).toEqual({ fee: 2500 });
    expect(parseFee("L 25.50")).toEqual({ fee: 2550 });
    expect(parseFee("25,50")).toEqual({ problem: "comma" });
  });

  it("other names: one per line or by commas, no repeats, not the product's own name", () => {
    expect(parseOtherNames("libra de arroz\narroz, Arroz 1 LB\n\n arroz ", "Arroz 1 lb")).toEqual(["libra de arroz", "arroz"]);
    expect(parseOtherNames(Array.from({ length: 11 }, (_, n) => `n${n}`).join("\n"), "x")).toBeNull();
  });
});

describe("the paste box", () => {
  it("reads the usual ways of writing a price list", () => {
    const result = parsePasteBox(
      [
        "Arroz 1 lb - 18",
        "Aceite 1 L, 58",
        "Azúcar 1 lb - L 16.50",
        "Coca-Cola 2 L - 45",
        "Café molido: L.45",
        "Jabón de lavar = 25 lempiras",
        "Pan de molde L 40",
        "  ",
        "- Frijoles rojos 1 lb - 22",
      ].join("\n"),
    );
    expect(result.problems).toEqual([]);
    expect(result.products).toEqual([
      { line: 1, name: "Arroz 1 lb", price: 1800 },
      { line: 2, name: "Aceite 1 L", price: 5800 },
      { line: 3, name: "Azúcar 1 lb", price: 1650 },
      { line: 4, name: "Coca-Cola 2 L", price: 4500 },
      { line: 5, name: "Café molido", price: 4500 },
      { line: 6, name: "Jabón de lavar", price: 2500 },
      { line: 7, name: "Pan de molde", price: 4000 },
      { line: 9, name: "Frijoles rojos 1 lb", price: 2200 },
    ]);
  });

  it("lists every line it couldn't read, and never guesses or zeroes a price", () => {
    const result = parsePasteBox(
      [
        "Huevos 30", // 30 could be the size: no separator, no L
        "Aceite 1 L 58", // the L could be the litre
        "Leche entera", // no price at all
        "Arroz - 18,50", // a comma: 18.50 or 1850?
        "Sal - 0",
        "- 18",
        "Arroz 1 lb - 18",
        "arroz 1 LB - 19", // the same product again
      ].join("\n"),
    );
    expect(result.products).toEqual([{ line: 7, name: "Arroz 1 lb", price: 1800 }]);
    expect(result.problems.map((p) => [p.line, p.problem])).toEqual([
      [1, "unreadable"],
      [2, "unreadable"],
      [3, "no_price"],
      [4, "comma"],
      [5, "zero"],
      [6, "unreadable"],
      [8, "repeated"],
    ]);
  });

  it("takes a bounded number of lines per paste", () => {
    const result = parsePasteBox(Array.from({ length: 305 }, (_, n) => `Producto ${n} - 10`).join("\n"));
    expect(result.products).toHaveLength(300);
    expect(result.truncated).toBe(true);
  });
});

describe("hours from the form", () => {
  it("groups days with the same hours, and closed days are left out", () => {
    const days = [1, 2, 3, 4, 5, 6, 7].map((day) =>
      day === 7 ? { day, opens: null, closes: null } : day === 6 ? { day, opens: "08:00", closes: "12:00" } : { day, opens: "07:00", closes: "19:00" },
    );
    const result = hoursFromDays(days);
    expect(result).toEqual({
      hours: [
        { days: [1, 2, 3, 4, 5], opens: "07:00", closes: "19:00" },
        { days: [6], opens: "08:00", closes: "12:00" },
      ],
    });
    expect(daysOf("hours" in result ? result.hours : null)).toEqual(days);
  });

  it("every day closed is no hours (te confirmo), not a made-up schedule; bad days are named", () => {
    expect(hoursFromDays(daysOf(null))).toEqual({ hours: null });
    expect(
      hoursFromDays([
        { day: 1, opens: "19:00", closes: "07:00" },
        { day: 2, opens: "", closes: "" },
        { day: 3, opens: "07:00", closes: "12:00" },
      ]),
    ).toEqual({ badDays: [1, 2] });
  });
});

// ---------------------------------------------------------------------------------------------

describe("each store's records stay its own", () => {
  it("store B can't read, edit, mark or remove store A's products", async () => {
    const a = await seedStore({ members: [] });
    const b = await seedStore({ members: [] });
    const r = repo();
    expect(await r.addProduct(a, { name: "Arroz 1 lb", otherNames: ["arroz"], price: 1800 }, 1)).toBe("added");
    // The same name in another store is that store's own product.
    expect(await r.addProduct(b, { name: "Arroz 1 lb", otherNames: [], price: 2000 }, 1)).toBe("added");
    const [productA] = await r.listProducts(a);
    const id = productA!.productId;

    expect(await r.product(b, id)).toBeNull();
    expect(await r.updateProduct(b, id, { name: "Robado", otherNames: [], price: 1 }, 2)).toBe("missing");
    expect(await r.setNoHay(b, id, true, 2)).toBe(false);
    expect(await r.removeProduct(b, id)).toBe(false);
    expect(await r.listProducts(a)).toEqual([
      { productId: id, name: "Arroz 1 lb", otherNames: ["arroz"], price: 1800, noHay: false, soldBy: null, usualQuantity: null },
    ]);
    expect((await r.listProducts(b)).map((p) => p.price)).toEqual([2000]);
  });

  it("names are compared without case or accents; a price left out stays unknown", async () => {
    const a = await seedStore({ members: [] });
    const r = repo();
    expect(await r.addProduct(a, { name: "Azúcar 1 lb", otherNames: [], price: null }, 1)).toBe("added");
    expect(await r.addProduct(a, { name: "azucar 1 LB", otherNames: [], price: 1600 }, 1)).toBe("exists");
    expect(await r.listProducts(a)).toEqual([expect.objectContaining({ name: "Azúcar 1 lb", price: null, noHay: false })]);
    expect(await rows(`SELECT price_centavos FROM store_products WHERE business_id = ?`, a.businessId)).toEqual([{ price_centavos: null }]);
  });

  it("the database refuses a zero price and a negative fee", async () => {
    const a = await seedStore({ members: [] });
    await expect(
      env.DB.prepare(
        `INSERT INTO store_products (id, business_id, name, name_key, price_centavos, created_at_ms, updated_at_ms) VALUES (?, ?, 'x', 'x', 0, 1, 1)`,
      )
        .bind(crypto.randomUUID(), a.businessId)
        .run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare(`INSERT INTO store_setup_settings (business_id, delivery_fee_centavos, updated_at_ms) VALUES (?, -1, 1)`).bind(a.businessId).run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("hours and fee are per store; unset reads as null", async () => {
    const a = await seedStore({ members: [] });
    const b = await seedStore({ members: [] });
    const r = repo();
    const hours = [{ days: [1, 2, 3, 4, 5, 6], opens: "07:00", closes: "19:00" }];
    await r.saveHours(a, hours, 1);
    await r.saveDeliveryFee(a, 2500, 1);
    expect(await r.settings(a)).toEqual({ hours, deliveryFee: 2500 });
    expect(await r.settings(b)).toEqual({ hours: null, deliveryFee: null });
    // Saving the fee keeps the hours, and the other way round.
    await r.saveDeliveryFee(a, null, 2);
    expect(await r.settings(a)).toEqual({ hours, deliveryFee: null });
    await expect(r.saveHours(a, [{ days: [1], opens: "19:00", closes: "07:00" }], 3)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------

async function ownerSession(h: Harness) {
  const store = await storeWithStaff();
  const cookie = await login(h, store.businessId, store.members[0]!.userId);
  const csrf = await csrfFor(h, cookie);
  const post = (path: string, form: Record<string, string>) => send(h, path, { method: "POST", form: { csrf, ...form }, cookie });
  const get = async (path: string) => (await send(h, path, { cookie })).text();
  return { store, cookie, csrf, post, get };
}

const productsOf = (businessId: string) =>
  rows<{ id: string; name: string; price_centavos: number | null; no_hay: number; other_names_json: string }>(
    `SELECT id, name, price_centavos, no_hay, other_names_json FROM store_products WHERE business_id = ? ORDER BY name_key`,
    businessId,
  );

describe("the Tienda screens", () => {
  it("the owner adds, edits, marks No hay and Sí hay, and removes a product, on the one list", async () => {
    const h = harness({ env: pretendEnv() });
    const s = await ownerSession(h);
    const added = await s.post("/console/tienda/agregar", { nombre: "  Arroz   1 lb ", precio: "L 18.50", otros: "arroz\nlibra de arroz" });
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe("/console/tienda?aviso=agregado");
    const [product] = await productsOf(s.store.businessId);
    expect(product).toMatchObject({ name: "Arroz 1 lb", price_centavos: 1850, no_hay: 0, other_names_json: '["arroz","libra de arroz"]' });

    // Tienda points to Productos, where the product is, with its confirmed price.
    const tienda = await s.get("/console/tienda?aviso=agregado");
    expect(tienda).toContain("Listo. Producto agregado.");
    expect(tienda).toContain(`href="/console/productos"`);
    const list = await s.get("/console/productos");
    expect(list).toContain("Arroz 1 lb");
    expect(list).toContain("L 18.50");

    // Edit: a blank price leaves the recorded price as it is (a price is a ledger fact, never cleared to zero).
    const edited = await s.post("/console/tienda/editar", { producto: product!.id, nombre: "Arroz 1 lb", precio: "", otros: "arroz" });
    expect(edited.headers.get("location")).toBe("/console/tienda?aviso=guardado");
    expect(await productsOf(s.store.businessId)).toEqual([expect.objectContaining({ price_centavos: 1850, other_names_json: '["arroz"]' })]);

    expect((await s.post("/console/tienda/hay", { producto: product!.id, no_hay: "1" })).headers.get("location")).toBe(
      `/console/tienda?aviso=no_hay#p-${product!.id}`,
    );
    expect((await productsOf(s.store.businessId))[0]!.no_hay).toBe(1);
    expect(await s.get(`/console/productos/${product!.id}`)).toContain(">Sí hay</button>");
    await s.post("/console/tienda/hay", { producto: product!.id, no_hay: "0" });
    expect((await productsOf(s.store.businessId))[0]!.no_hay).toBe(0);

    expect(await s.get(`/console/tienda/quitar?producto=${product!.id}`)).toContain("¿Quitar Arroz 1 lb?");
    expect((await s.post("/console/tienda/quitar", { producto: product!.id })).headers.get("location")).toBe("/console/tienda?aviso=quitado");
    expect(await productsOf(s.store.businessId)).toEqual([]);
    expect(await rows(`SELECT id FROM products WHERE business_id = ?`, s.store.businessId)).toEqual([]);
  });

  it("refuses a price it can't read and a name already taken, saving nothing", async () => {
    const h = harness({ env: pretendEnv() });
    const s = await ownerSession(h);
    expect((await s.post("/console/tienda/agregar", { nombre: "Arroz", precio: "18,50" })).headers.get("location")).toBe("/console/tienda?aviso=precio");
    expect((await s.post("/console/tienda/agregar", { nombre: "Arroz", precio: "0" })).headers.get("location")).toBe("/console/tienda?aviso=precio");
    expect((await s.post("/console/tienda/agregar", { nombre: "   ", precio: "18" })).headers.get("location")).toBe("/console/tienda?aviso=nombre");
    expect(await productsOf(s.store.businessId)).toEqual([]);

    await s.post("/console/tienda/agregar", { nombre: "Arroz", precio: "18" });
    await s.post("/console/tienda/agregar", { nombre: "Frijoles", precio: "22" });
    expect((await s.post("/console/tienda/agregar", { nombre: "ARROZ", precio: "20" })).headers.get("location")).toBe("/console/tienda?aviso=existe");
    const frijoles = (await productsOf(s.store.businessId)).find((p) => p.name === "Frijoles")!;
    const renamed = await s.post("/console/tienda/editar", { producto: frijoles.id, nombre: "arroz", precio: "22" });
    expect(renamed.headers.get("location")).toBe(`/console/tienda/editar?producto=${frijoles.id}&aviso=nombre_usado`);
    expect((await productsOf(s.store.businessId)).map((p) => [p.name, p.price_centavos])).toEqual([
      ["Arroz", 1800],
      ["Frijoles", 2200],
    ]);
  });

  it("the paste box shows what it read and what it couldn't, and saves only on Guardar", async () => {
    const h = harness({ env: pretendEnv() });
    const s = await ownerSession(h);
    await s.post("/console/tienda/agregar", { nombre: "Arroz 1 lb", precio: "16", otros: "arroz" });
    // A new price for the same product is a new operation only in a later minute (D-44's key).
    h.clock.advance(60_000);
    const lista = ["Arroz 1 lb - 18", "Aceite 1 L, 58", "Huevos 30", "Leche entera"].join("\n");

    const preview = await s.post("/console/tienda/pegar", { lista });
    expect(preview.status).toBe(200);
    const page = await preview.text();
    expect(page).toContain("Se van a guardar 2");
    expect(page).toContain("ya está, cambia de L 16");
    expect(page).toContain("nuevo");
    expect(page).toContain("2 líneas no se van a guardar");
    expect(page).toContain("Línea 3: «Huevos 30»");
    expect(page).toContain("Línea 4: «Leche entera»: no tiene precio.");
    // Nothing saved yet.
    expect((await productsOf(s.store.businessId)).map((p) => [p.name, p.price_centavos])).toEqual([["Arroz 1 lb", 1600]]);

    const saved = await s.post("/console/tienda/pegar/guardar", { lista });
    expect(saved.headers.get("location")).toBe("/console/tienda?aviso=pegados");
    // A name the store has gets the new price and keeps its other names; the unreadable lines aren't saved.
    expect((await productsOf(s.store.businessId)).map((p) => [p.name, p.price_centavos, p.other_names_json])).toEqual([
      ["Aceite 1 L", 5800, "[]"],
      ["Arroz 1 lb", 1800, '["arroz"]'],
    ]);
    expect((await s.post("/console/tienda/pegar/guardar", { lista: "Leche entera" })).headers.get("location")).toBe("/console/tienda?aviso=nada");
  });

  it("saves hours per day and the delivery fee; a bad day is shown back, not saved", async () => {
    const h = harness({ env: pretendEnv() });
    const s = await ownerSession(h);
    const week: Record<string, string> = {};
    for (const day of [1, 2, 3, 4, 5, 6]) Object.assign(week, { [`abierto_${day}`]: "1", [`abre_${day}`]: "07:00", [`cierra_${day}`]: "19:00" });
    expect((await s.post("/console/tienda/horario", week)).headers.get("location")).toBe("/console/tienda/horario?aviso=horario");
    expect(await repo().settings(s.store)).toEqual({ hours: [{ days: [1, 2, 3, 4, 5, 6], opens: "07:00", closes: "19:00" }], deliveryFee: null });
    const form = await s.get("/console/tienda/horario");
    expect(form).toContain('name="abre_1" value="07:00"');
    expect(form).toContain("Ahora: sin definir.");

    const bad = await s.post("/console/tienda/horario", { ...week, abierto_7: "1", abre_7: "12:00", cierra_7: "08:00" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Revisá domingo");
    expect((await repo().settings(s.store)).hours).toEqual([{ days: [1, 2, 3, 4, 5, 6], opens: "07:00", closes: "19:00" }]);

    expect((await s.post("/console/tienda/envio", { envio: "25" })).headers.get("location")).toBe("/console/tienda/horario?aviso=envio");
    expect((await repo().settings(s.store)).deliveryFee).toBe(2500);
    expect((await s.post("/console/tienda/envio", { envio: "veinte" })).headers.get("location")).toBe("/console/tienda/horario?aviso=envio_mal");
    expect((await repo().settings(s.store)).deliveryFee).toBe(2500);
    expect(await s.get("/console/tienda/horario")).toContain("Ahora: L 25.");

    // Every day closed: hours unset, so the bot says "te confirmo".
    expect((await s.post("/console/tienda/horario", {})).headers.get("location")).toBe("/console/tienda/horario?aviso=sin_horario");
    expect((await repo().settings(s.store)).hours).toBeNull();
  });

  it("is owner only: staff get no link and can't open or change anything", async () => {
    const h = harness({ env: pretendEnv() });
    const owner = await ownerSession(h);
    const ownerMas = await owner.get("/console/mas");
    // Productos is a tab; the hours and delivery are reached from Mi tienda (/console/negocio).
    for (const href of ["/console/productos", "/console/negocio", "/console/facturas"]) {
      expect(ownerMas).toContain(`href="${href}"`);
    }
    expect(await owner.get("/console/negocio")).toContain('href="/console/tienda/horario"');
    await owner.post("/console/tienda/agregar", { nombre: "Arroz", precio: "18" });
    const [product] = await productsOf(owner.store.businessId);

    const staffCookie = await login(h, owner.store.businessId, owner.store.members[1]!.userId);
    const csrf = await csrfFor(h, staffCookie);
    const staffMas = await (await send(h, "/console/mas", { cookie: staffCookie })).text();
    expect(staffMas).not.toContain('href="/console/tienda"');
    // K6 and K14: staff may propose prices, but the business info and invoices are the owner's.
    expect(staffMas).toContain('href="/console/productos"');
    expect(staffMas).not.toContain('href="/console/negocio"');
    expect(staffMas).not.toContain('href="/console/facturas"');
    for (const path of ["/console/tienda", "/console/tienda/horario", "/console/tienda/pegar", `/console/tienda/editar?producto=${product!.id}`]) {
      expect((await send(h, path, { cookie: staffCookie })).status, path).toBe(403);
    }
    const posts: [string, Record<string, string>][] = [
      ["/console/tienda/agregar", { nombre: "Pan", precio: "40" }],
      ["/console/tienda/editar", { producto: product!.id, nombre: "Arroz", precio: "1" }],
      ["/console/tienda/hay", { producto: product!.id, no_hay: "1" }],
      ["/console/tienda/quitar", { producto: product!.id }],
      ["/console/tienda/pegar/guardar", { lista: "Pan - 40" }],
      ["/console/tienda/horario", { abierto_1: "1", abre_1: "07:00", cierra_1: "08:00" }],
      ["/console/tienda/envio", { envio: "1" }],
    ];
    for (const [path, form] of posts) {
      expect((await send(h, path, { method: "POST", cookie: staffCookie, form: { csrf, ...form } })).status, path).toBe(403);
    }
    expect((await productsOf(owner.store.businessId)).map((p) => [p.name, p.price_centavos, p.no_hay])).toEqual([["Arroz", 1800, 0]]);
    expect(await repo().settings(owner.store)).toEqual({ hours: null, deliveryFee: null });
    // Without a session, nothing at all.
    expect((await send(h, "/console/tienda")).status).toBe(401);
  });

  it("an owner of another store can't touch this store's products by ID", async () => {
    const h = harness({ env: pretendEnv() });
    const a = await ownerSession(h);
    await a.post("/console/tienda/agregar", { nombre: "Arroz", precio: "18" });
    const [product] = await productsOf(a.store.businessId);
    const b = await ownerSession(h);

    // The edit screen is Productos' details page now: another store's ID finds nothing there.
    expect((await send(h, `/console/productos/${product!.id}`, { cookie: b.cookie })).headers.get("location")).toBe("/console/productos?aviso=falta");
    for (const [path, form] of [
      ["/console/tienda/editar", { producto: product!.id, nombre: "Robado", precio: "1" }],
      ["/console/tienda/hay", { producto: product!.id, no_hay: "1" }],
      ["/console/tienda/quitar", { producto: product!.id }],
    ] as const) {
      expect((await b.post(path, form)).headers.get("location"), path).toBe("/console/tienda?aviso=falta");
    }
    expect((await productsOf(a.store.businessId)).map((p) => [p.name, p.price_centavos, p.no_hay])).toEqual([["Arroz", 1800, 0]]);
    expect(await b.get("/console/tienda")).not.toContain(product!.id);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the pretend engine reads the store's setup", () => {
  it("products, other names, No hay, hours and fee, per store", async () => {
    const a = await seedStore({ members: [] });
    const b = await seedStore({ members: [] });
    const r = repo();
    await r.addProduct(a, { name: "Arroz 1 lb", otherNames: ["arroz"], price: 1800 }, 1);
    await r.addProduct(a, { name: "Leche 1 L", otherNames: ["leche"], price: null }, 1);
    const leche = (await r.listProducts(a)).find((p) => p.name === "Leche 1 L")!;
    await r.setNoHay(a, leche.productId, true, 2);
    const engine = new D1PretendEngine(env.DB, { setup: r });

    const catalog = await engine.catalog(a);
    expect(catalog).toEqual([
      expect.objectContaining({ names: ["Arroz 1 lb"], aliases: ["arroz"], price: 1800 }),
      expect.objectContaining({ productId: leche.productId, names: ["Leche 1 L"], aliases: ["leche"], price: null, availability: "se_acabo" }),
    ]);
    expect(catalog[0]).not.toHaveProperty("availability"); // unmarked is unknown, never "hay"
    expect(await engine.catalog(b)).toEqual([]);

    await r.saveHours(a, [{ days: [1, 2, 3, 4, 5, 6], opens: "07:00", closes: "19:00" }], 1);
    const claims = [
      { type: "store_hours", hours: [{ days: [1, 2, 3, 4, 5, 6], opens: "07:00", closes: "19:00" }] },
      { type: "unit_price", productId: catalog[0]!.productId, price: 1800 },
      { type: "availability", productId: leche.productId, availability: "se_acabo" },
    ] as const;
    expect(await engine.verifyClaims(a, claims)).toEqual([true, true, true]);
    expect(await engine.verifyClaims(b, claims)).toEqual([false, false, false]);
    // A change on the screen is read on the next call: no stale copy.
    await r.setNoHay(a, leche.productId, false, 3);
    expect(await engine.verifyClaims(a, [claims[2]])).toEqual([false]);
  });

  it("the Worker with PRETEND_ENGINE uses it", () => {
    expect(buildRuntime(pretendEnv()).engine).toBeInstanceOf(D1PretendEngine);
  });
});

/** Muse Spark's place: each call gets the next recorded reading. Never the network. */
class RecordedProvider implements ModelProvider {
  readonly model = "muse-spark-1.3";
  readonly requests: ModelRequest[] = [];
  constructor(private readonly readings: unknown[]) {}
  async complete(request: ModelRequest) {
    this.requests.push(request);
    const json = this.readings.shift();
    if (json === undefined) throw new Error("no recorded reading left");
    return { ok: true, json, latencyMs: 5_000, inputTokens: 3_000, outputTokens: 500 } as const;
  }
}

const none = { issues: [] };

/** A named, introduced customer writing to a store on the Worker built with PRETEND_ENGINE=1. */
async function pilotCustomer(readings: unknown[]) {
  const store = await seedStore({ members: [] });
  const phone = newPhone();
  const customerId = await seedIntroducedCustomer(store, phone);
  await env.DB.prepare(`UPDATE customers SET name = 'Ana', name_saved_at_ms = 1 WHERE id = ?`).bind(customerId).run();
  const h = harness({ env: pretendEnv(), modelProvider: new RecordedProvider(readings) });
  const say = async (body: string) => {
    h.clock.advance(1_000);
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body })] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
    return h.sentTo(phone).at(-1);
  };
  return { h, store, say };
}

describe("No hay reaches the customer (PRETEND_ENGINE, end to end)", () => {
  it("answers ¿hay? and ¿a cuánto? from the store's own records", async () => {
    const t = await pilotCustomer([
      { observations: [{ kind: "question", topic: "availability", products: ["leche", "arroz"], ...none }] },
      { observations: [{ kind: "question", topic: "price", products: ["arroz"], ...none }] },
      { observations: [{ kind: "question", topic: "store_hours", products: [], ...none }] },
    ]);
    const r = repo();
    await r.addProduct(t.store, { name: "Arroz 1 lb", otherNames: ["arroz"], price: 1800 }, 1);
    await r.addProduct(t.store, { name: "Leche 1 L", otherNames: ["leche"], price: 3200 }, 1);
    await r.setNoHay(t.store, (await r.listProducts(t.store)).find((p) => p.name === "Leche 1 L")!.productId, true, 1);

    expect(await t.say("¿Hay leche y arroz?")).toBe(["Leche: ahorita no hay.", "Arroz: te confirmo si hay."].join("\n"));
    expect(await t.say("¿A cuánto el arroz?")).toBe("Arroz: L 18.");
    expect(await t.say("¿A qué hora abren?")).toBe(COPY.hoursUnknown);
  });

  it("an order with a No hay product says it's out, leaves it out of the total, and adds the store's fee", async () => {
    const order = {
      observations: [
        {
          kind: "customer_order",
          lines: [
            line("2 libras de arroz", "arroz", "2", "libra", quote(0, "2 libras de arroz")),
            line("1 leche", "leche", "1", null, quote(0, "1 leche")),
          ],
          ...none,
        },
        { kind: "fulfillment", mode: "delivery", place_text: "frente al parque", same_as_before: false, ...none },
      ],
    };
    const t = await pilotCustomer([order]);
    const r = repo();
    await r.addProduct(t.store, { name: "Arroz 1 lb", otherNames: ["arroz"], price: 1800 }, 1);
    await r.addProduct(t.store, { name: "Leche 1 L", otherNames: ["leche"], price: 3200 }, 1);
    await r.setNoHay(t.store, (await r.listProducts(t.store)).find((p) => p.name === "Leche 1 L")!.productId, true, 1);
    await r.saveDeliveryFee(t.store, 2500, 1);

    const readback = (await t.say("2 libras de arroz, 1 leche, llevamelo frente al parque"))!;
    expect(readback.split("\n")).toEqual([
      "Tu pedido:",
      "• 2 Arroz 1 lb · L 36",
      "• Leche 1 L: ahorita no hay.",
      "",
      "📍 Te lo llevamos a: Frente al parque",
      "💵 Total: L 61 (L 36 + L 25 de envío). Pagás cuando te lo entregamos.",
      "",
      "¿Te lo preparo así?",
    ]);
  });
});
