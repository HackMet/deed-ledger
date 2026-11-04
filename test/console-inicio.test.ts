import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PendientesBoard } from "../src/application/ports";
import { D1Pendientes } from "../src/infrastructure/d1/pendientes-repository";
import { demoOrders } from "../src/infrastructure/memory/demo-orders";
import { MemoryEngine } from "../src/infrastructure/memory/memory-engine";
import { consoleLogger, randomIds, systemClock } from "../src/infrastructure/runtime";
import { greeting, storeDate } from "../src/interfaces/http/console/inicio";
import { login, send, storeWithStaff } from "./helpers/console";
import { FakeClock } from "./helpers/fakes";
import { harness, testEnv } from "./helpers/harness";

/** Wednesday Oct 28, 2026, 8:00 a.m. in Honduras (the harness clock's default). */
const NOW = Date.UTC(2026, 9, 28, 14, 0, 0);

/** The stat cards as a person reads them: label and number. */
const statsOf = (page: string) =>
  Object.fromEntries(
    [...page.matchAll(/<a class="stat[^"]*" href="[^"]+"><span class="label">([^<]+)<\/span><strong>([^<]+)<\/strong>/g)].map(([, label, value]) => [label, value]),
  );

const handoff = (inboundId: string) =>
  ({ kind: "customer_handoff", conversationId: null as unknown as string, customerId: "c", inboundId }) as const;

async function sessions(options: { env?: Env; pendientesBoard?: PendientesBoard; engine?: boolean } = {}) {
  const clock = new FakeClock(NOW);
  const h = harness({
    clock,
    ...(options.engine === false ? {} : { engine: new MemoryEngine(() => demoOrders(NOW)) }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.pendientesBoard === undefined ? {} : { pendientesBoard: options.pendientesBoard }),
  });
  const store = await storeWithStaff();
  const owner = await login(h, store.businessId, store.members[0]!.userId);
  const staff = await login(h, store.businessId, store.members[1]!.userId);
  const page = async (path: string, cookie: string) => send(h, path, { cookie });
  return { h, store, owner, staff, page };
}

describe("Inicio", () => {
  it("greets by the store's clock and date", () => {
    expect(storeDate(NOW)).toBe("miércoles, 28 de octubre");
    expect(greeting(NOW, "Johan Rodas")).toBe("Buen día, Johan.");
    expect(greeting(NOW, null)).toBe("Buen día.");
    expect(greeting(NOW + 6 * 3_600_000, "Rosa")).toBe("Buenas tardes, Rosa.");
    expect(greeting(NOW + 12 * 3_600_000, "Rosa")).toBe("Buenas noches, Rosa.");
  });

  it("counts what Pedidos lists: to pack and ready, linked to Pedidos, and today's orders with their pages", async () => {
    const { owner, page } = await sessions();
    const response = await page("/console/inicio", owner);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<p class="kicker">miércoles, 28 de octubre</p>');
    expect(html).toContain("<h1>Buen día.</h1>");

    const list = await (await page("/console/preparacion", owner)).text();
    const toPack = (list.match(/<a class="card order" /g) ?? []).length;
    const ready = (list.match(/<a class="card order packed" /g) ?? []).length;
    expect(toPack).toBeGreaterThan(0);
    expect(statsOf(html)).toMatchObject({ "Por atender": String(toPack), "Para entregar": String(ready) });
    expect(html).toContain('<a class="stat dark" href="/console/preparacion">');

    expect(html).toContain("Los pedidos de hoy");
    for (const [, href] of list.matchAll(/<a class="card order[^"]*" id="[^"]*" href="([^"]+)">/g)) {
      expect(html).toContain(`<a class="order-row" href="${href}">`);
    }
    // Read only: no forms on Inicio.
    expect(html).not.toContain("<form");
  });

  it("shows the owner the open Pendientes, and staff neither the card nor the bell", async () => {
    const store = await storeWithStaff();
    const stored = new D1Pendientes(env.DB, randomIds, systemClock, consoleLogger);
    for (const inboundId of ["in-1", "in-2"]) await stored.raise(store, handoff(inboundId));
    const h = harness({ clock: new FakeClock(NOW), engine: new MemoryEngine(() => demoOrders(NOW)) });
    const owner = await login(h, store.businessId, store.members[0]!.userId);
    const staff = await login(h, store.businessId, store.members[1]!.userId);

    const forOwner = await (await send(h, "/console/inicio", { cookie: owner })).text();
    expect(statsOf(forOwner)["Por resolver"]).toBe("2");
    expect(forOwner).toContain('href="/console/pendientes"><span class="label">Por resolver</span>');

    const staffResponse = await send(h, "/console/inicio", { cookie: staff });
    expect(staffResponse.status).toBe(200);
    const forStaff = await staffResponse.text();
    expect(Object.keys(statsOf(forStaff))).toEqual(["Por atender", "Para entregar"]);
    expect(forStaff).not.toContain("Por resolver");
    expect(forStaff).not.toContain('class="bell"');
  });

  it("leaves a number out when it can't be read, never 0", async () => {
    const failing: PendientesBoard = {
      listOpen: async () => [],
      markDone: async () => false,
      countOpen: async () => {
        throw new Error("D1 down");
      },
    };
    const { owner, page } = await sessions({ pendientesBoard: failing });
    const html = await (await page("/console/inicio", owner)).text();
    expect(statsOf(html)).not.toHaveProperty("Por resolver");

    // No engine wired in: no order counts at all, and the list says why.
    const none = await sessions({ engine: false });
    const response = await none.page("/console/inicio", none.owner);
    expect(response.status).toBe(200);
    const empty = await response.text();
    expect(statsOf(empty)).not.toHaveProperty("Por atender");
    expect(statsOf(empty)).not.toHaveProperty("Para entregar");
    expect(empty).toContain("La lista de pedidos no está lista todavía.");
  });

  for (const [label, vars] of [
    ["the real engine (DEED_ENGINE=1)", { DEED_ENGINE: "1" }],
    ["the pretend engine (DEED_ENGINE=0, PRETEND_ENGINE=1)", { DEED_ENGINE: "0", PRETEND_ENGINE: "1" }],
  ] as const) {
    it(`works on ${label}: a new store has nothing to pack yet`, async () => {
      const { owner, staff, page } = await sessions({ engine: false, env: testEnv(vars as unknown as Partial<Env>) });
      for (const cookie of [owner, staff]) {
        const response = await page("/console/inicio", cookie);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(statsOf(html)).toMatchObject({ "Por atender": "0", "Para entregar": "0" });
        expect(html).toContain("Hoy todavía no hay pedidos.");
      }
    });
  }

  it("is where /console lands", async () => {
    const { owner, page } = await sessions();
    const response = await page("/console", owner);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/console/inicio");
  });
});
