import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PendientesBoard, Tenant } from "../src/application/ports";
import { D1Pendientes } from "../src/infrastructure/d1/pendientes-repository";
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

/** The tab bar as a person reads it: each tab's label, whether it's lit, and its count, if any. */
const tabsOf = (page: string) =>
  [
    ...(/<nav class="tabs">([\s\S]*?)<\/nav>/.exec(page)?.[1] ?? "").matchAll(
      /<a href="([^"]+)"( aria-current="page")?>([^<]+)(?:<span class="badge">([^<]+)<\/span>)?<\/a>/g,
    ),
  ].map(([, href, current, label, badge]) => ({ href, label, current: current !== undefined, badge: badge ?? null }));

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
  it("shows the owner Pedidos, Anotar, Pendientes and Más, in that order, at the bottom", async () => {
    const { owner, page } = await sessions();
    const html = await (await page("/console/preparacion", owner)).text();
    expect(tabsOf(html).map((t) => t.label)).toEqual(["Pedidos", "Anotar", "Pendientes", "Más"]);
    // After the screen's content, so it sits at the bottom of a phone screen.
    expect(html.indexOf('<nav class="tabs">')).toBeGreaterThan(html.indexOf("</main>"));
  });

  it("shows staff everything but Pendientes", async () => {
    const { staff, page } = await sessions();
    const html = await (await page("/console/preparacion", staff)).text();
    expect(tabsOf(html).map((t) => t.label)).toEqual(["Pedidos", "Anotar", "Más"]);
  });

  it("lights the tab of the screen you're on, and Más on Empleados", async () => {
    const { owner, page } = await sessions();
    for (const [path, tab] of [
      ["/console/preparacion", "Pedidos"],
      ["/console/preparacion/demo-order-1", "Pedidos"],
      ["/console/anotar", "Anotar"],
      ["/console/pendientes", "Pendientes"],
      ["/console/mas", "Más"],
      ["/console/empleados", "Más"],
    ] as const) {
      const response = await page(path, owner);
      expect(response.status, path).toBe(200);
      expect(tabsOf(await response.text()).filter((t) => t.current).map((t) => t.label), path).toEqual([tab]);
    }
  });

  it("keeps Pendientes for the owner: staff get a refusal, not the page", async () => {
    const { staff, page } = await sessions();
    const response = await page("/console/pendientes", staff);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Esta parte es solo para el dueño.");
  });

  it("lists Más with Empleados and the pause for the owner only; unbuilt options say Pronto and aren't links", async () => {
    const { owner, staff, page } = await sessions();
    const forOwner = await (await page("/console/mas", owner)).text();
    expect(forOwner).toContain('<a href="/console/empleados">');
    expect(forOwner).toContain("Asistente en pausa");
    expect(forOwner).toContain('<a href="/privacidad">');
    expect(forOwner).toMatch(/<li class="soon"><span class="label">Pedido a mano<\/span>.*Pronto/);
    expect(forOwner).not.toMatch(/<a [^>]*>[^<]*<span class="label">Pedido a mano/);

    const forStaff = await (await page("/console/mas", staff)).text();
    expect(forStaff).not.toContain("/console/empleados");
    expect(forStaff).not.toContain("Asistente en pausa");
    expect(forStaff).toContain("Pedido a mano");
  });

  it("offers 'Probar como cliente' with the store's own number once a webhook has said it, to owner and staff", async () => {
    const { store, owner, staff, page } = await sessions();
    expect(await (await page("/console/mas", owner)).text()).not.toContain("Probar como cliente");

    await env.DB.prepare(`UPDATE channel_accounts SET display_phone_number = '15550317081' WHERE business_id = ?`).bind(store.businessId).run();
    const other = await storeWithStaff();
    await env.DB.prepare(`UPDATE channel_accounts SET display_phone_number = '50499998888' WHERE business_id = ?`).bind(other.businessId).run();
    for (const cookie of [owner, staff]) {
      const html = await (await page("/console/mas", cookie)).text();
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
      ["/console/anotar", "Anotar", "Ventas, fiado y pedidos a mano"],
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

describe("the Pendientes count on the tab", () => {
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
    const pendientesTab = async (path: string, cookie: string) =>
      tabsOf(await (await send(h, path, { cookie })).text()).find((tab) => tab.label === "Pendientes");

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
      return { h, response, tab: tabsOf(await response.text()).find((tab) => tab.label === "Pendientes") };
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
    expect(tabsOf(html).map((t) => t.label)).toContain("Pendientes");
    // Empleados lists this store's people: the seeded store is the one shown.
    expect(html).toContain(store.members[1]!.userId);
    await setName("memberships", "Johan", store.businessId, store.members[0]!.userId);
    expect(whoOn(await (await send(h, "/console/mas")).text())).toBe("Johan · Dueño");
  });

  it("falls back to a staff member of an empty demo store without the simulator's store", async () => {
    await storeWithStaff();
    const h = consoleHarness(devEnv("100000000000999"));
    const html = await (await send(h, "/console/preparacion")).text();
    expect(tabsOf(html).map((t) => t.label)).toEqual(["Pedidos", "Anotar", "Más"]);
    expect(whoOn(html)).toBe("Rosa · Empleado");
  });
});
