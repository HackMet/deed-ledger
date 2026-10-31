/**
 * First login: tells the member that voice notes are kept as the store's records. Login sends a
 * member here until they tap "Entendido" once; after that it goes straight to the list.
 */
import type { Hono } from "hono";
import { html } from "hono/html";
import { type ConsoleEnv, memberContext } from "./auth";
import { csrfField, shell } from "./layout";

const PATH = "/console/bienvenida";

export function bienvenidaScreen(app: Hono<ConsoleEnv>) {
  app.get("/bienvenida", (c) =>
    c.html(
      shell(c, {
        title: "Antes de empezar",
        path: PATH,
        body: html`<section class="card">
<p>Las notas de voz que le mandés al WhatsApp de la tienda se guardan como registro de la tienda.</p>
<p>Usalas solo para cosas de la tienda.</p>
<form method="post" action="${PATH}">${csrfField(c.get("csrf"))}<button class="primary">Entendido</button></form>
</section>`,
      }),
    ),
  );

  app.post("/bienvenida", async (c) => {
    const member = memberContext(c);
    await c.get("runtime").deps.consoleAuth.markVoiceNoticeSeen(member, member.memberId, member.nowMs);
    return c.redirect("/console/preparacion", 303);
  });
}
