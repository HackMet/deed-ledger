/**
 * Más (wireframe C7): everything that isn't a daily screen. Staff see it without the pause switch
 * and Empleados. Options whose screens aren't built yet are listed, marked "Pronto", and not links.
 */
import type { Hono } from "hono";
import { html } from "hono/html";
import { PRIVACY_PATH } from "../../../domain/customer-controls";
import type { ConsoleEnv } from "./auth";
import { shell } from "./layout";

const PATH = "/console/mas";

interface Option {
  readonly label: string;
  readonly hint: string;
  /** Null while the screen isn't built. */
  readonly href: string | null;
  readonly ownerOnly: boolean;
}

/** The pause switch (#32) and its paused conversations come here first, for the owner. */
const PAUSE: Option = {
  label: "Asistente en pausa",
  hint: "Para atender vos los mensajes en un día difícil.",
  href: null,
  ownerOnly: true,
};

const OPTIONS: readonly Option[] = [
  { label: "Pedido a mano", hint: "Pedidos que te llegan a otro WhatsApp.", href: null, ownerOnly: false },
  { label: "Empleados", hint: "Invitar, permisos y quitar.", href: "/console/empleados", ownerOnly: true },
  { label: "Preparar la tienda", hint: "Productos, precios, horario y envío.", href: "/console/tienda", ownerOnly: true },
  // K6 and K14: staff propose prices for the owner to confirm; the business info and invoices are the owner's.
  { label: "Precios", hint: "Proponer y confirmar precios.", href: "/console/productos", ownerOnly: false },
  { label: "Datos del negocio", hint: "Nombre, horario, dirección y zonas.", href: "/console/negocio", ownerOnly: true },
  { label: "Facturas", hint: "Subir y aprobar facturas de proveedores.", href: "/console/facturas", ownerOnly: true },
  { label: "Cierre del día", hint: "Cuadrar la caja al cerrar.", href: null, ownerOnly: false },
  { label: "Aviso de privacidad", hint: "Lo que ven los clientes.", href: PRIVACY_PATH, ownerOnly: false },
];

export function masScreen(app: Hono<ConsoleEnv>) {
  app.get("/mas", (c) => {
    const isOwner = c.get("member").role === "owner";
    const options = OPTIONS.filter((option) => isOwner || !option.ownerOnly);
    return c.html(
      shell(c, {
        title: "Más",
        path: PATH,
        style: STYLE,
        body: html`${isOwner ? html`<ul class="options">${row(PAUSE)}</ul>` : ""}
<h2 class="section">Más opciones</h2>
<ul class="options">${options.map(row)}</ul>`,
      }),
    );
  });
}

function row(option: Option) {
  const text = html`<span class="label">${option.label}</span><span class="hint">${option.hint}</span>`;
  return option.href === null
    ? html`<li class="soon">${text}<span class="chip">Pronto</span></li>`
    : html`<li><a href="${option.href}">${text}<span class="go" aria-hidden="true">›</span></a></li>`;
}

/** Rows inside one card, as in the wireframe; chips and section titles come from the shared layout. */
const STYLE = `
.options{margin:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card);overflow:hidden}
.options li{position:relative;border-top:1px solid #eee}.options li:first-child{border-top:0}
.options a,.options li.soon{display:block;min-height:56px;padding:12px 48px 12px 14px;color:inherit;text-decoration:none}
.label{display:block;font-weight:600}.hint{display:block;font-size:14px;color:var(--mute)}
.soon .label{color:var(--mute)}
.go{position:absolute;right:16px;top:50%;transform:translateY(-50%);font-size:24px;color:var(--accent)}
.soon .chip{position:absolute;right:12px;top:14px}
`;
