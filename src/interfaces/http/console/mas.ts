/**
 * Más (wireframe C7): what isn't a daily screen, one entry per job. Anotar is where things are
 * entered, the tabs hold the lists, and Pendientes (the bell) is the one inbox, so nothing here
 * repeats them: prices live in the Productos tab and a new invoice photo starts in Anotar. Deed en
 * vivo is every order's graph and verifications as they happen. Staff see only what isn't the owner's.
 * A phone reaches these from the Más tab; a wide screen's sidebar lists them itself (layout.ts).
 * "Probar como cliente" is on Inicio, where it's seen first.
 */
import type { Hono } from "hono";
import { html } from "hono/html";
import { PRIVACY_PATH } from "../../../domain/customer-controls";
import { isDemoBusiness } from "../../../domain/demo";
import type { ConsoleEnv } from "./auth";
import { EMPLEADOS_PATH, MAS_PATH, shell } from "./layout";

interface Option {
  readonly label: string;
  readonly hint: string;
  readonly href: string;
  readonly ownerOnly: boolean;
}

const OPTIONS: readonly Option[] = [
  // Name, address and notes, with the hours and delivery the assistant answers from (Tienda's setup).
  { label: "Mi tienda", hint: "Nombre, horario, envío, dirección y notas.", href: "/console/negocio", ownerOnly: true },
  { label: "Empleados", hint: "Invitar, permisos y quitar.", href: EMPLEADOS_PATH, ownerOnly: true },
  // The list to review and approve; a new invoice photo is taken from Anotar.
  { label: "Facturas", hint: "La lista de facturas de proveedores.", href: "/console/facturas", ownerOnly: true },
  { label: "Deed en vivo", hint: "El grafo de cada pedido y cada verificación, al momento.", href: "/console/deed/en-vivo", ownerOnly: false },
  { label: "Aviso de privacidad", hint: "Lo que ven los clientes.", href: PRIVACY_PATH, ownerOnly: false },
];

export function masScreen(app: Hono<ConsoleEnv>) {
  app.get("/mas", async (c) => {
    const member = c.get("member");
    const isOwner = member.role === "owner";
    // A demo store can't add staff (D-64), so it isn't offered.
    const demo = isDemoBusiness(member.businessId);
    const options = OPTIONS.filter((option) => (isOwner || !option.ownerOnly) && !(demo && option.href === EMPLEADOS_PATH));
    return c.html(
      shell(c, {
        title: "Más",
        path: MAS_PATH,
        style: STYLE,
        body: html`<ul class="options">${options.map(row)}</ul>`,
      }),
    );
  });
}

function row(option: Option) {
  return html`<li><a href="${option.href}"><span class="label">${option.label}</span><span class="hint">${option.hint}</span><span class="go" aria-hidden="true">›</span></a></li>`;
}

/** One tile per option, as in the concept; chips and section titles come from the shared layout. */
const STYLE = `
.options{display:grid;gap:10px;margin:12px 16px}
.options li{position:relative;border:1px solid var(--line);border-radius:12px;background:var(--card);box-shadow:var(--shadow)}
.options a{display:block;min-height:72px;padding:16px 60px 16px 18px;border-radius:12px;color:inherit;text-decoration:none}
.options a:hover{background:#f6f6ed}
.label{display:block;font-size:18px;font-weight:700}.hint{display:block;margin-top:2px;font-size:14px;color:var(--mute)}
.go{position:absolute;right:16px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:34px;height:34px;color:var(--ink);font-size:28px;line-height:1}
@media (min-width:1024px){.options{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;max-width:900px}}
`;
