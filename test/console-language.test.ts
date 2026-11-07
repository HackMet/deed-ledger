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

/** Every form field and button value on a page: what the server reads back, which English must not change (placeholder, aria-label and title are labels, translated on purpose). */
const fieldsOf = (page: string) => [...page.matchAll(/<(?:input|button|select|textarea|option)\b[^>]*>/g)].map(([tag]) => tag.replace(/ (?:placeholder|aria-label|title)="[^"]*"/g, ""));

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

  it("translates only the console's own words in text and read-aloud attributes, never values, scripts, styles or names", () => {
    const page =
      '<html lang="es"><head><style>.x::after{content:"Pedidos"}</style><script>const a = "Listo";</script></head>' +
      '<body><a href="/console/preparacion" title="Pedidos">Pedidos</a><button name="accion" value="Listo">Listo</button>' +
      "<p>Arroz 1 lb</p><p>4 productos · Recoge en tienda</p><p>miércoles, 28 de octubre</p></body></html>";
    const english = toEnglish(page);
    expect(english).toContain('<html lang="en">');
    expect(english).toContain('content:"Pedidos"');
    expect(english).toContain('const a = "Listo";');
    expect(english).toContain('<a href="/console/preparacion" title="Orders">Orders</a>');
    expect(english).toContain('<button name="accion" value="Listo">Ready</button>');
    expect(english).toContain("<p>Arroz 1 lb</p>");
    expect(english).toContain("<p>4 products · Store pickup</p>");
    expect(english).toContain("<p>Wednesday, October 28</p>");
  });
});

describe("console English: attributes, clock times and the Deed, Libro, Pendientes and store words", () => {
  const en = (text: string) => toEnglish(`<p>${text}</p>`).slice(3, -4);

  it("translates placeholders, screen-reader labels and tooltips, escaping what it writes", () => {
    const page = toEnglish('<input name="x" placeholder="Mercadito, farmacia…" aria-label="Lunes: abre" value="Lunes"><a title="Ver libro" href="/a">x</a>');
    expect(page).toBe('<input name="x" placeholder="Corner store, pharmacy…" aria-label="Monday: opens" value="Lunes"><a title="See the ledger" href="/a">x</a>');
    expect(toEnglish('<input aria-label="Ese nombre no lo conozco">')).toBe('<input aria-label="Ese nombre no lo conozco">');
  });

  it("says the store's clock the English way", () => {
    expect(en("Cambió · 8:05 p. m.")).toBe("Changed · 8:05 p.m.");
    expect(en("ayer 7:30 a. m.")).toBe("yesterday 7:30 a.m.");
    expect(en("Abrimos de lunes a sábado de 6 a. m. a 8 p. m., y el domingo de 7 a. m. a 12 del mediodía.")).toBe(
      "We're open Monday to Saturday from 6 a.m. to 8 p.m., and Sunday from 7 a.m. to 12 noon.",
    );
  });

  it("translates a phrase part by part, keeps a separator at either end, and never lets one pattern swallow the parts", () => {
    expect(en("Pedido v1 · Cerrado")).toBe("Order v1 · Closed");
    expect(en("· Dueño")).toBe("· Owner");
    expect(en("Good afternoon")).toBe("Good afternoon");
    expect(en("Buenas tardes, Dueño.")).toBe("Good afternoon, Owner.");
    expect(en("Buenos días, Rosa.")).toBe("Good morning, Rosa.");
  });

  it("covers the Deed and Libro words, singular counts and one word for confirmed claims", () => {
    expect(en("1 afirmación · 1 confirmada · 0 sin respaldo · 1 intento rechazado")).toBe("1 claim · 1 confirmed · 0 unbacked · 1 attempt refused");
    expect(en("Afirmaciones verificadas 4, confirmadas 3")).toBe("Claims checked 4, confirmed 3");
    expect(en("EN VIVO")).toBe("LIVE");
    expect(en("Dijo: armando o por confirmar")).toBe("Said: building or to confirm");
    expect(en("Dijo listo, el libro no lo tiene")).toBe("Said ready, the ledger doesn't have it");
    expect(en("dijo L 0.01 · registró L 40")).toBe("said L 0.01 · recorded L 40");
    expect(en("Bloqueado: no tiene permiso")).toBe("Blocked: not allowed");
    expect(en("versión vieja: 2")).toBe("old version: 2");
    expect(en("Libro #ZTPSQ")).toBe("Ledger #ZTPSQ");
    expect(en("Intentó registrar un mensaje del cliente")).toBe("Tried to record a customer message");
    expect(en("Este pedido no tiene hechos todavía.")).toBe("This order has no facts yet.");
  });

  it("covers Pendientes, products and the store's notices", () => {
    expect(en("Resuelto")).toBe("Done");
    expect(en("Su número termina en 4321")).toBe("Their number ends in 4321");
    expect(en("Preguntó 3 precios que no están confirmados. Le dijimos que le confirmamos.")).toBe(
      "Asked about 3 prices that aren't confirmed. We told them we'd confirm.",
    );
    expect(en("El pedido #5CQK4 tiene un cambio")).toBe("Order #5CQK4 has a change");
    expect(en("3 líneas · Por revisar")).toBe("3 lines · To review");
    expect(en("Precio anotado antes: L 18. Confirmalo para que el asistente lo use.")).toBe("Price noted before: L 18. Confirm it so the assistant uses it.");
    expect(en("¿Se acabó?")).toBe("Sold out?");
    expect(en("35 productos. Ahí agregás, cambiás precios, marcás No hay y editás cada uno. Es la misma lista que usa el asistente.")).toBe(
      "35 products. There you add them, change prices, mark them out of stock and edit each one. It's the same list the assistant uses.",
    );
    expect(en("La respuesta es muy larga: máximo 500 caracteres.")).toBe("The reply is too long: at most 500 characters.");
    expect(en("Envío: L 20. Es lo que el asistente les dice a los clientes.")).toBe("Delivery: L 20. It's what the assistant tells customers.");
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
