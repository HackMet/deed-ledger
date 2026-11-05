import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { toEnglish } from "../src/interfaces/http/console/language";
import { login, send, storeWithStaff } from "./helpers/console";
import { type Harness, harness, testEnv } from "./helpers/harness";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/** A GET as a browser sends it after a click: with the page it came from as Referer. */
async function fromPage(h: Harness, path: string, referer?: string) {
  const request = new IncomingRequest(`https://worker.test${path}`, {
    headers: referer === undefined ? {} : { referer },
    redirect: "manual",
  });
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(request, h.env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function owner(options: { consoleLang?: string } = {}) {
  const h = harness(
    options.consoleLang === undefined ? {} : { env: testEnv({ CONSOLE_LANG: options.consoleLang } as unknown as Partial<Env>) },
  );
  const store = await storeWithStaff();
  const cookie = await login(h, store.businessId, store.members[0]!.userId);
  const page = async (path: string, extraCookie = "") =>
    send(h, path, { cookie: extraCookie === "" ? cookie : `${cookie}; ${extraCookie}` });
  return { h, page };
}

/** Every form field and button value on a page: what the server reads back, which English must not change. */
const fieldsOf = (page: string) => [...page.matchAll(/<(?:input|button|select|textarea|option)\b[^>]*>/g)].map(([tag]) => tag);

describe("console language (ES | EN)", () => {
  it("is Spanish when nothing is chosen and CONSOLE_LANG is empty, with the switch on the page", async () => {
    const { page } = await owner();
    const html = await (await page("/console/inicio")).text();
    expect(html).toContain("Inicio");
    expect(html).toContain("Esto es lo que necesita tu tienda hoy.");
    expect(html).toContain('href="/console/idioma/en"');
    expect(html).not.toContain("Today's orders");
  });

  it("shows English with the visitor's choice, and leaves every form field and button value as it was", async () => {
    const { page } = await owner();
    for (const path of ["/console/inicio", "/console/preparacion", "/console/anotar", "/console/productos", "/console/mas"]) {
      const spanish = await (await page(path)).text();
      const english = await (await page(path, "consola_idioma=en")).text();
      expect(english).toContain('<html lang="en"');
      expect(fieldsOf(english)).toEqual(fieldsOf(spanish));
    }
    const inicio = await (await page("/console/inicio", "consola_idioma=en")).text();
    expect(inicio).toContain(">Orders<");
    expect(inicio).toContain("Here's what your store needs today.");
    const productos = await (await page("/console/productos", "consola_idioma=en")).text();
    expect(productos).toContain("Add product");
  });

  it("makes English the default when CONSOLE_LANG is en, and a visitor's ES choice still wins", async () => {
    const { page } = await owner({ consoleLang: "en" });
    expect(await (await page("/console/inicio")).text()).toContain("Here's what your store needs today.");
    expect(await (await page("/console/inicio", "consola_idioma=es")).text()).toContain("Esto es lo que necesita tu tienda hoy.");
  });

  it("the switch saves the choice for the console and goes back only to a console page", async () => {
    const { h } = await owner();
    const saved = await fromPage(h, "/console/idioma/en", "https://worker.test/console/productos");
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/console/productos");
    expect(saved.headers.get("set-cookie")).toContain("consola_idioma=en; Path=/console");
    for (const away of ["https://evil.test/console/inicio", "https://worker.test/elsewhere", undefined]) {
      const response = await fromPage(h, "/console/idioma/es", away);
      expect(response.headers.get("location")).toBe("/console/inicio");
    }
    const unknown = await fromPage(h, "/console/idioma/fr", "https://worker.test/console/mas");
    expect(unknown.headers.get("set-cookie")).toBeNull();
  });

  it("also switches the login page", async () => {
    const { h } = await owner({ consoleLang: "en" });
    const html = await (await send(h, "/console/entrar")).text();
    expect(html).toContain("/console/idioma/es");
  });

  it("translates only the console's own words in text, never tags, attributes, scripts, styles or names", () => {
    const page =
      '<html lang="es"><head><style>.x::after{content:"Pedidos"}</style><script>const a = "Listo";</script></head>' +
      '<body><a href="/console/preparacion" title="Pedidos">Pedidos</a><button name="accion" value="Listo">Listo</button>' +
      "<p>Arroz 1 lb</p><p>4 productos · Recoge en tienda</p><p>miércoles, 28 de octubre</p></body></html>";
    const english = toEnglish(page);
    expect(english).toContain('<html lang="en">');
    expect(english).toContain('content:"Pedidos"');
    expect(english).toContain('const a = "Listo";');
    expect(english).toContain('<a href="/console/preparacion" title="Pedidos">Orders</a>');
    expect(english).toContain('<button name="accion" value="Listo">Ready</button>');
    expect(english).toContain("<p>Arroz 1 lb</p>");
    expect(english).toContain("<p>4 products · Store pickup</p>");
    expect(english).toContain("<p>Wednesday, October 28</p>");
  });
});

describe("the bare address", () => {
  it("sends / to the public demo instead of Not found", async () => {
    const h = harness();
    const response = await send(h, "/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/demo");
  });
});
