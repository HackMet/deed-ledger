/**
 * Tienda (owner only, #40): the store's own products, prices and "No hay" marks, its hours and its
 * delivery fee. The pretend engine reads them per store (PRETEND_ENGINE); staff can't open or
 * change any of it.
 *
 * The store is always the session's. A product ID from a form or a URL is only ever used together
 * with that store, so another store's ID finds nothing and changes nothing.
 *
 * The paste box never saves on the first tap: it shows what it read and what it couldn't, and
 * "Guardar" reads the same text again and saves only the lines it could read. A price is never
 * guessed.
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { type Centavos, formatLempiras } from "../../../domain/contract/numbers";
import {
  cleanProductName,
  DAY_LABELS,
  type DayHours,
  daysOf,
  hoursFromDays,
  MAX_PASTE_LINES,
  MAX_PRODUCT_NAME,
  type PasteProblem,
  parseFee,
  parseLempiras,
  parseOtherNames,
  parsePasteBox,
  productNameKey,
  type StoreProduct,
} from "../../../domain/store-setup";
import { type ConsoleEnv, requireOwner } from "./auth";
import { csrfField, shell } from "./layout";

const PATH = "/console/tienda";
/** Paste text is at most what the console's 16 KiB form limit lets through. */
const MAX_PASTE_CHARS = 15_000;

const NOTICES = {
  agregado: "Listo. Producto agregado.",
  existe: "Ya tenés un producto con ese nombre. Buscalo en la lista y tocá Editar.",
  guardado: "Listo. Cambios guardados.",
  nombre_usado: "Ya hay otro producto con ese nombre.",
  nombre: "Escribí el nombre del producto (máximo 80 letras).",
  precio: "No pude leer el precio. Escribilo así: 18 o 18.50, sin comas. Si no lo sabés, dejalo vacío.",
  otros: "Revisá los otros nombres: máximo 10, uno por línea.",
  falta: "Ese producto ya no está en la lista.",
  quitado: "Listo. Producto quitado.",
  no_hay: "Listo. Marcado No hay: el asistente le dice al cliente que se acabó.",
  si_hay: "Listo. Ya no está marcado No hay.",
  pegados: "Listo. Productos guardados.",
  nada: "No había productos para guardar.",
  horario: "Listo. Horario guardado.",
  sin_horario: "Listo. Sin horario: si un cliente pregunta, el asistente le dice que le confirmás.",
  envio: "Listo. Envío guardado.",
  envio_mal: "No pude leer el envío. Escribilo así: 25 o 25.50. Poné 0 si es gratis.",
} as const;
type NoticeKey = keyof typeof NOTICES;

const PROBLEMS: Record<PasteProblem, string> = {
  no_price: "no tiene precio",
  comma: "el precio lleva coma; escribilo así: 18.50",
  unreadable: "no pude leer el precio; escribilo así: Arroz 1 lb - 18",
  zero: "el precio es cero",
  too_big: "el precio es demasiado alto",
  no_name: "falta el nombre",
  name_too_long: "el nombre es muy largo",
  repeated: "ya está más arriba en la lista",
};

export function tiendaScreen(app: Hono<ConsoleEnv>) {
  app.get("/tienda", requireOwner, async (c) => {
    const products = await setup(c).listProducts(c.get("member"));
    return page(c, "products", html`${addForm(c.get("csrf"))}${productList(products, c.get("csrf"))}`);
  });

  app.post("/tienda/agregar", requireOwner, async (c) => {
    const fields = productFields(await c.req.parseBody());
    if (typeof fields === "string") return back(c, fields);
    const added = await setup(c).addProduct(c.get("member"), fields, now(c));
    return back(c, added === "added" ? "agregado" : "existe");
  });

  app.get("/tienda/editar", requireOwner, async (c) => {
    const productId = idOf(c.req.query("producto"));
    const product = productId === null ? null : await setup(c).product(c.get("member"), productId);
    if (product === null) return back(c, "falta");
    return page(c, "products", editForm(product, c.get("csrf")));
  });

  app.post("/tienda/editar", requireOwner, async (c) => {
    const form = await c.req.parseBody();
    const productId = idOf(form["producto"]);
    if (productId === null) return c.text("Bad request", 400);
    const fields = productFields(form);
    if (typeof fields === "string") return c.redirect(`${PATH}/editar?producto=${encodeURIComponent(productId)}&aviso=${fields}`, 303);
    const saved = await setup(c).updateProduct(c.get("member"), productId, fields, now(c));
    if (saved === "name_taken") return c.redirect(`${PATH}/editar?producto=${encodeURIComponent(productId)}&aviso=nombre_usado`, 303);
    return back(c, saved === "saved" ? "guardado" : "falta");
  });

  app.post("/tienda/hay", requireOwner, async (c) => {
    const form = await c.req.parseBody();
    const productId = idOf(form["producto"]);
    const mark = form["no_hay"];
    if (productId === null || (mark !== "1" && mark !== "0")) return c.text("Bad request", 400);
    if (!(await setup(c).setNoHay(c.get("member"), productId, mark === "1", now(c)))) return back(c, "falta");
    return back(c, mark === "1" ? "no_hay" : "si_hay", productId);
  });

  app.get("/tienda/quitar", requireOwner, async (c) => {
    const productId = idOf(c.req.query("producto"));
    const product = productId === null ? null : await setup(c).product(c.get("member"), productId);
    if (product === null) return back(c, "falta");
    return page(
      c,
      "products",
      html`<section class="card">
<h2>¿Quitar ${product.name}?</h2>
<p>El asistente ya no lo va a reconocer. Si lo vendés otra vez, lo agregás de nuevo.</p>
<form method="post" action="${PATH}/quitar">${csrfField(c.get("csrf"))}<input type="hidden" name="producto" value="${product.productId}"><button class="primary danger-fill">Sí, quitar</button></form>
<p class="cancel"><a href="${PATH}">Cancelar</a></p>
</section>`,
    );
  });

  app.post("/tienda/quitar", requireOwner, async (c) => {
    const productId = idOf((await c.req.parseBody())["producto"]);
    if (productId === null) return c.text("Bad request", 400);
    return back(c, (await setup(c).removeProduct(c.get("member"), productId)) ? "quitado" : "falta");
  });

  app.get("/tienda/pegar", requireOwner, (c) => page(c, "products", pasteForm(c.get("csrf"), "")));

  // First tap: shows what will be saved and what couldn't be read. Saves nothing.
  app.post("/tienda/pegar", requireOwner, async (c) => {
    const text = pasteText(await c.req.parseBody());
    if (text === null) return c.text("Bad request", 400);
    const existing = await setup(c).listProducts(c.get("member"));
    return page(c, "products", pastePreview(text, existing, c.get("csrf")));
  });

  // Second tap: reads the same text again and saves only the lines it could read.
  app.post("/tienda/pegar/guardar", requireOwner, async (c) => {
    const text = pasteText(await c.req.parseBody());
    if (text === null) return c.text("Bad request", 400);
    const { products } = parsePasteBox(text);
    if (products.length === 0) return back(c, "nada");
    const member = c.get("member");
    await setup(c).importProducts(member, products, now(c));
    c.get("runtime").deps.log.info("store_products_pasted", { businessId: member.businessId, count: products.length });
    return back(c, "pegados");
  });

  app.get("/tienda/horario", requireOwner, async (c) => {
    const settings = await setup(c).settings(c.get("member"));
    return page(c, "hours", hoursPage(c.get("csrf"), daysOf(settings.hours), [], settings.deliveryFee));
  });

  app.post("/tienda/horario", requireOwner, async (c) => {
    const form = await c.req.parseBody();
    const days = daysFromForm(form);
    const result = hoursFromDays(days);
    if ("badDays" in result) {
      const { deliveryFee } = await setup(c).settings(c.get("member"));
      return page(c, "hours", hoursPage(c.get("csrf"), days, result.badDays, deliveryFee), 400);
    }
    await setup(c).saveHours(c.get("member"), result.hours, now(c));
    return back(c, result.hours === null ? "sin_horario" : "horario", null, "/horario");
  });

  app.post("/tienda/envio", requireOwner, async (c) => {
    const raw = (await c.req.parseBody())["envio"];
    if (typeof raw !== "string" || raw.length > 40) return c.text("Bad request", 400);
    const fee = parseFee(raw);
    if (!("fee" in fee)) return back(c, "envio_mal", null, "/horario");
    await setup(c).saveDeliveryFee(c.get("member"), fee.fee, now(c));
    return back(c, "envio", null, "/horario");
  });
}

const setup = (c: Context<ConsoleEnv>) => c.get("runtime").storeSetup;
const now = (c: Context<ConsoleEnv>) => c.get("runtime").deps.clock.now();

function back(c: Context<ConsoleEnv>, notice: NoticeKey, productId: string | null = null, sub = "") {
  const anchor = productId === null ? "" : `#p-${encodeURIComponent(productId)}`;
  return c.redirect(`${PATH}${sub}?aviso=${notice}${anchor}`, 303);
}

function page(c: Context<ConsoleEnv>, tab: "products" | "hours", body: unknown, status: 200 | 400 = 200) {
  const notice = c.req.query("aviso");
  return c.html(
    shell(c, {
      title: "Tienda",
      path: PATH,
      tab: "/console/mas",
      notice: notice !== undefined && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as NoticeKey] : null,
      style: STYLE,
      body: html`${subTabs(tab)}${body}`,
    }),
    status,
  );
}

function idOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

function pasteText(form: Record<string, unknown>): string | null {
  const text = form["lista"];
  return typeof text === "string" && text.length <= MAX_PASTE_CHARS ? text : null;
}

/** Name, price and other names from the add or edit form; a notice key when one can't be read. */
function productFields(form: Record<string, unknown>) {
  const rawName = form["nombre"];
  const rawPrice = form["precio"] ?? "";
  const rawOthers = form["otros"] ?? "";
  if (typeof rawName !== "string" || typeof rawPrice !== "string" || typeof rawOthers !== "string") return "nombre" as const;
  const name = cleanProductName(rawName);
  if (name === null) return "nombre" as const;
  let price: Centavos | null = null;
  if (rawPrice.trim() !== "") {
    const parsed = parseLempiras(rawPrice);
    if (!("price" in parsed)) return "precio" as const;
    price = parsed.price;
  }
  const otherNames = rawOthers.length > 2_000 ? null : parseOtherNames(rawOthers, name);
  if (otherNames === null) return "otros" as const;
  return { name, price, otherNames };
}

/** Seven days from the hours form: a day is open only when its box is ticked. */
function daysFromForm(form: Record<string, unknown>): DayHours[] {
  return [1, 2, 3, 4, 5, 6, 7].map((day) => {
    if (form[`abierto_${day}`] !== "1") return { day, opens: null, closes: null };
    const time = (name: string) => {
      const value = form[`${name}_${day}`];
      return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 5) : null;
    };
    // An open day with a missing time stays open with nothing: hoursFromDays reports it.
    return { day, opens: time("abre") ?? "", closes: time("cierra") ?? "" };
  });
}

/** "18" or "18.50", as the price box shows a saved price. */
function priceInput(price: Centavos | null): string {
  return price === null ? "" : formatLempiras(price).slice(2);
}

// ---------------------------------------------------------------------------------------------
// Rendering. `html` escapes every interpolated string.

function subTabs(tab: "products" | "hours") {
  return html`<p class="subtabs"><a href="${PATH}"${tab === "products" ? html` aria-current="page"` : ""}>Productos</a><a href="${PATH}/horario"${tab === "hours" ? html` aria-current="page"` : ""}>Horario y envío</a></p>`;
}

function addForm(csrf: string) {
  return html`<section class="card">
<h2>Agregar un producto</h2>
<form method="post" action="${PATH}/agregar">${csrfField(csrf)}
<label>Nombre<input name="nombre" maxlength="${MAX_PRODUCT_NAME}" placeholder="Arroz 1 lb" required autocomplete="off"></label>
<label>Precio en lempiras<input name="precio" inputmode="decimal" placeholder="18.50" autocomplete="off"></label>
<label>Otros nombres que usan los clientes <small>(opcional, uno por línea)</small><textarea name="otros" rows="2" placeholder="libra de arroz"></textarea></label>
<button class="primary">Agregar</button>
</form>
<p class="more"><a href="${PATH}/pegar">Pegar una lista de muchos productos</a></p>
</section>`;
}

function productList(products: readonly StoreProduct[], csrf: string) {
  if (products.length === 0) {
    return html`<p class="empty">Todavía no hay productos. Agregá uno arriba o pegá una lista.</p>`;
  }
  return html`<p class="count">${products.length} ${products.length === 1 ? "producto" : "productos"}</p>${products.map((p) => productCard(p, csrf))}`;
}

function productCard(p: StoreProduct, csrf: string) {
  return html`<section class="card product${p.noHay ? " out" : ""}" id="p-${p.productId}">
<div class="head"><strong>${p.name}</strong><span class="price">${p.price === null ? "Sin precio" : formatLempiras(p.price)}</span></div>
${p.otherNames.length === 0 ? "" : html`<p class="meta">También: ${p.otherNames.join(", ")}</p>`}
${p.noHay ? html`<p class="badge">No hay</p>` : ""}
<div class="buttons">
<form method="post" action="${PATH}/hay">${csrfField(csrf)}<input type="hidden" name="producto" value="${p.productId}"><input type="hidden" name="no_hay" value="${p.noHay ? "0" : "1"}"><button${p.noHay ? html` class="yes"` : ""}>${p.noHay ? "Sí hay" : "No hay"}</button></form>
<a class="button" href="${PATH}/editar?producto=${encodeURIComponent(p.productId)}">Editar</a>
<a class="button danger" href="${PATH}/quitar?producto=${encodeURIComponent(p.productId)}">Quitar</a>
</div>
</section>`;
}

function editForm(p: StoreProduct, csrf: string) {
  return html`<section class="card">
<h2>Editar ${p.name}</h2>
<form method="post" action="${PATH}/editar">${csrfField(csrf)}<input type="hidden" name="producto" value="${p.productId}">
<label>Nombre<input name="nombre" maxlength="${MAX_PRODUCT_NAME}" value="${p.name}" required autocomplete="off"></label>
<label>Precio en lempiras <small>(vacío si no lo sabés)</small><input name="precio" inputmode="decimal" value="${priceInput(p.price)}" autocomplete="off"></label>
<label>Otros nombres que usan los clientes <small>(uno por línea)</small><textarea name="otros" rows="3">${p.otherNames.join("\n")}</textarea></label>
<button class="primary">Guardar</button>
</form>
<p class="cancel"><a href="${PATH}">Cancelar</a></p>
</section>`;
}

function pasteForm(csrf: string, text: string) {
  return html`<section class="card">
<h2>Pegar una lista</h2>
<p>Un producto por línea, con el precio en lempiras al final:</p>
<pre class="example">Arroz 1 lb - 18
Aceite 1 L, 58
Azúcar 1 lb - L 16.50</pre>
<form method="post" action="${PATH}/pegar">${csrfField(csrf)}
<textarea name="lista" rows="10" maxlength="${MAX_PASTE_CHARS}" required>${text}</textarea>
<button class="primary">Revisar</button>
</form>
<p class="meta">Primero te enseño lo que entendí. No se guarda nada hasta que tocás Guardar. Hasta ${MAX_PASTE_LINES} productos por vez.</p>
<p class="cancel"><a href="${PATH}">Volver a Productos</a></p>
</section>`;
}

function pastePreview(text: string, existing: readonly StoreProduct[], csrf: string) {
  const { products, problems, truncated } = parsePasteBox(text);
  const byKey = new Map(existing.map((p) => [productNameKey(p.name), p]));
  const tag = (name: string, price: Centavos) => {
    const old = byKey.get(productNameKey(name));
    if (old === undefined) return "nuevo";
    if (old.price === price) return "ya está, mismo precio";
    return old.price === null ? "ya está, le pone precio" : `ya está, cambia de ${formatLempiras(old.price)}`;
  };
  return html`<section class="card">
<h2>${products.length === 0 ? "No pude leer ningún producto" : `Se van a guardar ${products.length}`}</h2>
${
  products.length === 0
    ? ""
    : html`<ul class="preview">${products.map((p) => html`<li><span>${p.name}</span><strong>${formatLempiras(p.price)}</strong><small>${tag(p.name, p.price)}</small></li>`)}</ul>
<form method="post" action="${PATH}/pegar/guardar">${csrfField(csrf)}<textarea name="lista" hidden>${text}</textarea><button class="primary">Guardar ${products.length} ${products.length === 1 ? "producto" : "productos"}</button></form>`
}
</section>
${
  problems.length === 0 && !truncated
    ? ""
    : html`<section class="card problems">
<h2>${problems.length === 1 ? "1 línea no se va a guardar" : `${problems.length} líneas no se van a guardar`}</h2>
<ul>${problems.map((p) => html`<li>Línea ${p.line}: «${p.text}»: ${PROBLEMS[p.problem]}.</li>`)}</ul>
${truncated ? html`<p>Solo leo ${MAX_PASTE_LINES} productos por vez. Pegá el resto después.</p>` : ""}
<p class="meta">Corregilas abajo y tocá Revisar otra vez, o guardá las que sí leí.</p>
</section>`
}
${pasteForm(csrf, text)}`;
}

function hoursPage(csrf: string, days: readonly DayHours[], badDays: readonly number[], fee: Centavos | null) {
  return html`<section class="card">
<h2>Horario</h2>
<p class="meta">Marcá los días que abrís. El asistente se lo dice a los clientes que preguntan.</p>
${badDays.length === 0 ? "" : html`<p class="error" role="alert">Revisá ${badDays.map((d) => DAY_LABELS[d - 1]!.toLowerCase()).join(", ")}: poné la hora de abrir y la de cerrar, y que cierre después de abrir.</p>`}
<form method="post" action="${PATH}/horario">${csrfField(csrf)}
${days.map((d) => dayRow(d, badDays.includes(d.day)))}
<button class="primary">Guardar horario</button>
</form>
</section>
<section class="card">
<h2>Envío a domicilio</h2>
<p class="meta">Ahora: ${fee === null ? "sin definir" : fee === 0 ? "gratis" : formatLempiras(fee)}. Se le dice al cliente aparte del total.</p>
<form method="post" action="${PATH}/envio">${csrfField(csrf)}
<label>Cuánto cobrás por llevarlo, en lempiras <small>(0 si es gratis; vacío si todavía no sabés)</small><input name="envio" inputmode="decimal" value="${priceInput(fee)}" autocomplete="off"></label>
<button class="primary">Guardar envío</button>
</form>
</section>`;
}

function dayRow(d: DayHours, bad: boolean) {
  const open = d.opens !== null || d.closes !== null;
  return html`<fieldset class="day${bad ? " bad" : ""}"><legend>${DAY_LABELS[d.day - 1]}</legend>
<label class="check"><input type="checkbox" name="abierto_${d.day}" value="1"${open ? html` checked` : ""}> Abierto</label>
<label>Abre<input type="time" name="abre_${d.day}" value="${d.opens ?? ""}"></label>
<label>Cierra<input type="time" name="cierra_${d.day}" value="${d.closes ?? ""}"></label>
</fieldset>`;
}

const STYLE = `
h2{font-size:17px;margin:0 0 8px}
label{display:block;margin:8px 0;font-weight:600}label small{font-weight:400;color:#555}
input,textarea{display:block;width:100%;min-height:44px;margin-top:4px;padding:8px;font:16px system-ui,sans-serif;border:1px solid #888;border-radius:8px}
.subtabs{display:flex;gap:8px;margin:10px}.subtabs a{flex:1;text-align:center;padding:10px 4px;border-radius:8px;background:#fff;color:#1f3d2b;text-decoration:none;border:1px solid #ccc}
.subtabs a[aria-current=page]{background:#1f3d2b;color:#fff;border-color:#1f3d2b}
.head{display:flex;justify-content:space-between;gap:8px}.price{white-space:nowrap;font-weight:600}
.meta,.count{margin:4px 10px 8px;font-size:14px;color:#555}.card .meta{margin:4px 0 8px}
.badge{display:inline-block;margin:4px 0;padding:2px 8px;border-radius:6px;background:#b33;color:#fff;font-size:14px}
.product.out{border-left:4px solid #b33}
.buttons{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
button.yes{border-color:#2f6f45;color:#2f6f45}
a.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:88px;padding:0 12px;
border-radius:8px;border:1px solid #888;background:#fff;color:#1b1b1b;text-decoration:none;font-size:16px}
a.button.danger{border-color:#b33;color:#b33}
button.danger-fill{background:#b33}
.cancel,.more{text-align:center;margin-top:12px}
pre.example{background:#f4f4f2;padding:8px;border-radius:8px;font-size:15px;white-space:pre-wrap}
ul.preview li{display:flex;flex-wrap:wrap;gap:6px;padding:6px 0;border-bottom:1px solid #eee}
ul.preview li span{flex:1}ul.preview li small{width:100%;color:#555}
.problems{border-left:4px solid #e0c060}.problems li{padding:4px 0}
.error{padding:8px;border-radius:8px;background:#fde8e8;border:1px solid #b33}
fieldset.day{border:1px solid #ddd;border-radius:8px;margin:8px 0;padding:6px 10px;display:flex;flex-wrap:wrap;gap:0 10px}
fieldset.day legend{font-weight:700}fieldset.day label{flex:1;min-width:120px}fieldset.day label.check{flex-basis:100%}
fieldset.day.bad{border-color:#b33}
label.check input{display:inline;width:auto;min-height:0;margin-right:6px}
`;
