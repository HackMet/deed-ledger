/**
 * Mi tienda (K6, owner only): the store's name, kind, address, delivery zones and the notes for the
 * assistant, with the hours and delivery fee the assistant answers from. Those two are kept in the
 * store's setup and changed on Tienda's "Horario y envío" page, so this screen shows them and links
 * there: one place to change the hours. Saving here goes to `BusinessService`, which writes one
 * `business_info` fact; the hours it saved before still ride along in hidden fields, so a save here
 * never changes them.
 */
import type { Context, Hono } from "hono";
import { html } from "hono/html";
import { type BusinessInfo, type BusinessInfoField, LIMITS, type StoreHour } from "../../../domain/business-info";
import { formatLempiras } from "../../../domain/contract/numbers";
import type { Centavos } from "../../../domain/contract/numbers";
import type { StoreHours } from "../../../domain/contract/outcomes";
import { formatStoreHours } from "../../../domain/store-hours";
import { type ConsoleEnv, memberContext, requireOwner } from "./auth";
import { shell } from "./layout";

const PATH = "/console/negocio";
const HOURS_PATH = "/console/tienda/horario";

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
    const member = c.get("member");
    const [info, setup] = await Promise.all([c.get("runtime").business.context.current(member), c.get("runtime").storeSetup.settings(member)]);
    const notice = c.req.query("aviso");
    return c.html(page(c, notice !== undefined && Object.hasOwn(NOTICES, notice) ? NOTICES[notice as Notice] : null, info, setup));
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

interface Setup {
  readonly hours: StoreHours | null;
  readonly deliveryFee: Centavos | null;
}

/** What the assistant tells customers about the fee: "Envío gratis", "Envío L 25", or not said yet. */
function feeText(fee: Centavos | null): string {
  if (fee === null) return "Envío: todavía sin precio.";
  return fee === 0 ? "Envío gratis." : `Envío: ${formatLempiras(fee)}.`;
}

function page(c: Context<ConsoleEnv>, notice: string | null, info: BusinessInfo | null, setup: Setup) {
  const hourOf = (day: number): StoreHour | undefined => info?.hours.find((h) => h.day === day);
  return shell(c, {
    title: "Mi tienda",
    path: PATH,
    notice,
    style: STYLE,
    body: html`<section class="card hours"><h2>Horario y envío</h2>
<p>${setup.hours === null ? "Todavía no hay horario." : formatStoreHours(setup.hours)}</p>
<p class="muted">${feeText(setup.deliveryFee)} Es lo que el asistente les dice a los clientes.</p>
<a class="button" href="${HOURS_PATH}">Cambiar horario y envío</a></section>
<form class="card" method="post" action="${PATH}">
<label>Nombre de la tienda<input name="nombre" maxlength="${LIMITS.name}" value="${info?.name ?? ""}" required></label>
<label>Tipo de tienda<input name="tipo" maxlength="${LIMITS.storeType}" value="${info?.storeType ?? ""}" placeholder="Mercadito, farmacia…"></label>
<p class="note">El horario se cambia en <a href="${HOURS_PATH}">Horario y envío</a>.</p>
<fieldset hidden><legend>Horario (dejá vacío el día que no abrís)</legend>
${DAYS.map(
  (label, day) => html`<div class="day"><span>${label}</span><input type="time" name="abre${day}" value="${hourOf(day)?.opens ?? ""}" aria-label="${label}: abre"><input type="time" name="cierra${day}" value="${hourOf(day)?.closes ?? ""}" aria-label="${label}: cierra"></div>`,
)}
</fieldset>
<label>Dirección<input name="direccion" maxlength="${LIMITS.address}" value="${info?.address ?? ""}"></label>
<label>Zonas de entrega<textarea name="zonas" maxlength="${LIMITS.deliveryZones}" rows="2">${info?.deliveryZones ?? ""}</textarea></label>
<label>Notas para el asistente<textarea name="notas" maxlength="${LIMITS.assistantNotes}" rows="4">${info?.assistantNotes ?? ""}</textarea></label>
<input type="hidden" name="csrf" value="${c.get("csrf")}">
<button class="primary">Guardar</button>
</form>`,
  });
}

/** The hours card and the form; the shared layout does the rest. The day rows only show if unhidden. */
const STYLE = `
.hours p{margin:6px 0}.hours .button{width:100%;margin-top:10px}
.note{margin:14px 0 0;padding:10px 12px;border-radius:10px;background:var(--sage);font-size:15px}
.day{display:grid;grid-template-columns:76px minmax(0,1fr) minmax(0,1fr);gap:4px;align-items:center;margin:0;padding:10px 0;border-bottom:1px solid var(--line);font-size:15px;font-weight:700}
.day:last-of-type{border-bottom:0}
@media (max-width:479px){.day{grid-template-columns:1fr 1fr;gap:6px}.day span{grid-column:1/-1}}
.day input{min-width:0;margin-top:0;padding:10px 4px 10px 8px;font-size:16px}
fieldset{padding:8px 6px 10px}
`;
