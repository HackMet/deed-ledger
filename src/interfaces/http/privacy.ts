/**
 * The public privacy notice the first message links to. One page for every store, with no store
 * data, no login and nothing read from the request. Spanish, short and factual: it says only what
 * the code does today.
 *
 * QUESTIONS FOR ANGEL (left out on purpose rather than invented; see the #30 handoff):
 * - Who is legally responsible for the data (the store, us, both), and a contact for privacy requests.
 * - How long messages, photos and voice notes are kept when nobody asks to delete them.
 * - Whether to cite Honduran law (habeas data) or Meta's terms, and in what words.
 * - Whether to promise that data is never sold or used for anything else.
 */
import { Hono } from "hono";
import { html } from "hono/html";

export function privacyRoutes() {
  const app = new Hono();
  app.get("/", (c) => {
    c.header("cache-control", "public, max-age=3600");
    return c.html(PAGE);
  });
  return app;
}

const PAGE = html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cómo usamos tus datos</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 0 auto; padding: 1rem; line-height: 1.5; color: #222; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<h1>Cómo usamos tus datos</h1>

<h2>Quién te atiende</h2>
<p>La tienda usa un asistente automático para tomar pedidos por WhatsApp. Es un programa, no una persona.</p>

<h2>Qué guardamos</h2>
<p>Tu número de WhatsApp, el nombre que nos des, tus mensajes, fotos y notas de voz, y tus pedidos, pagos y fiados con la tienda.</p>

<h2>Para qué</h2>
<p>Para entender tus pedidos, prepararlos, avisarte cómo van y llevar las cuentas de la tienda.</p>

<h2>Quién más los procesa</h2>
<p>Meta, porque los mensajes llegan por WhatsApp y los lee un modelo de inteligencia artificial de Meta. Cloudflare, donde se guardan.</p>

<h2>Dejar de recibir mensajes</h2>
<p>Escribí <strong>ALTO</strong> y el asistente deja de escribirte. Para volver, escribí <strong>SEGUIR</strong>.</p>

<h2>Hablar con una persona</h2>
<p>Escribí <strong>quiero hablar con</strong> y el nombre del dueño, o <strong>quiero hablar con una persona</strong>. Le avisamos a la tienda.</p>

<h2>Borrar tus datos</h2>
<p>Escribí <strong>borren mis datos</strong>. Borramos tu número, tu nombre, tus mensajes, fotos y notas de voz de esa tienda.
Los montos de tus compras y fiados quedan en las cuentas de la tienda, sin tu nombre ni tu número.</p>
</body>
</html>`;
