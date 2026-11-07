/**
 * The Facturas screens (K14), owner only: upload a supplier invoice photo, review its draft beside the
 * photo (edit the lines, which saves the next revision), then Aprobar ✓ or Rechazar ✗ with a reason,
 * and later "Anular factura". Every form carries the revision on screen, so an approval of an older
 * revision is refused instead of saving something the owner didn't see. What the invoice says is shown
 * as text only (`html` escapes it): a line that reads like an instruction stays a line name.
 */
import { type Context, type Hono } from "hono";
import { html } from "hono/html";
import type { ConsoleReceiptDraft } from "../../../application/receipts";
import { formatLempiras } from "../../../domain/contract/numbers";
import { isDemoBusiness } from "../../../domain/demo";
import type { CatalogEntry, DraftLine, LineEdit } from "../../../domain/receipt-draft";
import { type ConsoleEnv, INVOICE_UPLOAD_PATH, memberContext, requireOwner } from "./auth";
import { shell } from "./layout";

const NOTICES = {
  tamano: "La foto pesa más de 10 MB. Mandá una que pese menos.",
  vacia: "No llegó ninguna foto. Elegí la foto de la factura.",
  tipo: "Mandá una foto JPG, PNG o WEBP de la factura.",
  pdf: "Todavía no leo PDF. Mandá una foto o una captura de la factura.",
  ilegible: "No pude leer esa factura. Probá con otra foto, más cerca y con buena luz.",
  repetida: "Esa factura ya la habías subido. Aquí está.",
  guardado: "Cambios guardados. Revisalos y aprobá la factura.",
  datos: "Revisá la línea marcada: nombre (hasta 120 caracteres), cantidad como 12 o 1.5, costo como 15.50 o vacío.",
  lineas: "La factura necesita al menos una línea.",
  cambio: "La factura cambió mientras tanto. Revisá la versión nueva antes de aprobar.",
  cantidad: "Falta la cantidad en una línea. Escribila y guardá los cambios.",
  nombre: "Ya hay un producto con el nombre de una línea nueva. Elegilo en la lista y guardá los cambios.",
  aprobada: "Factura registrada. El inventario ya está al día.",
  yaaprobada: "Esa factura ya quedó registrada. No la repetí.",
  rechazada: "Factura rechazada.",
  yarechazada: "Esa factura ya estaba rechazada.",
  motivo: "Escribí el motivo del rechazo (hasta 200 caracteres).",
  estado: "Esa factura ya no se puede cambiar.",
  anulada: "Factura anulada. El inventario volvió a como estaba antes de ella.",
  yaanulada: "Esa factura ya estaba anulada. No hice ningún cambio.",
  vendido: "No puedo anularla: parte de esos productos ya salió del inventario.",
} as const;
type Notice = keyof typeof NOTICES;

const ID = /^inv_[0-9a-f]{40}$/;
const MAX_LINES_FORM = 50;

export function facturasScreen(app: Hono<ConsoleEnv>) {
  const go = (c: Context<ConsoleEnv>, path: string, notice: Notice | null, extra = "") =>
    c.redirect(`/console/facturas${path}${notice === null ? "" : `?aviso=${notice}`}${extra}`, 303);
  const noticeOf = (c: Context<ConsoleEnv>): string | null => {
    const key = c.req.query("aviso");
    return key !== undefined && Object.hasOwn(NOTICES, key) ? NOTICES[key as Notice] : null;
  };
  const draftId = (c: Context<ConsoleEnv>): string | null => {
    const id = c.req.param("id");
    return id !== undefined && ID.test(id) ? id : null;
  };
  const revisionOf = (form: Record<string, unknown>): number | null => {
    const revision = Number(form["revision"]);
    return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
  };

  app.use("/facturas", requireOwner);
  app.use("/facturas/*", requireOwner);

  app.get("/facturas", async (c) => {
    const member = memberContext(c);
    return c.html(await listPage(c, noticeOf(c), await c.get("runtime").receipts.list(member), member.nowMs));
  });

  app.get("/facturas/nueva", async (c) => c.html(await uploadPage(c, noticeOf(c))));

  app.post("/facturas/nueva", async (c) => {
    const form = await c.req.parseBody();
    const file = form["foto"];
    if (!(file instanceof File)) return c.redirect(`${INVOICE_UPLOAD_PATH}?aviso=vacia`, 303);
    const member = memberContext(c);
    const result = await c.get("runtime").receipts.upload(member, { bytes: await file.arrayBuffer() });
    c.get("runtime").deps.log.info("invoice_upload", { businessId: member.businessId, outcome: result.type });
    if (result.type === "drafted") return go(c, `/${result.draftId}`, null);
    if (result.type === "exists") return go(c, `/${result.draftId}`, "repetida");
    const notice: Notice =
      result.reason === "too_large" ? "tamano" : result.reason === "empty" ? "vacia" : result.reason === "pdf" ? "pdf" : result.reason === "unreadable" ? "ilegible" : "tipo";
    return c.redirect(`${INVOICE_UPLOAD_PATH}?aviso=${notice}`, 303);
  });

  app.get("/facturas/:id/imagen", async (c) => {
    const id = draftId(c);
    const image = id === null ? null : await c.get("runtime").receipts.image(memberContext(c), id);
    if (image === null) return c.text("Not found", 404);
    return c.body(image.bytes, 200, {
      "content-type": image.contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
  });

  app.get("/facturas/:id", async (c) => {
    const id = draftId(c);
    const member = memberContext(c);
    const draft = id === null ? null : await c.get("runtime").receipts.get(member, id);
    if (draft === null) return c.html(notFoundPage(c), 404);
    const catalog = await c.get("runtime").receipts.catalog(member);
    return c.html(await reviewPage(c, noticeOf(c), draft, catalog, member.nowMs, c.req.query("linea")));
  });

  app.post("/facturas/:id/editar", async (c) => {
    const id = draftId(c);
    if (id === null) return c.text("Bad request", 400);
    const form = await c.req.parseBody();
    const revision = revisionOf(form);
    const count = Number(form["lineas"]);
    if (revision === null || !Number.isSafeInteger(count) || count < 0 || count > MAX_LINES_FORM) return c.text("Bad request", 400);
    const text = (name: string) => (typeof form[name] === "string" ? (form[name] as string) : "");
    const lines: LineEdit[] = Array.from({ length: count }, (_, n) => ({
      name: text(`nombre_${n}`),
      qty: text(`cantidad_${n}`),
      cost: text(`costo_${n}`),
      product: text(`producto_${n}`) || "auto",
      remove: form[`quitar_${n}`] !== undefined,
    }));
    const result = await c.get("runtime").receipts.edit(memberContext(c), id, revision, { supplier: text("proveedor"), lines });
    if (result.type === "revised") return go(c, `/${id}`, "guardado");
    if (result.type === "invalid") {
      const { error } = result;
      return go(c, `/${id}`, error.field === "lines" ? "lineas" : "datos", error.line === null ? "" : `&linea=${error.line}`);
    }
    return go(c, result.reason === "not_found" ? "" : `/${id}`, result.reason === "stale" ? "cambio" : "estado");
  });

  app.post("/facturas/:id/aprobar", async (c) => {
    const id = draftId(c);
    const revision = revisionOf(await c.req.parseBody());
    if (id === null || revision === null) return c.text("Bad request", 400);
    const member = memberContext(c);
    const result = await c.get("runtime").receipts.approve(member, id, revision);
    c.get("runtime").deps.log.info("invoice_approve", { businessId: member.businessId, draftId: id, outcome: result.type });
    if (result.type === "approved") return go(c, `/${id}`, "aprobada");
    if (result.type === "duplicate") return go(c, `/${id}`, "yaaprobada");
    const line = result.line === undefined ? "" : `&linea=${result.line}`;
    switch (result.reason) {
      case "stale":
        return go(c, `/${id}`, "cambio");
      case "missing_qty":
        return go(c, `/${id}`, "cantidad", line);
      case "name_taken":
        return go(c, `/${id}`, "nombre", line);
      default:
        return go(c, `/${id}`, "estado");
    }
  });

  app.post("/facturas/:id/rechazar", async (c) => {
    const id = draftId(c);
    const form = await c.req.parseBody();
    const revision = revisionOf(form);
    if (id === null || revision === null) return c.text("Bad request", 400);
    const member = memberContext(c);
    const result = await c.get("runtime").receipts.decline(member, id, revision, form["motivo"]);
    c.get("runtime").deps.log.info("invoice_decline", { businessId: member.businessId, draftId: id, outcome: result.type });
    if (result.type === "declined") return go(c, `/${id}`, "rechazada");
    if (result.type === "duplicate") return go(c, `/${id}`, "yarechazada");
    return go(c, `/${id}`, result.reason === "reason" ? "motivo" : result.reason === "stale" ? "cambio" : "estado");
  });

  app.post("/facturas/:id/anular", async (c) => {
    const id = draftId(c);
    if (id === null) return c.text("Bad request", 400);
    const member = memberContext(c);
    const result = await c.get("runtime").receipts.cancel(member, id);
    c.get("runtime").deps.log.info("invoice_cancel", { businessId: member.businessId, draftId: id, outcome: result.type });
    if (result.type === "cancelled") return go(c, `/${id}`, "anulada");
    if (result.type === "duplicate") return go(c, `/${id}`, "yaanulada");
    return go(c, `/${id}`, result.reason === "stock_used" ? "vendido" : "estado");
  });
}

const LIST_PATH = "/console/facturas";
export const INVOICE_LIST_PATH = LIST_PATH;
/** A demo store takes no photos (D-64); its seeded invoices can still be reviewed. */
const DEMO_NO_UPLOADS = "En la demostración no se suben fotos de facturas. Abrí una de la lista para revisarla.";

// ---------------------------------------------------------------------------------------------
// Rendering. `html` escapes every interpolated string.

/** An invoice screen in the console's shared layout; the list is the Facturas entry, the others go back to it. */
function page(c: Context<ConsoleEnv>, title: string, notice: string | null, body: unknown) {
  const isList = title === "Facturas";
  return shell(c, {
    title,
    path: c.req.path,
    tab: LIST_PATH,
    ...(isList ? {} : { back: LIST_PATH }),
    notice,
    style: STYLE,
    body,
  });
}

function statusOf(draft: ConsoleReceiptDraft, nowMs: number): string {
  if (draft.receipt !== null) return draft.receipt.cancelled ? "Anulada" : "Registrada";
  if (draft.declined !== null) return "Rechazada";
  if (draft.state !== "pending" || draft.expiresAtMs <= nowMs) return "Vencida";
  return "Por revisar";
}

const isDemo = (c: Context<ConsoleEnv>) => isDemoBusiness(c.get("member").businessId);

function listPage(c: Context<ConsoleEnv>, notice: string | null, drafts: readonly ConsoleReceiptDraft[], nowMs: number) {
  return page(
    c,
    "Facturas",
    notice,
    html`${isDemo(c) ? html`<p class="meta">${DEMO_NO_UPLOADS}</p>` : html`<p><a class="button primary" href="${INVOICE_UPLOAD_PATH}">Subir factura</a></p>`}
${drafts.length === 0
  ? html`<p class="empty">Todavía no hay facturas.</p>`
  : html`<ul class="cards">${drafts.map(
      (draft) => html`<li><a href="/console/facturas/${draft.id}"><strong>${draft.body.supplier ?? "Proveedor sin nombre"}</strong>
<span><span>${draft.body.lines.length}</span> ${draft.body.lines.length === 1 ? "línea" : "líneas"} · ${statusOf(draft, nowMs)}</span></a></li>`,
    )}</ul>`}`,
  );
}

/** An invoice ID that isn't this store's (or isn't anymore): only that, and the way back. */
function notFoundPage(c: Context<ConsoleEnv>) {
  return page(c, "Revisar factura", "Esa factura no está en la lista.", html`<p><a class="button" href="${LIST_PATH}">Ver todas las facturas</a></p>`);
}

function uploadPage(c: Context<ConsoleEnv>, notice: string | null) {
  const csrf = c.get("csrf");
  if (isDemo(c)) {
    return page(c, "Subir factura", notice, html`<p class="meta">${DEMO_NO_UPLOADS}</p><p><a class="button" href="${LIST_PATH}">Ver las facturas</a></p>`);
  }
  return page(
    c,
    "Subir factura",
    notice,
    html`<form class="card" method="post" action="${INVOICE_UPLOAD_PATH}" enctype="multipart/form-data">
<label>Foto de la factura (JPG, PNG o WEBP, hasta 10 MB)<input type="file" name="foto" accept="image/jpeg,image/png,image/webp" capture="environment" required></label>
<input type="hidden" name="csrf" value="${csrf}">
<button class="primary">Leer factura</button>
</form>`,
  );
}

const quantityText = (milli: number | null) => {
  if (milli === null) return "";
  const fraction = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return fraction === "" ? String(Math.trunc(milli / 1000)) : `${Math.trunc(milli / 1000)}.${fraction}`;
};
const costText = (centavos: number | null) => (centavos === null ? "" : `${Math.trunc(centavos / 100)}.${String(centavos % 100).padStart(2, "0")}`);

function reviewPage(c: Context<ConsoleEnv>, notice: string | null, draft: ConsoleReceiptDraft, catalog: readonly CatalogEntry[], nowMs: number, badLine: string | undefined) {
  const csrf = c.get("csrf");
  const status = statusOf(draft, nowMs);
  const open = status === "Por revisar";
  const names = new Map(catalog.map((product) => [product.id, product.name]));
  return page(
    c,
    "Revisar factura",
    notice,
    html`<div class="review">
<figure class="photo"><img src="/console/facturas/${draft.id}/imagen" alt="Foto de la factura"></figure>
<section class="card">
<p class="status"><span>${status}</span>${draft.declined === null ? "" : html`: <span>${draft.declined.reason}</span>`}</p>
${open ? editForm(draft, catalog, csrf, badLine) : readOnly(draft, names)}
${open ? decisionForms(draft, csrf) : ""}
${draft.receipt !== null && !draft.receipt.cancelled
  ? html`<form method="post" action="/console/facturas/${draft.id}/anular" onsubmit="return confirm('¿Anular esta factura? El inventario vuelve a como estaba.')"><input type="hidden" name="csrf" value="${csrf}"><button class="danger">Anular factura</button></form>`
  : ""}
</section>
</div>`,
  );
}

function matchText(line: DraftLine, names: ReadonlyMap<string, string>): string {
  return line.match === null ? "nuevo" : (names.get(line.match.productId) ?? "producto");
}

function readOnly(draft: ConsoleReceiptDraft, names: ReadonlyMap<string, string>) {
  return html`<p><strong>${draft.body.supplier ?? "Proveedor sin nombre"}</strong>${draft.body.date === null ? "" : html` · ${draft.body.date}`}</p>
<ul class="lines">${draft.body.lines.map(
    (line) => html`<li>${quantityText(line.qtyMilli) || "?"} × ${line.name} · ${line.unitCostCentavos === null ? html`<span>sin costo</span>` : html`${formatLempiras(line.unitCostCentavos)} <span>c/u</span>`} · <span>${matchText(line, names)}</span></li>`,
  )}</ul>`;
}

function editForm(draft: ConsoleReceiptDraft, catalog: readonly CatalogEntry[], csrf: string, badLine: string | undefined) {
  return html`<form method="post" action="/console/facturas/${draft.id}/editar">
<label>Proveedor<input name="proveedor" maxlength="120" value="${draft.body.supplier ?? ""}"></label>
${draft.body.date === null ? "" : html`<p class="meta">Fecha: <span>${draft.body.date}</span></p>`}
<input type="hidden" name="lineas" value="${draft.body.lines.length}">
${draft.body.lines.map(
  (line, n) => html`<fieldset class="${badLine === String(n + 1) ? "bad" : ""}"><legend>Línea <span>${n + 1}</span>${line.match === null ? html` <em>nuevo</em>` : ""}</legend>
<label>Producto en la factura<input name="nombre_${n}" maxlength="120" value="${line.name}" required></label>
<div class="pair"><label>Cantidad${line.unit === null ? "" : html` <span>(${line.unit})</span>`}<input name="cantidad_${n}" inputmode="decimal" value="${quantityText(line.qtyMilli)}" placeholder="?"></label>
<label>Costo c/u (L)<input name="costo_${n}" inputmode="decimal" value="${costText(line.unitCostCentavos)}" placeholder="sin costo"></label></div>
<label>Producto de la tienda<select name="producto_${n}">
<option value="nuevo" ${line.match === null ? "selected" : ""}>Crear como producto nuevo</option>
${catalog.map((product) => html`<option value="${product.id}" ${line.match?.productId === product.id ? "selected" : ""}>${product.name}</option>`)}
</select></label>
<label class="check"><input type="checkbox" name="quitar_${n}"> Quitar esta línea</label>
</fieldset>`,
)}
<input type="hidden" name="revision" value="${draft.revision}"><input type="hidden" name="csrf" value="${csrf}">
<button>Guardar cambios</button>
</form>`;
}

function decisionForms(draft: ConsoleReceiptDraft, csrf: string) {
  const hidden = html`<input type="hidden" name="revision" value="${draft.revision}"><input type="hidden" name="csrf" value="${csrf}">`;
  return html`<div class="decide">
<form method="post" action="/console/facturas/${draft.id}/aprobar">${hidden}<button class="primary">Aprobar ✓</button></form>
<form method="post" action="/console/facturas/${draft.id}/rechazar">${hidden}
<label>Motivo del rechazo<input name="motivo" maxlength="200" required></label>
<button class="danger">Rechazar ✗</button></form>
</div>`;
}

/** This screen's part, on top of the shared layout: the invoice list and the photo-beside-form review. */
const STYLE = `
.meta{font-size:15px;color:var(--mute)}
main>p{margin:14px}
.cards li{margin:12px 14px;border:1px solid var(--line);border-radius:18px;background:var(--card)}
.cards a{display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:64px;padding:14px 16px;color:inherit;text-decoration:none}
.cards a strong{font-size:18px;font-weight:800}.cards a span{color:var(--mute);font-size:15px;text-align:right}
.review{display:flex;flex-wrap:wrap}.photo{flex:1 1 320px;margin:12px 14px}.photo img{width:100%;border-radius:18px;background:var(--cream)}
.review .card{flex:1 1 320px}.status{font-weight:800;font-size:18px}
fieldset.bad{border-color:var(--warn);background:var(--redsoft)}
em{font-style:normal;font-size:12px;font-weight:800;background:var(--mango);color:var(--ink);padding:2px 7px;border-radius:7px}
.check{display:flex;align-items:center;min-height:48px}.pair{display:flex;gap:8px}.pair label{flex:1}
.lines{padding-left:4px}.lines li{padding:6px 0;border-bottom:1px solid var(--line)}
.decide{display:flex;flex-direction:column;gap:10px;margin-top:14px}
a.button.primary{display:flex}
button.danger,a.button.danger{width:100%}
form>button:not(.primary):not(.danger){width:100%;margin-top:12px}
`;
