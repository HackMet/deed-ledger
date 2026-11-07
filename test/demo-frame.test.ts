/**
 * The public demo's frame (demo-pages.ts) and what a demo store's console offers: one language per
 * page, honest limit pages, a phone that never cuts or rewrites what the visitor typed, and no upload
 * forms a demo store would refuse.
 */
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_MAX_TEXT, DEMO_PRESETS, type DemoLimit } from "../src/domain/demo";
import { demoLandingPage, demoLimitedPage } from "../src/interfaces/http/demo-pages";
import { type Harness, harness, rows } from "./helpers/harness";
import { hashToken } from "../src/infrastructure/tokens";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const ORIGIN = "https://worker.test";

async function call(h: Harness, path: string, init: { method?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}` };
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  const ctx = createExecutionContext();
  const response = await h.worker.fetch(new IncomingRequest(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, redirect: "manual" }), h.env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function openDemo(h: Harness) {
  const response = await call(h, "/demo/empezar", { method: "POST" });
  expect(response.status).toBe(303);
  const cookies = response.headers.getSetCookie().map((c) => c.split(";")[0]!);
  const token = cookies.find((c) => c.startsWith("demo_sesion="))!.split("=")[1]!;
  const [store] = await rows<{ business_id: string }>(`SELECT business_id FROM console_sessions WHERE token_hash = ?`, await hashToken(token));
  return { cookie: cookies.join("; "), businessId: store!.business_id };
}

const text = async (response: Response) => response.text();

describe("the demo's pages, in one language", () => {
  it("serves the store page in Spanish or English, the Start over button included", async () => {
    const h = harness();
    const { cookie } = await openDemo(h);
    const es = await text(await call(h, "/demo/tienda", { cookie: `${cookie}; consola_idioma=es` }));
    expect(es).toContain('<html lang="es">');
    expect(es).toContain("<title>Tu tienda de demostración</title>");
    expect(es).toContain('data-es="Empezar de nuevo" data-en="Start over">Empezar de nuevo<');
    expect(es).toContain('title="Abre una tienda de demostración nueva"');
    expect(es).toContain('title="Teléfono del cliente"');
    expect(es).not.toContain("empty chat and no orders");

    const en = await text(await call(h, "/demo/tienda", { cookie: `${cookie}; consola_idioma=en` }));
    expect(en).toContain('<html lang="en">');
    expect(en).toContain(">Start over<");
    expect(en).toContain('title="Opens a fresh demo store"');
    expect(en).toContain('title="Store console"');
    // On a narrow screen the header points at the tabs, not at a left and a right.
    expect(en).toContain("Switch between customer and store with the tabs.");
  });

  it("serves the phone in the chosen language, with nothing typed ever cut", async () => {
    const h = harness();
    const { cookie } = await openDemo(h);
    const es = await text(await call(h, "/demo/telefono", { cookie: `${cookie}; consola_idioma=es` }));
    expect(es).toContain('<html lang="es">');
    expect(es).toContain('aria-label="Mensaje"');
    expect(es).not.toContain("maxlength");
    expect(es).toContain(`data-max="${DEMO_MAX_TEXT}"`);
    const presets = JSON.parse(/id="preset-texts">([^<]*)</.exec(es)![1]!);
    expect(presets).toEqual([DEMO_PRESETS.texto.body]);
    const en = await text(await call(h, "/demo/telefono", { cookie: `${cookie}; consola_idioma=en` }));
    expect(en).toContain('<html lang="en">');
    expect(en).toContain("<title>Customer phone</title>");
  });

  it("ships a phone script that sends a client message ID, keeps typed text as typed and retires old buttons", async () => {
    const h = harness();
    const { cookie } = await openDemo(h);
    const page = await text(await call(h, "/demo/telefono", { cookie }));
    const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)[0]!;
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("clientMessageId: pending.id");
    expect(script).toContain('line.kind === "text" && PRESET_TEXTS.indexOf(line.body) >= 0');
    expect(script).toContain("retireOldButtons");
    expect(script).toContain("Start over");
  });

  it("shows the landing page as a showcase: the promise, the recording, three steps and one button", () => {
    const fresh = String(demoLandingPage(false));
    expect(fresh).toContain("AI that can't lie about what it did.");
    expect(fresh).toContain('<img class="tour" src="/demo/recorrido.gif"');
    expect(fresh.match(/<li><h2>/g)).toHaveLength(3);
    expect(fresh).toContain('<form method="post" action="/demo/empezar"');
    expect(fresh).toContain(">Try it</button>");
    expect(fresh).not.toContain("Back to my demo store");
    expect(fresh.replace(/\s+/g, " ")).toContain("the ES | EN switch shows the whole demo in either language");
    const returning = String(demoLandingPage(true));
    expect(returning).toContain('<a class="btn" href="/demo/tienda">Back to my demo store</a>');
    expect(returning).toContain(">Start a fresh store</button>");
  });

  it("tells a visitor the demo is full, not busy, when every demo store is in use", () => {
    const full = String(demoLimitedPage("full" as Exclude<DemoLimit, null>, false));
    expect(full).toContain("<title>Demo full</title>");
    expect(full).toContain("Every demo store is in use right now");
    expect(full).not.toContain("a few minutes");
    const busy = String(demoLimitedPage("everyone", true));
    expect(busy).toContain("a few minutes");
    expect(busy).toContain('href="/demo/tienda"');
    expect(String(demoLimitedPage("visitor", false))).toContain("several demo stores");
  });
});

describe("a demo store's console offers no uploads it would refuse", () => {
  it("Anotar has no photo field, and its invoice choice opens the list", async () => {
    const h = harness();
    const { cookie } = await openDemo(h);
    const page = await text(await call(h, "/console/anotar", { cookie }));
    expect(page).not.toContain('name="foto"');
    expect(page).toContain("En la demostración no se suben fotos.");
    expect(page).toContain("Escribí lo que pasó. Te muestro lo que entendí.");
    expect(page).toContain('class="choice" href="/console/facturas"');
    const en = await text(await call(h, "/console/anotar", { cookie: `${cookie}; consola_idioma=en` }));
    expect(en).toContain("Photos are off in the demo.");
  });

  it("Facturas lists the invoices without an upload button, and the upload page explains why", async () => {
    const h = harness();
    const { cookie } = await openDemo(h);
    const list = await text(await call(h, "/console/facturas", { cookie }));
    expect(list).not.toContain('href="/console/facturas/nueva"');
    expect(list).toContain("En la demostración no se suben fotos de facturas.");
    const upload = await text(await call(h, "/console/facturas/nueva", { cookie }));
    expect(upload).not.toContain('type="file"');
    expect(upload).toContain("En la demostración no se suben fotos de facturas.");
  });
});
