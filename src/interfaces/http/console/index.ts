/**
 * The staff console: server-rendered pages for a 360 px Android screen. Login lives in `auth.ts`,
 * the shared layout and tabs in `layout.ts`, and each screen in its own file, which registers its
 * routes below. Everything after `requireMember` has a session; every POST carries its CSRF value.
 */
import { Hono } from "hono";
import { anotarBodyLimit, anotarScreen } from "./anotar";
import { type ConsoleEnv, registerEntryRoutes, requireCsrf, requireMember, sameSiteForms } from "./auth";
import { bienvenidaScreen } from "./bienvenida";
import { empleadosScreen } from "./empleados";
import { masScreen } from "./mas";
import { pendientesScreen } from "./pendientes";
import { preparacionScreen } from "./preparacion";
import { tiendaScreen } from "./tienda";

export function consoleRoutes() {
  const app = new Hono<ConsoleEnv>();

  // Cross-site and oversized form posts are refused, the login form included. Anotar takes photos
  // and sets its own limit below.
  app.use("*", sameSiteForms(["/console/anotar"]));
  registerEntryRoutes(app);
  app.use("*", requireMember);
  // Before the CSRF check, which reads the whole body: Anotar's uploads have a size limit.
  app.use("/anotar", anotarBodyLimit);
  app.use("*", requireCsrf);

  app.get("/", (c) => c.redirect("/console/preparacion", 302));

  // One line per screen.
  bienvenidaScreen(app);
  preparacionScreen(app);
  empleadosScreen(app);
  anotarScreen(app);
  pendientesScreen(app);
  masScreen(app);
  tiendaScreen(app);

  return app;
}
