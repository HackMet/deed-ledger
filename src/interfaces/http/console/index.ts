/**
 * The staff console: server-rendered pages for a 360 px Android screen. Login lives in `auth.ts`,
 * the shared layout and tabs in `layout.ts`, and each screen in its own file, which registers its
 * routes below. Everything after `requireMember` has a session; every POST carries its CSRF value.
 */
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { anotarBodyLimit, anotarScreen } from "./anotar";
import { type ConsoleEnv, registerEntryRoutes, requireCsrf, requireMember } from "./auth";
import { bienvenidaScreen } from "./bienvenida";
import { empleadosScreen } from "./empleados";
import { preparacionScreen } from "./preparacion";

export function consoleRoutes() {
  const app = new Hono<ConsoleEnv>();

  // Form posts from another site are refused, the login form included (its invite would otherwise
  // let a stranger swap the victim's session for one in their store).
  app.use("*", csrf());
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

  return app;
}
