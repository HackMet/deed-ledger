/**
 * The staff console: server-rendered pages for a 360 px Android screen. Login lives in `auth.ts`,
 * the shared layout and tabs in `layout.ts`, and each screen in its own file, which registers its
 * routes below. Everything after `requireMember` has a session; every POST carries its CSRF value.
 */
import { Hono } from "hono";
import { anotarBodyLimit, anotarScreen } from "./anotar";
import {
  type ConsoleEnv,
  INVOICE_UPLOAD_PATH,
  invoiceUploadLimit,
  registerEntryRoutes,
  requireCsrf,
  requireMember,
  sameSiteForms,
} from "./auth";
import { bienvenidaScreen } from "./bienvenida";
import { demoWalls } from "./demo-walls";
import { deedScreen } from "./deed";
import { libroScreen } from "./libro";
import { consoleLanguage, languageRoute } from "./language";
import { empleadosScreen } from "./empleados";
import { facturasScreen } from "./facturas";
import { inicioScreen } from "./inicio";
import { masScreen } from "./mas";
import { negocioScreen } from "./negocio";
import { pedidosScreen } from "./pedidos";
import { pendientesScreen } from "./pendientes";
import { preparacionScreen } from "./preparacion";
import { productosScreen } from "./productos";
import { tiendaScreen } from "./tienda";

export function consoleRoutes() {
  const app = new Hono<ConsoleEnv>();

  // Every console page in the visitor's language (ES | EN), the login page included.
  app.use("*", consoleLanguage);
  // Cross-site and oversized form posts are refused, the login form included. Anotar and the
  // invoice upload take photos and set their own limits below.
  app.use("*", sameSiteForms(["/console/anotar", INVOICE_UPLOAD_PATH]));
  app.get("/idioma/:lang", languageRoute);
  registerEntryRoutes(app);
  app.use("*", requireMember);
  // The public demo's limits, before any upload is read (D-64).
  app.use("*", demoWalls);
  // Before the CSRF check, which reads the whole body: uploads have a size limit.
  app.use("/anotar", anotarBodyLimit);
  app.use("/facturas/nueva", invoiceUploadLimit);
  app.use("*", requireCsrf);

  app.get("/", (c) => c.redirect("/console/inicio", 302));

  // One line per screen.
  bienvenidaScreen(app);
  inicioScreen(app);
  preparacionScreen(app);
  empleadosScreen(app);
  anotarScreen(app);
  pedidosScreen(app);
  pendientesScreen(app);
  masScreen(app);
  tiendaScreen(app);
  productosScreen(app);
  negocioScreen(app);
  facturasScreen(app);
  deedScreen(app);
  libroScreen(app);

  return app;
}
