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
import type { CatalogEntry, DraftLine, LineEdit } from "../../../domain/receipt-draft";
import { type ConsoleEnv, INVOICE_UPLOAD_PATH, memberContext, requireOwner } from "./auth";

const NOTICES = {
  tamano: "La foto pesa más de 10 MB. Mandá una más liviana.",
  vacia: "No llegó ninguna foto. Elegí la foto de la factura.",
  tipo: "Mandá una foto JPG, PNG o WEBP de la factura.",
  pdf: "Todavía no leo PDF. Mandá una foto o una captura de la factura.",
  ilegible: "No pude leer esa factura. Probá con otra foto, más cerca y con buena luz.",
  repetida: "Esa factura ya la habías subido. Aquí está.",
  guardado: "Cambios guardados. Revisalos y aprobá la factura.",
  datos: "Revisá la línea marcada: nombre (hasta 120 letras), cantidad como 12 o 1.5, costo como 15.50 o vacío.",
  lineas: "La factura necesita al menos una línea.",
  cambio: "La factura cambió mientras tanto. Revisá la versión nueva antes de aprobar.",
  cantidad: "Falta la cantidad en una línea. Escribila y guardá los cambios.",
  nombre: "Ya hay un producto con el nombre de una línea nueva. Elegilo en la lista y guardá los cambios.",
  aprobada: "Factura registrada. El inventario ya está al día.",
  yaaprobada: "Esa factura ya quedó registrada. No la repetí.",
  rechazada: "Factura rechazada.",
  yarechazada: "Esa factura ya estaba rechazada.",
  motivo: "Escribí el motivo del rechazo (hasta 200 letras).",
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
    return c.html(listPage(noticeOf(c), await c.get("runtime").receipts.list(member), member.nowMs));
  });

  app.get("/facturas/nueva", (c) => c.html(uploadPage(noticeOf(c), c.get("csrf"))));

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
    if (draft === null) return c.html(listPage("Esa factura no está en la lista.", [], member.nowMs), 404);
    const catalog = await c.get("runtime").receipts.catalog(member);
    return c.html(reviewPage(noticeOf(c), draft, catalog, member.nowMs, c.get("csrf"), c.req.query("linea")));
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

// ---------------------------------------------------------------------------------------------
// Rendering. `html` escapes every interpolated string.

function shell(title: string, notice: string | null, body: unknown) {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>${title}</h1><a href="/console/facturas">Facturas</a></header>
${notice === null ? "" : html`<p class="notice" role="status">${notice}</p>`}
${body}
</body>
</html>`;
}

function statusOf(draft: ConsoleReceiptDraft, nowMs: number): string {
  if (draft.receipt !== null) return draft.receipt.cancelled ? "Anulada" : "Registrada";
  if (draft.declined !== null) return "Rechazada";
  if (draft.state !== "pending" || draft.expiresAtMs <= nowMs) return "Vencida";
  return "Por revisar";
}

function listPage(notice: string | null, drafts: readonly ConsoleReceiptDraft[], nowMs: number) {
  return shell(
    "Facturas",
    notice,
    html`<p><a class="button primary" href="${INVOICE_UPLOAD_PATH}">Subir factura</a></p>
${drafts.length === 0
  ? html`<p class="empty">Todavía no hay facturas.</p>`
  : html`<ul class="cards">${drafts.map(
      (draft) => html`<li><a href="/console/facturas/${draft.id}"><strong>${draft.body.supplier ?? "Proveedor sin nombre"}</strong>
<span>${draft.body.lines.length} líneas · ${statusOf(draft, nowMs)}</span></a></li>`,
    )}</ul>`}`,
  );
}

function uploadPage(notice: string | null, csrf: string) {
  return shell(
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

function reviewPage(notice: string | null, draft: ConsoleReceiptDraft, catalog: readonly CatalogEntry[], nowMs: number, csrf: string, badLine: string | undefined) {
  const status = statusOf(draft, nowMs);
  const open = status === "Por revisar";
  const names = new Map(catalog.map((product) => [product.id, product.name]));
  return shell(
    "Revisar factura",
    notice,
    html`<div class="review">
<figure class="photo"><img src="/console/facturas/${draft.id}/imagen" alt="Foto de la factura"></figure>
<section class="card">
<p class="status">${status}${draft.declined === null ? "" : html`: ${draft.declined.reason}`}</p>
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
    (line) => html`<li>${quantityText(line.qtyMilli) || "?"} × ${line.name} · ${line.unitCostCentavos === null ? "sin costo" : `${formatLempiras(line.unitCostCentavos)} c/u`} · ${matchText(line, names)}</li>`,
  )}</ul>`;
}

function editForm(draft: ConsoleReceiptDraft, catalog: readonly CatalogEntry[], csrf: string, badLine: string | undefined) {
  return html`<form method="post" action="/console/facturas/${draft.id}/editar">
<label>Proveedor<input name="proveedor" maxlength="120" value="${draft.body.supplier ?? ""}"></label>
${draft.body.date === null ? "" : html`<p class="meta">Fecha: ${draft.body.date}</p>`}
<input type="hidden" name="lineas" value="${draft.body.lines.length}">
${draft.body.lines.map(
  (line, n) => html`<fieldset class="${badLine === String(n + 1) ? "bad" : ""}"><legend>Línea ${n + 1}${line.match === null ? html` <em>nuevo</em>` : ""}</legend>
<label>Producto en la factura<input name="nombre_${n}" maxlength="120" value="${line.name}" required></label>
<div class="pair"><label>Cantidad${line.unit === null ? "" : ` (${line.unit})`}<input name="cantidad_${n}" inputmode="decimal" value="${quantityText(line.qtyMilli)}" placeholder="?"></label>
<label>Costo c/u (L)<input name="costo_${n}" inputmode="decimal" value="${costText(line.unitCostCentavos)}" placeholder="sin costo"></label></div>
<label>Producto de la tienda<select name="producto_${n}">
<option value="nuevo" ${line.match === null ? "selected" : ""}>Nuevo: crear "${line.name}"</option>
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

const STYLE = `
*{box-sizing:border-box}body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#f4f4f2;color:#1b1b1b}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#1f3d2b;color:#fff}
h1{font-size:18px;margin:0}header a{color:#fff}
.notice{margin:10px;padding:10px;border-radius:8px;background:#fff3cd;border:1px solid #e0c060}
.empty{padding:20px;text-align:center;color:#666}.meta{font-size:14px;color:#555}
.card,.cards li{margin:10px;padding:12px;border-radius:10px;background:#fff}.cards{list-style:none;margin:0;padding:0}
.cards a{display:flex;justify-content:space-between;gap:8px;color:inherit;text-decoration:none}
.review{display:flex;flex-wrap:wrap}.photo{flex:1 1 320px;margin:10px}.photo img{width:100%;border-radius:10px;background:#ddd}
.review .card{flex:1 1 320px}.status{font-weight:600}
fieldset{border:1px solid #ddd;border-radius:8px;margin:8px 0}fieldset.bad{border-color:#b33;background:#fdf0f0}
em{font-style:normal;font-size:12px;background:#f0b400;color:#000;padding:1px 6px;border-radius:4px}
label{display:block;margin:6px 0}.check{display:flex;gap:6px;align-items:center}.pair{display:flex;gap:8px}.pair label{flex:1}
input:not([type=checkbox]),select{display:block;width:100%;min-height:44px;font-size:16px;padding:6px;border:1px solid #888;border-radius:8px}
.lines{padding-left:18px}.decide{display:flex;flex-direction:column;gap:10px;margin-top:12px}form{margin:0}
button,.button{display:inline-block;min-height:44px;min-width:88px;font-size:16px;border-radius:8px;border:1px solid #888;background:#fff;padding:8px 12px;text-align:center;text-decoration:none;color:inherit}
.primary{width:100%;background:#2f6f45;color:#fff;border:0}.danger{width:100%;border-color:#b33;color:#b33}
`;
