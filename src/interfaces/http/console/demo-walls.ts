/**
 * The console's limits for the public demo (D-64), after login. A demo store's owner is an anonymous
 * visitor, so the console refuses what would put their files or other people's data into production:
 * photo uploads (Anotar and Facturas) and staff invites (which store a phone number). The services
 * refuse the same for demo stores (receipts, staff, the console reader), so a path this wall misses
 * still stores nothing. And the demo's frame never shows a real store: a browser signed in to a real
 * store's console gets a notice there, and a real store's pages tell browsers no site may frame them.
 */
import type { Context, MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { DEMO_MAX_CONSOLE_READS_PER_STORE, isDemoBusiness } from "../../../domain/demo";
import type { ConsoleEnv } from "./auth";
import { simplePage } from "./layout";

/** A text-only Anotar post fits well under this; a photo never does. */
export const DEMO_ANOTAR_MAX_BYTES = 16 * 1024;
/** A real store's console pages: no site, this one included, may frame them. */
export const REAL_STORE_FRAME_POLICY = "frame-ancestors 'none'";

const COPY = {
  title: "No disponible en la demostración",
  uploads: "En la demostración no se suben fotos. Escribilo y te muestro lo que entendí.",
  staff: "En la demostración no se agregan empleados.",
  reads: "Esta tienda de demostración ya usó todas sus lecturas. Tocá «Empezar de nuevo» arriba para seguir probando.",
  realTitle: "Esta ventana tiene abierta una tienda real",
  real: "La demostración no muestra tiendas reales. Abrila en una ventana privada.",
};

function refused(text: string) {
  return simplePage(COPY.title, html`<p>${text}</p><p><a href="/console/inicio">Volver al inicio</a></p>`);
}

/** The demo's refusal page, for a screen that checks the demo itself as well (empleados.ts). */
export function demoRefusal(c: Context<ConsoleEnv>, what: "staff" | "uploads") {
  return c.html(refused(COPY[what]), 403);
}

/**
 * The path as the router matches it, inside the console: decoded (Hono routes `/console/%65mpleados`
 * as `/console/empleados`), lower case, without repeated or trailing slashes. Only for the checks
 * below; matching more than the router does can only refuse more.
 */
export function wallPath(decodedPath: string): string {
  const path = decodedPath
    .toLowerCase()
    .replace(/\/{2,}/gu, "/")
    .replace(/^\/console(?=\/|$)/u, "")
    .replace(/\/+$/u, "");
  return path === "" ? "/" : path;
}

/** Any uploaded file in a form, however small. An empty file field (no photo chosen) is not one. */
async function carriesFile(c: Context<ConsoleEnv>): Promise<boolean> {
  const form = await c.req.parseBody({ all: true });
  return Object.values(form).some((value) => (Array.isArray(value) ? value : [value]).some((part) => part instanceof File && part.size > 0));
}

export const demoWalls: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  const demo = isDemoBusiness(c.get("member").businessId);
  if (!demo) {
    // Browsers mark a page loaded in a frame; only the demo frames the console. The notice itself
    // must show in the demo's frame, so it keeps the site-wide policy.
    if (c.req.header("sec-fetch-dest") === "iframe") return c.html(simplePage(COPY.realTitle, html`<p>${COPY.real}</p>`), 409);
    await next();
    c.header("Content-Security-Policy", REAL_STORE_FRAME_POLICY);
    return;
  }
  const path = wallPath(c.req.path);
  if (path === "/empleados" || path.startsWith("/empleados/")) return demoRefusal(c, "staff");
  if (c.req.method === "POST" && (path === "/facturas/nueva" || path.startsWith("/facturas/nueva/"))) {
    return c.html(refused(COPY.uploads), 403);
  }
  if (c.req.method === "POST" && path === "/anotar") {
    const length = Number(c.req.header("content-length") ?? "NaN");
    if (!Number.isFinite(length) || length > DEMO_ANOTAR_MAX_BYTES) return c.html(refused(COPY.uploads), 413);
    // Small enough to read here; Hono keeps the parsed form for the screen.
    if (await carriesFile(c)) return c.html(refused(COPY.uploads), 403);
    // Every reading calls the model, paid from the demo's shared pool: each store gets a few.
    const { demoStores, deps } = c.get("runtime");
    const businessId = c.get("member").businessId;
    if (!(await demoStores.takeConsoleRead(businessId, DEMO_MAX_CONSOLE_READS_PER_STORE, deps.clock.now()))) {
      deps.log.info("demo_console_read_limited", { businessId, reason: "reads" });
      return c.html(refused(COPY.reads), 429);
    }
  }
  return next();
};
