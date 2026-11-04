/**
 * The Products screen (K6, #40): the store's one product list, whichever engine runs the chat. Every
 * product with its current confirmed price, or "sin precio". The owner adds a product and confirms
 * prices; staff propose one for the owner to confirm. A product's details page (owner only) edits its
 * name, the other names customers use, how it's sold and the "No hay" mark. Every write goes through
 * `CatalogService`, which keeps `products` and `store_products` one list. Prices are typed in lempiras
 * and converted to centavos by `parseLempiras`, never through a float.
 *
 * The store is always the session's: a product ID from a URL or a form only ever matches that store.
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { type CatalogRow, PRODUCT_NAME_MAX } from "../../../application/catalog";
import { formatLempiras } from "../../../domain/contract/numbers";
import type { EngineOutcome } from "../../../domain/contract/outcomes";
import { PRICE_FORMAT_HELP, parseLempiras } from "../../../domain/price";
import { MAX_OTHER_NAMES, parseOtherNames, parseSoldBy, parseUsualQuantity, type ProductSelling } from "../../../domain/store-setup";
import { type ConsoleEnv, memberContext, requireOwner } from "./auth";
import { csrfField, shell } from "./layout";

const PATH = "/console/productos";

const NOTICES = {
  agregado: "Producto agregado.",
  confirmado: "Precio confirmado.",
  propuesto: "Precio propuesto. El dueño lo confirma.",
  formato: PRICE_FORMAT_HELP,
  nombre: `Escribí el nombre del producto (hasta ${PRODUCT_NAME_MAX} letras).`,
  repetido: "Ya hay un producto con ese nombre.",
  yaguardado: "Ese precio ya se guardó hace un momento. Esperá un minuto para cambiarlo otra vez.",
  falta: "Ese producto no está en la lista.",
  permiso: "Eso lo confirma el dueño.",
  estado: "El precio cambió mientras tanto. La lista ya está al día.",
  listo: "La lista de productos no está lista todavía.",
  guardado: "Listo. Cambios guardados.",
  otros: `Revisá los otros nombres: máximo ${MAX_OTHER_NAMES}, uno por línea.`,
  cantidad: "No pude leer la cantidad de siempre. Escribila así: 1 o 0.5, sin comas. Si no sabés, dejala vacía.",
  no_hay: "Listo. Marcado No hay: el asistente le dice al cliente que se acabó.",
  si_hay: "Listo. Ya no está marcado No hay.",
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

const idOf = (value: unknown): string | null => (typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null);

export function productosScreen(app: Hono<ConsoleEnv>) {
  const back = (c: { redirect: (url: string, status: 303) => Response }, notice: Notice) => c.redirect(`${PATH}?aviso=${notice}`, 303);
  const detailsBack = (c: { redirect: (url: string, status: 303) => Response }, productId: string, notice: Notice) =>
    c.redirect(`${PATH}/${encodeURIComponent(productId)}?aviso=${notice}`, 303);

  app.get("/productos", async (c) => {
    const member = c.get("member");
    const rows = await c.get("runtime").catalog.list(member);
    return c.html(page(c, noticeOf(c), rows));
  });

  app.post("/productos", requireOwner, async (c) => {
    const form = await c.req.parseBody();
    const name = typeof form["nombre"] === "string" ? form["nombre"] : "";
    const rawPrice = typeof form["precio"] === "string" ? form["precio"] : "";
    // Blank is "sin precio" (absent means unknown); anything else must read as a price.
    const price = rawPrice.trim() === "" ? null : parseLempiras(rawPrice);
    if (rawPrice.trim() !== "" && price === null) return back(c, "formato");
    const rawOthers = typeof form["otros"] === "string" ? form["otros"] : "";
    const otherNames = rawOthers.length > 2_000 ? null : parseOtherNames(rawOthers, name);
    if (otherNames === null) return back(c, "otros");
    const result = await c.get("runtime").catalog.addProduct(memberContext(c), { name, price, otherNames });
    if (result.type === "added") return back(c, "agregado");
    const reasons: Record<typeof result.reason, Notice> = { name_taken: "repetido", name: "nombre", price: "formato", other_names: "otros", not_allowed: "permiso" };
    return back(c, reasons[result.reason]);
  });

  app.get("/productos/:productId", requireOwner, async (c) => {
    const productId = idOf(c.req.param("productId"));
    const product = productId === null ? null : await c.get("runtime").catalog.product(c.get("member"), productId);
    if (product === null) return back(c, "falta");
    return c.html(detailsPage(c, noticeOf(c), product));
  });

  app.post("/productos/:productId", requireOwner, async (c) => {
    const productId = idOf(c.req.param("productId"));
    if (productId === null) return c.text("Bad request", 400);
    const form = await c.req.parseBody();
    const name = typeof form["nombre"] === "string" ? form["nombre"] : "";
    const rawOthers = typeof form["otros"] === "string" ? form["otros"] : "";
    const otherNames = rawOthers.length > 2_000 ? null : parseOtherNames(rawOthers, name);
    if (otherNames === null) return detailsBack(c, productId, "otros");
    const selling = sellingFields(form);
    if (selling === "bad") return c.text("Bad request", 400);
    if (selling === "cantidad") return detailsBack(c, productId, "cantidad");
    const saved = await c.get("runtime").catalog.updateDetails(memberContext(c), productId, { name, otherNames, ...(selling === undefined ? {} : { selling }) });
    switch (saved) {
      case "saved":
        return detailsBack(c, productId, "guardado");
      case "name_taken":
        return detailsBack(c, productId, "repetido");
      case "name":
        return detailsBack(c, productId, "nombre");
      case "other_names":
        return detailsBack(c, productId, "otros");
      case "not_allowed":
        return back(c, "permiso");
      default:
        return back(c, "falta");
    }
  });

  app.post("/productos/:productId/hay", requireOwner, async (c) => {
    const productId = idOf(c.req.param("productId"));
    const mark = (await c.req.parseBody())["no_hay"];
    if (productId === null || (mark !== "1" && mark !== "0")) return c.text("Bad request", 400);
    if (!(await c.get("runtime").catalog.setNoHay(memberContext(c), productId, mark === "1"))) return back(c, "falta");
    return detailsBack(c, productId, mark === "1" ? "no_hay" : "si_hay");
  });

  app.post("/productos/:productId/precio", async (c) => {
    const productId = c.req.param("productId");
    if (productId.length > 64) return c.text("Bad request", 400);
    const form = await c.req.parseBody();
    const price = parseLempiras(typeof form["precio"] === "string" ? form["precio"] : "");
    // The details page sends the owner back to it; the list is where everyone else is.
    const toDetails = form["desde"] === "detalle" && c.get("member").role === "owner";
    const reply = (notice: Notice) => (toDetails ? detailsBack(c, productId, notice) : back(c, notice));
    if (price === null) return reply("formato");
    // The role decides the action; the form never does. The engine checks it again.
    const member = memberContext(c);
    const type = member.role === "owner" ? "confirm_price" : "propose_price";
    const result = await c.get("runtime").catalog.changePrice(member, productId, price, type);
    if (result.type === "not_ready") return c.html(page(c, NOTICES.listo, []), 503);
    c.get("runtime").deps.log.info("console_action", { businessId: member.businessId, outcome: result.outcome.type });
    return reply(noticeFor(result.outcome, type === "confirm_price"));
  });
}

function noticeOf(c: Context<ConsoleEnv>): string | null {
  const notice = c.req.query("aviso");
  return notice !== undefined && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as Notice] : null;
}

/**
 * How it's sold, from the details form. Undefined when the form has neither field (left unchanged);
 * "cantidad" when the usual amount can't be read; "bad" for a choice the form doesn't offer.
 */
function sellingFields(form: Record<string, unknown>): ProductSelling | undefined | "cantidad" | "bad" {
  const rawSoldBy = form["vende"];
  const rawUsual = form["usual"];
  if (rawSoldBy === undefined && rawUsual === undefined) return undefined;
  if ((rawSoldBy !== undefined && typeof rawSoldBy !== "string") || (rawUsual !== undefined && typeof rawUsual !== "string")) return "bad";
  const soldBy = parseSoldBy(rawSoldBy ?? "");
  if (soldBy === null) return "bad";
  const usual = (rawUsual ?? "").length > 20 ? null : parseUsualQuantity(rawUsual ?? "");
  if (usual === null) return "cantidad";
  return { soldBy: soldBy.soldBy, usualQuantity: usual.quantity };
}

/** A tab of the console (Productos), in the shared layout. */
function page(c: Context<ConsoleEnv>, notice: string | null, rows: readonly CatalogRow[]) {
  const owner = c.get("member").role === "owner";
  const csrf = c.get("csrf");
  return shell(c, {
    title: "Productos",
    path: PATH,
    notice,
    style: STYLE,
    body: html`${rows.length === 0 ? html`<p class="empty">Todavía no hay productos.</p>` : html`<ul class="products">${rows.map((row) => productRow(row, owner, csrf))}</ul>`}
${owner ? addForm(csrf) : ""}`,
  });
}

function addForm(csrf: string) {
  return html`<form class="add" method="post" action="${PATH}">
<h2>Agregar producto</h2>
<label>Nombre<input name="nombre" maxlength="${PRODUCT_NAME_MAX}" required autocomplete="off"></label>
<label>Precio en lempiras <small>(vacío si no lo sabés)</small><input name="precio" inputmode="decimal" placeholder="12.50" autocomplete="off"></label>
<label>Otros nombres que usan los clientes <small>(opcional, uno por línea)</small><textarea name="otros" rows="2"></textarea></label>
<input type="hidden" name="csrf" value="${csrf}">
<button class="primary">Agregar</button>
<p class="meta"><a href="/console/tienda/pegar">Pegar una lista de muchos productos</a></p>
</form>`;
}

/** What the price box is filled with: a proposal to confirm, or an old price typed before the ledger. */
const pending = (row: CatalogRow): number | null => row.proposed ?? row.unconfirmed;

function priceForm(row: CatalogRow, owner: boolean, csrf: string, fromDetails: boolean) {
  const fill = pending(row);
  return html`<form method="post" action="${PATH}/${row.id}/precio">
<input name="precio" inputmode="decimal" placeholder="${fill === null ? "12.50" : centavosText(fill)}" value="${fill === null ? "" : centavosText(fill)}" aria-label="Precio en lempiras" required>
<input type="hidden" name="csrf" value="${csrf}">${fromDetails ? html`<input type="hidden" name="desde" value="detalle">` : ""}
<button>${owner ? "Confirmar precio" : "Proponer precio"}</button>
</form>`;
}

function productRow(row: CatalogRow, owner: boolean, csrf: string) {
  return html`<li id="${row.id}"${row.noHay ? html` class="out"` : ""}>
<div class="head"><strong>${owner ? html`<a href="${PATH}/${encodeURIComponent(row.id)}">${row.name}</a>` : row.name}</strong><span class="${row.price === null ? "none" : "price"}">${row.price === null ? "sin precio" : formatLempiras(row.price)}</span></div>
${row.proposed === null ? "" : html`<p class="meta">Propuesto: ${formatLempiras(row.proposed)}</p>`}
${row.unconfirmed === null ? "" : html`<p class="meta">Precio anotado antes: ${formatLempiras(row.unconfirmed)}. Confirmalo para que el asistente lo use.</p>`}
${row.noHay ? html`<p class="meta">No hay</p>` : ""}
${priceForm(row, owner, csrf, false)}
</li>`;
}

function detailsPage(c: Context<ConsoleEnv>, notice: string | null, p: CatalogRow) {
  const csrf = c.get("csrf");
  return shell(c, {
    title: p.name,
    path: `${PATH}/${p.id}`,
    tab: PATH,
    notice,
    style: STYLE,
    body: html`<section class="card">
<div class="head"><strong>${p.name}</strong><span class="${p.price === null ? "none" : "price"}">${p.price === null ? "sin precio" : formatLempiras(p.price)}</span></div>
${p.proposed === null ? "" : html`<p class="meta">Propuesto: ${formatLempiras(p.proposed)}</p>`}
${p.unconfirmed === null ? "" : html`<p class="meta">Precio anotado antes: ${formatLempiras(p.unconfirmed)}. Confirmalo para que el asistente lo use.</p>`}
${priceForm(p, true, csrf, true)}
</section>
<section class="card">
<h2>${p.noHay ? "Marcado No hay" : "¿Se acabó?"}</h2>
<form method="post" action="${PATH}/${p.id}/hay">${csrfField(csrf)}<input type="hidden" name="no_hay" value="${p.noHay ? "0" : "1"}"><button>${p.noHay ? "Sí hay" : "No hay"}</button></form>
</section>
<section class="card">
<h2>Datos del producto</h2>
<form method="post" action="${PATH}/${p.id}">${csrfField(csrf)}
<label>Nombre<input name="nombre" maxlength="${PRODUCT_NAME_MAX}" value="${p.name}" required autocomplete="off"></label>
<label>Otros nombres que usan los clientes <small>(uno por línea)</small><textarea name="otros" rows="3">${p.otherNames.join("\n")}</textarea></label>
<fieldset class="sold"><legend>Cómo se vende</legend>
<label class="check"><input type="radio" name="vende" value="unidad"${p.soldBy === "unit" ? html` checked` : ""}> Por unidad</label>
<label class="check"><input type="radio" name="vende" value="libra"${p.soldBy === "weight" ? html` checked` : ""}> Por libra</label>
<label class="check"><input type="radio" name="vende" value=""${p.soldBy === null ? html` checked` : ""}> No sé</label>
</fieldset>
<label>Cantidad de siempre <small>(opcional: lo que casi todos llevan, por ejemplo 1)</small><input name="usual" inputmode="decimal" maxlength="20" value="${p.usualQuantity ?? ""}" autocomplete="off"></label>
<p class="meta">Si un cliente no dice cuánto, el asistente le propone esa cantidad y el cliente la confirma.</p>
<button class="primary">Guardar</button>
</form>
</section>
<p class="meta"><a href="${PATH}">Volver a Productos</a></p>`,
  });
}

/** The product cards; the header, tabs, notice and buttons come from the shared layout. */
const STYLE = `
.meta{margin:6px 0;font-size:15px;color:var(--mute)}
.products li,.add{margin:12px 16px;padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--card);box-shadow:var(--shadow)}
.add{margin-top:24px}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:10px}.head strong{font-size:18px;font-weight:700}
.none{flex:none;padding:5px 9px;border-radius:5px;background:var(--wash);color:#7c6539;font-size:13px;font-weight:700}
.price{white-space:nowrap;font-size:22px;font-weight:700;letter-spacing:-.4px}
li form{display:flex;align-items:flex-end;gap:8px;margin-top:12px}li form input{flex:1;margin-top:0}
@media (min-width:1024px){.products,.add{max-width:760px}.products li,.add{margin-left:0;margin-right:0}}
label small{font-weight:400;color:var(--mute)}
label.check{display:flex;align-items:center;min-height:48px}
label.check input{display:inline;width:22px;min-height:0;margin:0 10px 0 0}
fieldset.sold{border:1px solid var(--line);border-radius:14px;margin:10px 0;padding:8px 12px 12px}fieldset.sold legend{font-weight:800}
`;
