/**
 * The console's limits for the public demo (D-64), after login. A demo store's owner is an anonymous
 * visitor, so the console refuses what would put their files or other people's data into production:
 * photo uploads (Anotar and Facturas) and staff invites (which store a phone number). And the demo's
 * frame never shows a real store: a browser signed in to a real store's console gets a notice there.
 */
import type { MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { isDemoBusiness } from "../../../domain/demo";
import type { ConsoleEnv } from "./auth";
import { simplePage } from "./layout";

/** A text-only Anotar post fits well under this; a photo never does. */
export const DEMO_ANOTAR_MAX_BYTES = 16 * 1024;

const COPY = {
  title: "No disponible en la demostración",
  uploads: "En la demostración no se suben fotos. Escribilo y te muestro lo que entendí.",
  staff: "En la demostración no se agregan empleados.",
  realTitle: "Esta ventana tiene abierta una tienda real",
  real: "La demostración no muestra tiendas reales. Abrila en una ventana privada.",
};

function refused(text: string) {
  return simplePage(COPY.title, html`<p>${text}</p><p><a href="/console/inicio">Volver al inicio</a></p>`);
}

export const demoWalls: MiddlewareHandler<ConsoleEnv> = async (c, next) => {
  const demo = isDemoBusiness(c.get("member").businessId);
  // Browsers mark a page loaded in a frame; only the demo frames the console.
  if (!demo && c.req.header("sec-fetch-dest") === "iframe") {
    return c.html(simplePage(COPY.realTitle, html`<p>${COPY.real}</p>`), 409);
  }
  if (!demo) return next();
  const path = new URL(c.req.url).pathname.replace(/^\/console/u, "");
  if (path === "/empleados" || path.startsWith("/empleados/")) return c.html(refused(COPY.staff), 403);
  if (c.req.method === "POST" && path === "/facturas/nueva") return c.html(refused(COPY.uploads), 403);
  if (c.req.method === "POST" && path === "/anotar") {
    const length = Number(c.req.header("content-length") ?? "NaN");
    if (!Number.isFinite(length) || length > DEMO_ANOTAR_MAX_BYTES) return c.html(refused(COPY.uploads), 413);
  }
  return next();
};
