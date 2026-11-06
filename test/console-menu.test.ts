import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PendientesBoard, Tenant } from "../src/application/ports";
import { D1Pendientes } from "../src/infrastructure/d1/pendientes-repository";
import { navFor } from "../src/interfaces/http/console/layout";
import { demoOrders } from "../src/infrastructure/memory/demo-orders";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";
import { consoleLogger, randomIds, systemClock } from "../src/infrastructure/runtime";
import { login, send, storeWithStaff } from "./helpers/console";
import { harness, testEnv } from "./helpers/harness";

const consoleHarness = (env?: Env, pendientesBoard?: PendientesBoard) =>
  harness({
    engine: new MemoryEngine(() => demoOrders(0)),
    ...(env === undefined ? {} : { env }),
    ...(pendientesBoard === undefined ? {} : { pendientesBoard }),
  });

/**
 * The navigation as a person reads it on a phone (the tab bar) or a wide screen (the sidebar): each
 * entry's label and whether it's lit. Entries without a class show on both.
 */
const navOf = (page: string) =>
  [
    ...(/<nav class="tabs">([\s\S]*?)<\/nav>/.exec(page)?.[1] ?? "").matchAll(
      /<a (?:class="(wide|phone)" )?href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g,
    ),
  ].map(([, where, href, current, label]) => ({ where: where ?? "both", href, label, current: current !== undefined }));
const tabsOf = (page: string) => navOf(page).filter((entry) => entry.where !== "wide");
const sidebarOf = (page: string) => navOf(page).filter((entry) => entry.where !== "phone");

/** The owner's bell in the top bar, with its count if any; undefined when the page has no bell. */
const bellOf = (page: string) => {
  const bell = /<a class="bell" href="\/console\/pendientes"[^>]*>([\s\S]*?)<\/a>/.exec(page)?.[1];
  return bell === undefined ? undefined : { badge: /<span class="badge">([^<]+)<\/span>/.exec(bell)?.[1] ?? null };
};

const FIVE_TABS = ["Inicio", "Pedidos", "Anotar", "Productos", "Más"];
const DAILY = ["Inicio", "Pedidos", "Anotar", "Productos"];

/** The chip on the right of the top bar, as text. */
const whoOn = (page: string) => /<span class="who">([\s\S]*?)<\/span><\/header>/.exec(page)?.[1]?.replace(/<[^>]+>/g, "");

const setName = (table: "memberships" | "users", name: string | null, businessId: string, userId: string) =>
  table === "memberships"
    ? env.DB.prepare(`UPDATE memberships SET display_name = ? WHERE business_id = ? AND user_id = ?`).bind(name, businessId, userId).run()
    : env.DB.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).bind(name, userId).run();

/** Records whose count each console page read; the items themselves stay in D1. */
class CountingBoard implements PendientesBoard {
  readonly counted: string[] = [];
  constructor(private readonly inner: PendientesBoard) {}
  listOpen(tenant: Tenant) {
    return this.inner.listOpen(tenant);
  }
  markDone(tenant: Tenant, id: string, userId: string, nowMs: number) {
    return this.inner.markDone(tenant, id, userId, nowMs);
  }
  async countOpen(tenant: Tenant) {
    this.counted.push(tenant.businessId);
    return this.inner.countOpen(tenant);
  }
}

const fixedCount = (count: number | Error): PendientesBoard => ({
  listOpen: async () => [],
  markDone: async () => false,
  countOpen: async () => {
    if (count instanceof Error) throw count;
    return count;
  },
});

const handoff = (inboundId: string) =>
  ({ kind: "customer_handoff", conversationId: null as unknown as string, customerId: "c", inboundId }) as const;

async function sessions() {
  const h = consoleHarness();
  const seeded = await storeWithStaff();
  const store = { businessId: seeded.businessId, ownerId: seeded.members[0]!.userId, staffId: seeded.members[1]!.userId };
  const owner = await login(h, store.businessId, store.ownerId);
  const staff = await login(h, store.businessId, store.staffId);
  const page = async (path: string, cookie: string) => send(h, path, { cookie });
  return { h, store, owner, staff, page };
}

describe("the console menu", () => {
  it("shows the owner Inicio, Pedidos, Anotar, Productos and Más, in that order, at the bottom", async () => {
    const { owner, page } = await sessions();
    const html = await (await page("/console/preparacion", owner)).text();
    expect(tabsOf(html).map((t) => t.label)).toEqual(FIVE_TABS);
    // A wide screen's sidebar has room for Más's entries, so it lists them and leaves Más out.
    expect(sidebarOf(html).map((t) => t.label)).toEqual([...DAILY, "Mi tienda", "Empleados", "Facturas", "Deed en vivo", "Aviso de privacidad"]);
    // After the screen's content, so it sits at the bottom of a phone screen.
    expect(html.indexOf('<nav class="tabs">')).toBeGreaterThan(html.indexOf("</main>"));
  });

  it("shows staff the same five tabs, a sidebar without the owner's entries, and no Pendientes bell", async () => {
    const { staff, page } = await sessions();
    const html = await (await page("/console/preparacion", staff)).text();
    expect(tabsOf(html).map((t) => t.label)).toEqual(FIVE_TABS);
    expect(sidebarOf(html).map((t) => t.label)).toEqual([...DAILY, "Deed en vivo", "Aviso de privacidad"]);
    expect(bellOf(html)).toBeUndefined();
  });

  it("lights the screen you're on: in the sidebar its own entry, on a phone Más for Más's entries", async () => {
    const { owner, page } = await sessions();
    for (const [path, tab, side] of [
      ["/console/inicio", "Inicio", "Inicio"],
      ["/console/preparacion", "Pedidos", "Pedidos"],
      ["/console/preparacion/demo-order-1", "Pedidos", "Pedidos"],
      ["/console/pedidos", "Pedidos", "Pedidos"],
      ["/console/facturas", "Más", "Facturas"],
      ["/console/facturas/nueva", "Más", "Facturas"],
      ["/console/anotar", "Anotar", "Anotar"],
      ["/console/productos", "Productos", "Productos"],
      ["/console/pendientes", "Inicio", "Inicio"],
      ["/console/mas", "Más", null],
      ["/console/empleados", "Más", "Empleados"],
      ["/console/negocio", "Más", "Mi tienda"],
      ["/console/deed/en-vivo", "Más", "Deed en vivo"],
    ] as const) {
      const response = await page(path, owner);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(tabsOf(html).filter((t) => t.current).map((t) => t.label), path).toEqual([tab]);
      expect(sidebarOf(html).filter((t) => t.current).map((t) => t.label), path).toEqual(side === null ? [] : [side]);
    }
  });

  it("leaves Empleados out of a demo store's menu, since the demo can't add staff", () => {
    const member = { businessId: "demo-x", userId: "u", sessionId: "s", role: "owner", canApproveFiado: true, displayName: null } as const;
    expect(navFor(member).map((entry) => entry.label)).not.toContain("Empleados");
    expect(navFor({ ...member, businessId: "store-x" }).map((entry) => entry.label)).toContain("Empleados");
  });

  it("keeps Pendientes for the owner: staff get a refusal, not the page", async () => {
    const { staff, page } = await sessions();
    const response = await page("/console/pendientes", staff);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Esta parte es solo para el dueño.");
  });

  it("lists Más short, one entry per job: Mi tienda, Empleados and Facturas for the owner only, Deed en vivo for everyone, no Pronto entries", async () => {
    const { owner, staff, page } = await sessions();
    const forOwner = await (await page("/console/mas", owner)).text();
    const labels = (html: string) => [...html.matchAll(/<span class="label">([^<]+)<\/span>/g)].map(([, label]) => label);
    expect(labels(forOwner)).toEqual(["Mi tienda", "Empleados", "Facturas", "Deed en vivo", "Aviso de privacidad"]);
    expect(forOwner).toContain('<a href="/console/negocio">');
    expect(forOwner).toContain('<a href="/console/empleados">');
    expect(forOwner).toContain('<a href="/console/facturas">');
    expect(forOwner).toContain('<a href="/privacidad">');
    // Each of these lives somewhere else now: the Productos tab, Anotar and the order's own page.
    for (const gone of ["/console/productos\"><span", "/console/tienda\"", "/console/deed/verificaciones", "Pronto", "Asistente en pausa", "Pedido a mano", "Cierre del día"]) {
      expect(forOwner).not.toContain(gone);
    }

    const forStaff = await (await page("/console/mas", staff)).text();
    expect(labels(forStaff)).toEqual(["Deed en vivo", "Aviso de privacidad"]);
    expect(forStaff).not.toContain("/console/empleados");
    expect(forStaff).not.toContain("/console/negocio");
    expect(forStaff).not.toContain("/console/facturas");
  });

  it("offers 'Probar como cliente' on Inicio with the store's own number once a webhook has said it, to owner and staff", async () => {
    const { store, owner, staff, page } = await sessions();
    expect(await (await page("/console/inicio", owner)).text()).not.toContain("Probar como cliente");

    await env.DB.prepare(`UPDATE channel_accounts SET display_phone_number = '15550317081' WHERE business_id = ?`).bind(store.businessId).run();
    const other = await storeWithStaff();
    await env.DB.prepare(`UPDATE channel_accounts SET display_phone_number = '50499998888' WHERE business_id = ?`).bind(other.businessId).run();
    expect(await (await page("/console/mas", owner)).text()).not.toContain("Probar como cliente");
    for (const cookie of [owner, staff]) {
      const html = await (await page("/console/inicio", cookie)).text();
      expect(html).toContain("+1 555 031 7081");
      expect(html).toContain('href="https://wa.me/15550317081?text=Hola%2C%20quiero%20hacer%20un%20pedido"');
      expect(html).toContain("Probar como cliente");
      expect(html).not.toContain("50499998888");
    }
  });
});

describe("the top bar", () => {
  it("shows each screen's title and who is logged in, with their role", async () => {
    const { store, owner, staff, page } = await sessions();
    await setName("memberships", "Johan", store.businessId, store.ownerId);
    await setName("memberships", "Rosa", store.businessId, store.staffId);
    for (const [path, title, subtitle] of [
      ["/console/preparacion", "Pedidos", "Hoy · 3 por preparar"],
      ["/console/preparacion/demo-order-1", "Carla", "Versión 2 · Recoge en tienda"],
      ["/console/anotar", "Anotar", "Te muestro lo que entendí. Todavía no se guarda nada."],
      ["/console/pendientes", "Pendientes", "Lo que solo vos decidís"],
      ["/console/mas", "Más", null],
      ["/console/empleados", "Empleados", "Quién entra a la consola"],
      ["/console/bienvenida", "Antes de empezar", null],
    ] as const) {
      const html = await (await page(path, owner)).text();
      expect(html, path).toContain(`<h1>${title}</h1>`);
      if (subtitle !== null) expect(html, path).toContain(`<p class="sub">${subtitle}</p>`);
      expect(whoOn(html), path).toBe("Johan · Dueño");
    }
    expect(whoOn(await (await page("/console/preparacion", staff)).text())).toBe("Rosa · Empleado");
  });

  it("names a person only as their store does; without a name it shows the role alone", async () => {
    const { store, owner, staff, page } = await sessions();
    const who = async (cookie: string) => whoOn(await (await page("/console/mas", cookie)).text());
    expect(await who(owner)).toBe("Dueño");
    expect(await who(staff)).toBe("Empleado");
    // The person's own record, written only by the operator's scripts: the owner's shows, staff's doesn't.
    await setName("users", "Johan Rodas", store.businessId, store.ownerId);
    await setName("users", "Rosa Personal", store.businessId, store.staffId);
    expect(await who(owner)).toBe("Johan Rodas · Dueño");
    expect(await who(staff)).toBe("Empleado");
    // The store's own name wins, and is escaped like everything typed.
    await setName("memberships", "<b>Rosa</b>", store.businessId, store.staffId);
    const html = await (await page("/console/mas", staff)).text();
    expect(whoOn(html)).toBe("&lt;b&gt;Rosa&lt;/b&gt; · Empleado");
    expect(html).not.toContain("<b>Rosa</b>");
  });
});

describe("the Pendientes count on the bell", () => {
  it("shows the owner's open count on every screen; staff pages never read it", async () => {
    const store = await storeWithStaff();
    const other = await storeWithStaff();
    const stored = new D1Pendientes(env.DB, randomIds, systemClock, consoleLogger);
    for (const inboundId of ["in-1", "in-2", "in-3"]) await stored.raise(store, handoff(inboundId));
    await stored.raise(other, handoff("in-x"));
    const board = new CountingBoard(stored);
    const h = consoleHarness(undefined, board);
    const owner = await login(h, store.businessId, store.members[0]!.userId);
    const staff = await login(h, store.businessId, store.members[1]!.userId);
    const pendientesTab = async (path: string, cookie: string) => bellOf(await (await send(h, path, { cookie })).text());

    for (const path of ["/console/preparacion", "/console/preparacion/demo-order-1", "/console/anotar", "/console/pendientes", "/console/mas"]) {
      expect(await pendientesTab(path, owner), path).toMatchObject({ badge: "3" });
    }
    expect(new Set(board.counted)).toEqual(new Set([store.businessId]));

    board.counted.length = 0;
    for (const path of ["/console/preparacion", "/console/preparacion/demo-order-1", "/console/anotar", "/console/mas", "/console/bienvenida"]) {
      const html = await (await send(h, path, { cookie: staff })).text();
      expect(html, path).not.toContain('class="badge"');
    }
    expect(board.counted).toEqual([]);

    // Listo takes one off.
    const [item] = await stored.listOpen(store);
    await stored.markDone(store, item!.id, store.members[0]!.userId, Date.now());
    expect(await pendientesTab("/console/preparacion", owner)).toMatchObject({ badge: "2" });
  });

  it("shows no count when nothing is open, 99+ past 99, and the page without it when it can't be read", async () => {
    const store = await storeWithStaff();
    const ownerOf = async (board: PendientesBoard) => {
      const h = consoleHarness(undefined, board);
      const cookie = await login(h, store.businessId, store.members[0]!.userId);
      const response = await send(h, "/console/preparacion", { cookie });
      return { h, response, tab: bellOf(await response.text()) };
    };
    expect((await ownerOf(fixedCount(0))).tab).toMatchObject({ badge: null });
    expect((await ownerOf(fixedCount(120))).tab).toMatchObject({ badge: "99+" });
    const failing = await ownerOf(fixedCount(new Error("D1 down")));
    expect(failing.response.status).toBe(200);
    expect(failing.tab).toMatchObject({ badge: null });
    expect(failing.h.log.lines.join("\n")).toContain("pendientes_count_failed");
  });
});

describe("the dev console (local simulator)", () => {
  const devEnv = (phoneNumberId = "") =>
    testEnv({ DEV_CONSOLE: "1", DEV_STORE_PHONE_NUMBER_ID: phoneNumberId } as unknown as Partial<Env>);

  it("acts as the owner of the simulator's store, so it shows the same store the chat writes to", async () => {
    const store = await storeWithStaff();
    await storeWithStaff(); // another store, never shown
    const h = consoleHarness(devEnv(store.phoneNumberId));
    const html = await (await send(h, "/console/empleados")).text();
    expect(bellOf(html)).toBeDefined();
    // Empleados lists this store's people: the seeded store is the one shown.
    expect(html).toContain(store.members[1]!.userId);
    await setName("memberships", "Johan", store.businessId, store.members[0]!.userId);
    expect(whoOn(await (await send(h, "/console/mas")).text())).toBe("Johan · Dueño");
  });

  it("falls back to a staff member of an empty demo store without the simulator's store", async () => {
    await storeWithStaff();
    const h = consoleHarness(devEnv("100000000000999"));
    const html = await (await send(h, "/console/preparacion")).text();
    expect(tabsOf(html).map((t) => t.label)).toEqual(FIVE_TABS);
    expect(bellOf(html)).toBeUndefined();
    expect(whoOn(html)).toBe("Rosa · Empleado");
  });
});
