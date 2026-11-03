/**
 * The Products screen (K6): every product with its current confirmed price, or "sin precio". The owner
 * adds a product and confirms prices; staff propose one for the owner to confirm. A change goes to the
 * engine (`CatalogService.changePrice`); adding a product is the owner's small service. Prices are typed
 * in lempiras and converted to centavos by `parseLempiras`, never through a float.
 */
import { type Hono } from "hono";
import { html } from "hono/html";
import type { CatalogRow } from "../../../application/catalog";
import { formatLempiras } from "../../../domain/contract/numbers";
import type { EngineOutcome } from "../../../domain/contract/outcomes";
import { PRICE_FORMAT_HELP, parseLempiras } from "../../../domain/price";
import { type ConsoleEnv, memberContext, requireOwner } from "./auth";

const NOTICES = {
  agregado: "Producto agregado con su precio.",
  confirmado: "Precio confirmado.",
  propuesto: "Precio propuesto. El dueño lo confirma.",
  formato: PRICE_FORMAT_HELP,
  nombre: "Escribí el nombre del producto (hasta 120 letras).",
  repetido: "Ya hay un producto con ese nombre.",
  yaguardado: "Ese precio ya se guardó hace un momento. Esperá un minuto para cambiarlo otra vez.",
  falta: "Ese producto no está en la lista.",
  permiso: "Eso lo confirma el dueño.",
  estado: "El precio cambió mientras tanto. La lista ya está al día.",
  listo: "La lista de productos no está lista todavía.",
} as const;
type Notice = keyof typeof NOTICES;

/** 1250 -> "12.50": the text a price input is filled with. */
const centavosText = (centavos: number): string => `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, "0")}`;

function noticeFor(outcome: EngineOutcome, confirming: boolean): Notice {
  const answered = outcome.type === "duplicate" ? outcome.first : outcome;
  if (outcome.type === "duplicate") return "yaguardado";
  if (answered.type === "rejected") {
    switch (answered.reason) {
      case "not_found":
        return "falta";
      case "not_allowed":
        return "permiso";
      default:
        return "estado";
    }
  }
  return confirming ? "confirmado" : "propuesto";
}

export function productosScreen(app: Hono<ConsoleEnv>) {
  const back = (c: { redirect: (url: string, status: 303) => Response }, notice: Notice) => c.redirect(`/console/productos?aviso=${notice}`, 303);

  app.get("/productos", async (c) => {
    const member = c.get("member");
    const rows = await c.get("runtime").catalog.list(member);
    const notice = c.req.query("aviso");
    return c.html(
      page(notice !== undefined && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as Notice] : null, rows, member.role === "owner", c.get("csrf")),
    );
  });

  app.post("/productos", requireOwner, async (c) => {
    const form = await c.req.parseBody();
    const name = typeof form["nombre"] === "string" ? form["nombre"] : "";
    const price = parseLempiras(typeof form["precio"] === "string" ? form["precio"] : "");
    if (price === null) return back(c, "formato");
    const result = await c.get("runtime").catalog.addProduct(memberContext(c), { name, price });
    if (result.type === "added") return back(c, "agregado");
    return back(c, result.reason === "name_taken" ? "repetido" : result.reason === "name" ? "nombre" : result.reason === "price" ? "formato" : "permiso");
  });

  app.post("/productos/:productId/precio", async (c) => {
    const productId = c.req.param("productId");
    if (productId.length > 64) return c.text("Bad request", 400);
    const form = await c.req.parseBody();
    const price = parseLempiras(typeof form["precio"] === "string" ? form["precio"] : "");
    if (price === null) return back(c, "formato");
    // The role decides the action; the form never does. The engine checks it again.
    const member = memberContext(c);
    const type = member.role === "owner" ? "confirm_price" : "propose_price";
    const result = await c.get("runtime").catalog.changePrice(member, productId, price, type);
    if (result.type === "not_ready") return c.html(page(NOTICES.listo, [], false, c.get("csrf")), 503);
    c.get("runtime").deps.log.info("console_action", { businessId: member.businessId, outcome: result.outcome.type });
    return back(c, noticeFor(result.outcome, type === "confirm_price"));
  });
}

function page(notice: string | null, rows: readonly CatalogRow[], owner: boolean, csrf: string) {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Productos</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>Productos</h1><a href="/console/preparacion">Preparación</a></header>
${notice === null ? "" : html`<p class="notice" role="status">${notice}</p>`}
${owner ? addForm(csrf) : ""}
${rows.length === 0 ? html`<p class="empty">Todavía no hay productos.</p>` : html`<ul class="products">${rows.map((row) => productRow(row, owner, csrf))}</ul>`}
</body>
</html>`;
}

function addForm(csrf: string) {
  return html`<form class="add" method="post" action="/console/productos">
<h2>Agregar producto</h2>
<label>Nombre<input name="nombre" maxlength="120" required></label>
<label>Precio en lempiras<input name="precio" inputmode="decimal" placeholder="12.50" required></label>
<input type="hidden" name="csrf" value="${csrf}">
<button class="primary">Agregar</button>
</form>`;
}

function productRow(row: CatalogRow, owner: boolean, csrf: string) {
  return html`<li id="${row.id}">
<div class="head"><strong>${row.name}</strong><span class="${row.price === null ? "none" : "price"}">${row.price === null ? "sin precio" : formatLempiras(row.price)}</span></div>
${row.proposed === null ? "" : html`<p class="meta">Propuesto: ${formatLempiras(row.proposed)}</p>`}
<form method="post" action="/console/productos/${row.id}/precio">
<input name="precio" inputmode="decimal" placeholder="${row.proposed === null ? "12.50" : centavosText(row.proposed)}" value="${row.proposed === null ? "" : centavosText(row.proposed)}" aria-label="Precio en lempiras" required>
<input type="hidden" name="csrf" value="${csrf}">
<button>${owner ? "Confirmar precio" : "Proponer precio"}</button>
</form>
</li>`;
}

const STYLE = `
*{box-sizing:border-box}body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#f4f4f2;color:#1b1b1b}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#1f3d2b;color:#fff}
h1{font-size:18px;margin:0}h2{font-size:16px;margin:0 0 8px}header a{color:#fff}
.notice{margin:10px;padding:10px;border-radius:8px;background:#fff3cd;border:1px solid #e0c060}
.empty{padding:20px;text-align:center;color:#666}.meta{margin:4px 0;font-size:14px;color:#555}
ul{list-style:none;margin:0;padding:0}.products li,.add{margin:10px;padding:12px;border-radius:10px;background:#fff}
.head{display:flex;justify-content:space-between;gap:8px}.none{color:#b33}.price{font-weight:600}
label{display:block;margin:6px 0}input{display:block;width:100%;min-height:44px;font-size:16px;padding:6px;border:1px solid #888;border-radius:8px}
form{margin:0}li form{display:flex;gap:8px;margin-top:8px}li form input{flex:1}
button{min-height:44px;min-width:88px;font-size:16px;border-radius:8px;border:1px solid #888;background:#fff}
button.primary{width:100%;margin-top:8px;background:#2f6f45;color:#fff;border:0}
`;
