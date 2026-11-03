/**
 * The Business screen (K6, owner only): the store's name, kind, hours, address, delivery zones and the
 * notes for the assistant. Saving goes to `BusinessService`, which writes one `business_info` fact.
 */
import { type Hono } from "hono";
import { html } from "hono/html";
import { type BusinessInfo, type BusinessInfoField, LIMITS, type StoreHour } from "../../../domain/business-info";
import { type ConsoleEnv, memberContext, requireOwner } from "./auth";

const DAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"] as const;

const NOTICES = {
  guardado: "Listo, guardamos los datos de la tienda.",
  repetido: "Eso ya se guardó hace un momento. Esperá un minuto para cambiarlo otra vez.",
  name: "Escribí el nombre de la tienda (hasta 120 letras).",
  storeType: `El tipo de tienda es muy largo (hasta ${LIMITS.storeType} letras).`,
  hours: "Revisá el horario: cada día necesita hora de apertura y de cierre (como 08:00 y 18:00), y abrir antes de cerrar.",
  address: `La dirección es muy larga (hasta ${LIMITS.address} letras).`,
  deliveryZones: `Las zonas de entrega son muy largas (hasta ${LIMITS.deliveryZones} letras).`,
  assistantNotes: `Las notas para el asistente son muy largas (hasta ${LIMITS.assistantNotes} letras).`,
  permiso: "Esto es solo para el dueño.",
} as const satisfies Record<string, string>;
type Notice = keyof typeof NOTICES;

const field = (form: Record<string, unknown>, name: string): string => (typeof form[name] === "string" ? (form[name] as string) : "");

/** One row per day typed in the form; a day with both boxes empty is a closed day. A half-filled day is kept so validation refuses it. */
function hoursFrom(form: Record<string, unknown>): unknown[] {
  const rows: unknown[] = [];
  for (let day = 0; day < 7; day++) {
    const opens = field(form, `abre${day}`).trim();
    const closes = field(form, `cierra${day}`).trim();
    if (opens === "" && closes === "") continue;
    rows.push({ day, opens, closes });
  }
  return rows;
}

export function negocioScreen(app: Hono<ConsoleEnv>) {
  app.get("/negocio", requireOwner, async (c) => {
    const info = await c.get("runtime").business.context.current(c.get("member"));
    const notice = c.req.query("aviso");
    return c.html(page(notice !== undefined && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as Notice] : null, info, c.get("csrf")));
  });

  app.post("/negocio", requireOwner, async (c) => {
    const form = await c.req.parseBody();
    const result = await c.get("runtime").business.service.recordBusinessInfo(memberContext(c), {
      name: field(form, "nombre"),
      storeType: field(form, "tipo"),
      hours: hoursFrom(form),
      address: field(form, "direccion"),
      deliveryZones: field(form, "zonas"),
      assistantNotes: field(form, "notas"),
    });
    const notice: Notice =
      result.type === "saved" ? "guardado" : result.type === "duplicate" ? "repetido" : result.type === "refused" ? "permiso" : (result.field satisfies BusinessInfoField);
    return c.redirect(`/console/negocio?aviso=${notice}`, 303);
  });
}

function page(notice: string | null, info: BusinessInfo | null, csrf: string) {
  const hourOf = (day: number): StoreHour | undefined => info?.hours.find((h) => h.day === day);
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mi tienda</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>Mi tienda</h1><a href="/console/preparacion">Preparación</a></header>
${notice === null ? "" : html`<p class="notice" role="status">${notice}</p>`}
<form method="post" action="/console/negocio">
<label>Nombre de la tienda<input name="nombre" maxlength="${LIMITS.name}" value="${info?.name ?? ""}" required></label>
<label>Tipo de tienda<input name="tipo" maxlength="${LIMITS.storeType}" value="${info?.storeType ?? ""}" placeholder="Mercadito, farmacia…"></label>
<fieldset><legend>Horario (dejá vacío el día que no abrís)</legend>
${DAYS.map(
  (label, day) => html`<div class="day"><span>${label}</span><input type="time" name="abre${day}" value="${hourOf(day)?.opens ?? ""}" aria-label="${label}: abre"><input type="time" name="cierra${day}" value="${hourOf(day)?.closes ?? ""}" aria-label="${label}: cierra"></div>`,
)}
</fieldset>
<label>Dirección<input name="direccion" maxlength="${LIMITS.address}" value="${info?.address ?? ""}"></label>
<label>Zonas de entrega<textarea name="zonas" maxlength="${LIMITS.deliveryZones}" rows="2">${info?.deliveryZones ?? ""}</textarea></label>
<label>Notas para el asistente<textarea name="notas" maxlength="${LIMITS.assistantNotes}" rows="4">${info?.assistantNotes ?? ""}</textarea></label>
<input type="hidden" name="csrf" value="${csrf}">
<button class="primary">Guardar</button>
</form>
</body>
</html>`;
}

const STYLE = `
*{box-sizing:border-box}body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#f4f4f2;color:#1b1b1b}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#1f3d2b;color:#fff}
h1{font-size:18px;margin:0}header a{color:#fff}
.notice{margin:10px;padding:10px;border-radius:8px;background:#fff3cd;border:1px solid #e0c060}
form{margin:10px;padding:12px;border-radius:10px;background:#fff}
label{display:block;margin:8px 0}input,textarea{display:block;width:100%;min-height:44px;font:16px system-ui,sans-serif;padding:6px;border:1px solid #888;border-radius:8px}
fieldset{border:1px solid #ddd;border-radius:8px;margin:8px 0}.day{display:grid;grid-template-columns:90px 1fr 1fr;gap:6px;align-items:center;margin:4px 0}
button.primary{width:100%;min-height:48px;margin-top:8px;font-size:17px;background:#2f6f45;color:#fff;border:0;border-radius:8px}
`;
