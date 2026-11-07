/**
 * The console's language: Spanish or English, picked with the ES | EN switch in the header and kept in a
 * cookie per browser. Without a choice, `CONSOLE_LANG` decides ("en" on the deployed demo); unset, Spanish.
 *
 * English is applied to the finished page: only the console's own words in text nodes, and in the
 * `placeholder`, `aria-label` and `title` attributes, are replaced, from the fixed list below. Every other
 * attribute (button values, form fields, links), scripts and styles are left alone, and anything not on
 * the list (product and customer names, what people typed) stays as it is. Clock times read "8:05 p.m.".
 * Messages to customers on WhatsApp are not part of the console and stay in Spanish.
 */
import type { Context, MiddlewareHandler } from "hono";
import { hoursInEnglish } from "../demo-english";

export type ConsoleLanguage = "es" | "en";

export const LANGUAGE_COOKIE = "consola_idioma";
export const LANGUAGE_PATH = "/console/idioma";

/** The visitor's language: their own choice, else the store's default, else Spanish. */
export function languageOf(c: Context): ConsoleLanguage {
  const chosen = /(?:^|;\s*)consola_idioma=(es|en)(?:;|$)/.exec(c.req.header("cookie") ?? "")?.[1];
  if (chosen === "es" || chosen === "en") return chosen;
  const fallback = (c.env as { CONSOLE_LANG?: string } | undefined)?.CONSOLE_LANG;
  return fallback === "en" ? "en" : "es";
}

/** Translates every console HTML page to the visitor's language and adds the ES | EN switch. */
export const consoleLanguage: MiddlewareHandler = async (c, next) => {
  await next();
  const type = c.res.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) return;
  const language = languageOf(c);
  const page = await c.res.text();
  const withSwitch = addSwitch(page, language);
  const body = language === "en" ? toEnglish(withSwitch) : withSwitch;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(body, { status: c.res.status, headers });
};

/**
 * `GET /console/idioma/:lang`: saves the choice and goes back to the page it was picked on (the browser's
 * Referer, only when it is a console page of this same site); otherwise to Inicio. The link itself carries
 * no address, so no page ever repeats its own URL (an order ID, a search) in the switch.
 */
export function languageRoute(c: Context) {
  const wanted = c.req.param("lang");
  const target = backTo(c);
  if (wanted !== "es" && wanted !== "en") return c.redirect(target, 303);
  const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
  c.header("set-cookie", `${LANGUAGE_COOKIE}=${wanted}; Path=/console; Max-Age=31536000; SameSite=Lax${secure}`);
  return c.redirect(target, 303);
}

const SWITCH_STYLE =
  "display:inline-flex;gap:2px;margin-left:8px;font-size:13px;font-weight:700;align-items:center;white-space:nowrap";

function backTo(c: Context): string {
  const referer = c.req.header("referer");
  if (referer === undefined) return "/console/inicio";
  try {
    const from = new URL(referer);
    const here = new URL(c.req.url);
    const ok = from.origin === here.origin && /^\/console(\/|$)/.test(from.pathname) && !from.pathname.startsWith(LANGUAGE_PATH);
    return ok ? from.pathname + from.search : "/console/inicio";
  } catch {
    return "/console/inicio";
  }
}

function addSwitch(page: string, language: ConsoleLanguage): string {
  const link = (to: ConsoleLanguage, label: string) =>
    to === language
      ? `<span aria-current="true" style="padding:4px 6px;border-radius:999px;background:#1f3d33;color:#fff">${label}</span>`
      : `<a href="${LANGUAGE_PATH}/${to}" style="padding:4px 6px;color:inherit" lang="${to}">${label}</a>`;
  const control = `<p class="lang-line" style="margin:6px 12px 0;text-align:right"><span class="lang-switch" style="${SWITCH_STYLE}">${link("es", "ES")}${link("en", "EN")}</span></p>`;
  // Just under the header, outside it: the header's own text (title, who is logged in) stays as it was.
  if (page.includes("</header>")) return page.replace("</header>", `</header>${control}`);
  return page.replace(/<body([^>]*)>/, `<body$1>${control}`);
}

/** Replaces the console's own words in text nodes; leaves tags, attributes, scripts and styles alone. */
export function toEnglish(page: string): string {
  let out = "";
  let skip: string | null = null;
  for (const part of page.split(/(<[^>]*>)/)) {
    if (part.startsWith("<")) {
      const open = /^<(script|style)\b/i.exec(part)?.[1]?.toLowerCase();
      if (open !== undefined) skip = open;
      else if (skip !== null && new RegExp(`^</${skip}\\s*>`, "i").test(part)) skip = null;
      out += translateAttributes(part.replace(/^<html lang="es"/, '<html lang="en"'));
      continue;
    }
    out += skip === null ? translateText(part) : part;
  }
  return out;
}

function translateText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return text;
  const translated = clockInEnglish(translatePhrase(trimmed));
  return translated === trimmed ? text : text.replace(trimmed, translated);
}

/** The words people read in a tag: a field's placeholder, a screen reader's label, a tooltip. */
const READ_ATTRIBUTES = /(\s(?:placeholder|aria-label|title)=")([^"]*)(")/g;

function translateAttributes(tag: string): string {
  if (!tag.includes('="')) return tag;
  return tag.replace(READ_ATTRIBUTES, (whole, open: string, value: string, close: string) => {
    const translated = clockInEnglish(translatePhrase(value.trim()));
    return translated === value.trim() ? whole : `${open}${translated.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}${close}`;
  });
}

/** "8:05 p. m." → "8:05 p.m.", "ayer 8:05 p. m." → "yesterday 8:05 p.m.": the store's clock, said in English. */
function clockInEnglish(text: string): string {
  if (!/[ap]\. m\./.test(text)) return text;
  return text
    .replace(/\bayer (\d{1,2}(?::\d{2})? [ap]\. m\.)/g, "yesterday $1")
    .replace(/\b(\d{1,2}(?::\d{2})?) a\. m\./g, "$1 a.m.")
    .replace(/\b(\d{1,2}(?::\d{2})?) p\. m\./g, "$1 p.m.");
}

/** One phrase of the console in English, as the page would show it; unknown phrases come back as they are. */
export function englishPhrase(phrase: string): string {
  return clockInEnglish(translatePhrase(phrase));
}

function translatePhrase(phrase: string): string {
  const exact = EN[phrase];
  if (exact !== undefined) return exact;
  // A separator left at either end of a text node ("· Dueño", "Recoge en tienda ·") stays; the words are translated.
  const edge = /^(·\s+)(.+)$/u.exec(phrase) ?? /^(.+?)(\s+·)$/u.exec(phrase);
  if (edge !== null) {
    const [, a, b] = edge as unknown as [string, string, string];
    return a.startsWith("·") ? `${a}${translatePhrase(b)}` : `${translatePhrase(a)}${b}`;
  }
  // A phrase made of parts ("Pedido v1 · Cerrado") is translated part by part, unless a pattern names the parts.
  const parts = phrase.includes(" · ");
  for (const [pattern, replace] of PATTERNS) {
    if (parts && !pattern.source.includes("·")) continue;
    if (!pattern.test(phrase)) continue;
    return typeof replace === "string" ? phrase.replace(pattern, replace) : phrase.replace(pattern, (...args: string[]) => replace(...(args as [string, ...string[]])));
  }
  if (phrase.includes(" · ")) return phrase.split(" · ").map(translatePhrase).join(" · ");
  return phrase;
}

const DAYS: Record<string, string> = {
  lunes: "Monday", martes: "Tuesday", "miércoles": "Wednesday", jueves: "Thursday", viernes: "Friday",
  "sábado": "Saturday", domingo: "Sunday",
};
const MONTHS: Record<string, string> = {
  enero: "January", febrero: "February", marzo: "March", abril: "April", mayo: "May", junio: "June", julio: "July",
  agosto: "August", septiembre: "September", octubre: "October", noviembre: "November", diciembre: "December",
};

type Replace = string | ((match: string, ...groups: string[]) => string);

const PATTERNS: readonly (readonly [RegExp, Replace])[] = [
  [
    /^(lunes|martes|miércoles|jueves|viernes|sábado|domingo), (\d{1,2}) de (\w+)$/i,
    (_m, day, date, month) => `${DAYS[day!.toLowerCase()] ?? day}, ${MONTHS[month!.toLowerCase()] ?? month} ${date}`,
  ],
  [/^(?:Buen día|Buenos días), (.+)\.$/, (_m, name) => `Good morning, ${EN[name!] ?? name}.`],
  [/^Buenas tardes, (.+)\.$/, (_m, name) => `Good afternoon, ${EN[name!] ?? name}.`],
  [/^Buenas noches, (.+)\.$/, (_m, name) => `Good evening, ${EN[name!] ?? name}.`],
  [/^Hoy · (\d+) por preparar$/, "Today · $1 to prepare"],
  [/^(\d+) por preparar$/, "$1 to prepare"],
  [/^Para aprobar \((\d+)\)$/, "To approve ($1)"],
  [/^Cómo piden los clientes \((\d+)\)$/, "How customers ask for things ($1)"],
  [/^(\d+) productos?$/, (_m, n) => `${n} product${n === "1" ? "" : "s"}`],
  [/^(\d+) PRODUCTOS?$/, (_m, n) => `${n} PRODUCT${n === "1" ? "" : "S"}`],
  [/^Versión (\d+)$/, "Version $1"],
  [/^Pedido sin confirmar$/, "Unconfirmed order"],
  [/^Pedido (.+)$/, "Order $1"],
  [/^Cambio → (.+)$/, "Change → $1"],
  [/^(\d+) afirmación$/, "$1 claim"],
  [/^(\d+) afirmaciones$/, "$1 claims"],
  [/^(\d+) confirmadas?$/, "$1 confirmed"],
  [/^(\d+) sin respaldo$/, "$1 unbacked"],
  [/^(\d+) intento rechazado$/, "$1 attempt refused"],
  [/^(\d+) intentos rechazados$/, "$1 attempts refused"],
  [/^Intentos rechazados (\d+)$/, "Attempts refused $1"],
  [/^Afirmaciones verificadas (\d+), confirmadas (\d+)$/, "Claims checked $1, confirmed $2"],
  // The Libro (deed-libro.ts): what the agent said, what the ledger pairs, what the world recorded.
  [/^Libro (.+)$/, "Ledger $1"],
  [/^Dijo: total (L [\d.,]+)$/, "Said: total $1"],
  [/^Dijo: (.+)$/, (_m, said) => `Said: ${said!.split(" o ").map((state) => EN[state] ?? state).join(" or ")}`],
  [/^Dijo (.+), el libro no lo tiene$/, (_m, state) => `Said ${EN[state!] ?? state}, the ledger doesn't have it`],
  [/^dijo (L [\d.,]+)$/, "said $1"],
  [/^registró (L [\d.,]+)$/, "recorded $1"],
  [/^Total (L [\d.,]+)$/, "Total $1"],
  [/^Bloqueado: (.+)$/, (_m, why) => `Blocked: ${EN[why!] ?? why}`],
  [/^como estaba a las (.+)$/, "as it stood at $1"],
  // Pendientes and the cards waiting for a yes (inbox.ts).
  [/^Su número termina en (\d+)$/, "Their number ends in $1"],
  [/^¿«(.+)» es (.+)\?$/, "Is «$1» $2?"],
  [/^Preguntó (\d+) precios que no están confirmados\. Le dijimos que le confirmamos\.$/, "Asked about $1 prices that aren't confirmed. We told them we'd confirm."],
  [/^Preguntó si hay (\d+) productos y no lo sabemos\. Le dijimos que le confirmamos\.$/, "Asked if we have $1 products and we don't know. We told them we'd confirm."],
  [/^Confirmó un pedido con (\d+) productos sin precio\. Le dijimos que le confirmamos los precios\.$/, "Confirmed an order with $1 products without a price. We told them we'd confirm the prices."],
  [/^El pedido (#\S+) tiene un cambio$/, "Order $1 has a change"],
  [/^Factura de (.+)$/, (_m, supplier) => `Invoice from ${EN[supplier!] ?? supplier}`],
  [/^(\d+) líneas?$/, (_m, n) => `${n} line${n === "1" ? "" : "s"}`],
  // Products, the store and its hours.
  [/^Precio anotado antes: (L [\d.,]+)\. Confirmalo para que el asistente lo use\.$/, "Price noted before: $1. Confirm it so the assistant uses it."],
  [/^(\d+) productos?\. Ahí agregás, cambiás precios, marcás No hay y editás cada uno\. Es la misma lista que usa el asistente\.$/,
    (_m, n) => `${n} product${n === "1" ? "" : "s"}. There you add them, change prices, mark them out of stock and edit each one. It's the same list the assistant uses.`],
  [/^Escribí el nombre del producto \(hasta (\d+) caracteres\)\.$/, "Write the product's name (up to $1 characters)."],
  [/^Revisá los otros nombres: máximo (\d+), uno por línea\.$/, "Check the other names: at most $1, one per line."],
  [/^El tipo de tienda es muy largo \(hasta (\d+) caracteres\)\.$/, "The store type is too long (up to $1 characters)."],
  [/^La dirección es muy larga \(hasta (\d+) caracteres\)\.$/, "The address is too long (up to $1 characters)."],
  [/^Las zonas de entrega son muy largas \(hasta (\d+) caracteres\)\.$/, "The delivery zones are too long (up to $1 characters)."],
  [/^Las notas para el asistente son muy largas \(hasta (\d+) caracteres\)\.$/, "The notes for the assistant are too long (up to $1 characters)."],
  [/^La respuesta es muy larga: máximo (\d+) caracteres\.$/, "The reply is too long: at most $1 characters."],
  [/^Abrimos (.+)$/, (_m, when) => `We're open ${hoursInEnglish(when!)}`],
  [/^Envío: (L [\d.,]+)\. Es lo que el asistente les dice a los clientes\.$/, "Delivery: $1. It's what the assistant tells customers."],
  [/^(Domingo|Lunes|Martes|Miércoles|Jueves|Viernes|Sábado): (abre|cierra)$/, (_m, day, what) => `${EN[day!] ?? day}: ${what === "abre" ? "opens" : "closes"}`],
  [/^Vas a entrar a la consola de (.+)\.$/, "You're signing in to the console of $1."],
  // A count under a word the table knows: "versión vieja: 2".
  [/^([^:]+): (\d+)$/, (whole, word, n) => (EN[word!] === undefined ? whole : `${EN[word!]}: ${n}`)],
  [/^Entrega: (.+)$/, "Delivery: $1"],
  [/^confirmado (.+)$/, "confirmed $1"],
  [/^Hace (\d+) min$/, "$1 min ago"],
  [/^En camino con (.+)$/, "On the way with $1"],
  [/^Lo lleva (.+)$/, "Delivering: $1"],
  [/^Fiado a (.+)$/, "On credit to $1"],
  [/^Código para (.+)$/, "Code for $1"],
  [/^Precio anotado antes: ((?:(?!\. ).)+)$/, "Price noted before: $1"],
  [/^Propuesto: (.+)$/, "Proposed: $1"],
  [/^Ahora: (.+)$/, "Now: $1"],
  [/^Total: (.+)$/, (_m, rest) => `Total: ${EN[rest!] ?? rest}`],
  // lane fix-seed-queue
  [/^Buenos días, (.+)\.$/, "Good morning, $1."],
  // integration: order screens (fix-order-changes lane's proposed patterns)
  [/^cambió (.+)$/, "changed $1"],
  [
    /^(?:(.+?) cambió el pedido|El pedido cambió)(?: a las?)?(?: (.+?))?\.? Revisá (la línea marcada|las líneas marcadas)\.$/,
    (_m, name, time, lines) =>
      `${name === undefined ? "The order changed" : `${name} changed the order`}${time === undefined ? "" : ` at ${time}`}. Check the marked line${lines!.startsWith("las") ? "s" : ""}.`,
  ],
  [
    /^Al marcar Listo se le avisa (?:a (.+?)|(al cliente))( con el total)?\.$/,
    (_m, name, _customer, total) => `Marking it Ready lets ${name ?? "the customer"} know${total === undefined ? "" : " the total"}.`,
  ],
  [/^Ya está listo\. Cuando (.+) ya lo tenga, tocá Entregado\.$/, "It's ready. When $1 has it, tap Delivered."],
  [/^Depende de: (.+)$/, "Depends on: $1"],
  [/^Bloquea: (.+)$/, "Blocks: $1"],
  [/^(.+) \(paso (\d+)\)$/, (_m, what, n) => `${EN[what!] ?? what} (step ${n})`],
  [/^agente (.+)$/, "agent $1"],
];

/** The console's own words, Spanish → English. Missing phrases stay in Spanish. */
const EN: Record<string, string> = {
  // Tabs, header, shared
  Inicio: "Home", Pedidos: "Orders", Anotar: "Add", Productos: "Products", "Más": "More", Pendientes: "To do",
  Volver: "Back", "Más opciones": "More options", Guardar: "Save", Cancelar: "Cancel", Editar: "Edit", Quitar: "Remove",
  Agregar: "Add", Revisar: "Review", Responder: "Reply", Entendido: "Got it", Aprobar: "Approve", Rechazar: "Decline",
  "Dueño": "Owner", "Dueña": "Owner", Empleado: "Staff", Empleada: "Staff", "Mi tienda": "My store",
  "Entrar a la consola": "Sign in to the console", Entrar: "Sign in", Consola: "Console",
  "Para entrar, escaneá el código que te dan en la tienda.": "Store staff sign in with the QR code the store gives them.",
  "¿Querés probarlo? Abrí una tienda de demostración": "Just looking? Try the live demo with a store of your own",
  // The public demo's limits (demo-walls.ts)
  "No disponible en la demostración": "Not available in the demo",
  "En la demostración no se suben fotos. Escribilo y te muestro lo que entendí.": "Photos aren't uploaded in the demo. Type it and I'll show you what I understood.",
  "En la demostración no se agregan empleados.": "Staff can't be added in the demo.",
  "Esta ventana tiene abierta una tienda real": "This browser is signed in to a real store",
  "La demostración no muestra tiendas reales. Abrila en una ventana privada.": "The demo never shows a real store. Open it in a private window.",
  "Volver al inicio": "Back to Home",
  // Inicio
  "Esto es lo que necesita tu tienda hoy.": "Here's what your store needs today.",
  "Anotar algo": "Add something", "Por atender": "To prepare", "Pedidos por preparar": "Orders to prepare",
  "Para entregar": "To deliver", "Ya están listos": "Ready to go", "Por resolver": "To resolve",
  "Lo que solo vos decidís": "What only you decide", "Los pedidos de hoy": "Today's orders", "Ver todos →": "See all →",
  "Hoy todavía no hay pedidos.": "No orders yet today.", "Buen día.": "Good morning.", "Buenas tardes.": "Good afternoon.",
  "Buenas noches.": "Good evening.",
  "La lista de pedidos no está lista todavía.": "The order list isn't ready yet.",
  // Orders and statuses
  "No hay pedidos por preparar.": "No orders to prepare.", "Todavía no hay pedidos.": "No orders yet.",
  "Cliente sin nombre": "Unnamed customer", "Sin decir si recoge o se lo llevan": "Pickup or delivery not chosen yet",
  "Recoge en tienda": "Store pickup", "Entrega a domicilio": "Home delivery", "falta precio": "price missing",
  "falta la dirección": "address missing", "Empezar a preparar": "Start preparing", Listo: "Ready",
  "No hay": "Out of stock", "Cambió": "Changed", "Historial del pedido": "Order history", "Ver ubicación": "See location",
  "Al marcar Listo se le avisa al cliente.": "Marking it Ready lets the customer know.",
  "Este pedido cambió. Revisá la versión nueva.": "This order changed. Check the new version.",
  "Eso lo confirma el dueño.": "The owner confirms that.", "Ese pedido ya no está en la lista.": "That order is no longer on the list.",
  "No se pudo guardar. Revisá el pedido y tocá otra vez.": "Couldn't save. Check the order and tap again.",
  "Ya está listo. Falta mandarlo con quien lo lleva.": "It's ready. It still needs someone to deliver it.",
  "Por confirmar": "To confirm", Nuevo: "New", Preparando: "Preparing", Armando: "Packing",
  "Listo para entregar": "Ready to deliver", "En camino": "On the way", Entregado: "Delivered",
  "Pedido recibido": "Order received", "Pedido confirmado": "Order confirmed", "Pedido cancelado": "Order cancelled",
  "Cambio de estado": "Status change", "Cambio pedido por el cliente": "Change asked by the customer",
  "El cliente pidió un cambio": "The customer asked for a change", "Agregar:": "Add:", "Quitar:": "Remove:",
  "Cambiar:": "Change:", "Cambia la entrega, no los productos.": "The delivery changes, not the products.",
  "Falta saber si lo recogen o se lo llevamos. Preguntale al cliente.": "We don't know yet if it's pickup or delivery. Ask the customer.",
  "Ya lo tiene el cliente ✓": "The customer has it ✓", "¿Quién lo lleva?": "Who delivers it?",
  "Mandar en camino": "Send it out", "Entregado ✓": "Delivered ✓", "Pedido entregado.": "Order delivered.",
  "Va en camino. Le avisamos al cliente.": "On the way. We told the customer.",
  "Cambio aprobado. Le avisamos al cliente.": "Change approved. We told the customer.",
  "Cambio rechazado. Le avisamos al cliente con tu motivo.": "Change declined. We told the customer your reason.",
  "Ese cambio ya no está pendiente. La página ya está al día.": "That change is no longer waiting. The page is up to date.",
  "Ese pedido ya cambió. La página ya está al día.": "That order already changed. The page is up to date.",
  "Eso no se puede desde tu cuenta.": "Your account can't do that.",
  "No se pudo guardar. La página ya está al día; probá otra vez.": "Couldn't save. The page is up to date; try again.",
  "Esa persona no está activa en la tienda. Elegí a otra.": "That person isn't active in the store. Pick someone else.",
  "Cómo se armó": "How it was put together", "Todas las verificaciones": "All checks",
  "Afirmaciones verificadas": "Claims checked",
  "Pasaron": "Confirmed",
  "Intentos rechazados": "Attempts refused",
  "Buscar pedido por código": "Find an order by code",
  "pedido": "order",
  "Todavía no hay verificaciones.": "No checks yet.",
  "Tocá un hecho para ver su detalle.": "Tap a fact to see its details.",
  "Volver al grafo": "Back to the graph",
  "Ver el camino hasta el bloqueo": "See the path to the block",
  "Verificó el estado del pedido": "Checked the order's state",
  "Verificó el total del pedido": "Checked the order's total",
  "Verificó un precio": "Checked a price",
  "Verificó la disponibilidad": "Checked availability",
  "Verificó un pago": "Checked a payment",
  "Verificó un saldo": "Checked a balance",
  "Verificó el horario": "Checked the hours",
  "Verificó otro dato": "Checked another fact",
  "Intentó empezar a preparar": "Tried to start preparing",
  "Intentó marcar un producto": "Tried to mark a product",
  "Intentó marcar listo": "Tried to mark ready",
  "Intentó despachar": "Tried to dispatch",
  "Intentó marcar entregado": "Tried to mark delivered",
  "Intentó confirmar el pedido": "Tried to confirm the order",
  "Intentó cancelar el pedido": "Tried to cancel the order",
  "Intentó quitar un producto": "Tried to remove a product",
  "Intentó una acción": "Tried an action",
  "Intentó una acción de la tienda": "Tried a store action",
  "ya se hizo antes": "already done",
  "versión vieja": "old version",
  "no existe": "doesn't exist",
  "no está respaldado por los registros": "not backed by the records",
  "el estado no lo permite": "the state doesn't allow it",
  "rechazado": "refused",
  "Deed en vivo": "Deed live",
  "Se actualiza cada 3 segundos": "Updates every 3 seconds",
  "El más reciente": "Most recent",
  "Ver el detalle": "See details",
  "El grafo de cada pedido y cada verificación, al momento.": "Each order's graph and every check, as they happen.",
  "Todavía no hay pedidos. Cuando entre uno, su grafo aparece acá.": "No orders yet. When one comes in, its graph shows up here.",
  "Verificaciones": "Checks",
  "Cerrado": "Closed",
  "Bloqueado": "Blocked",
  "Versión": "Version",
  "Confirmado": "Confirmed",
  "HECHO": "DONE", "EN DUDA": "IN DOUBT", "CERRADO": "CLOSED", "BLOQUEADO": "BLOCKED",
  "Afirmó el agente": "Agent claimed", "Lo confirmó: tienda": "Confirmed by: store", "Lo confirmó: cliente": "Confirmed by: customer",
  "Lo confirmó: WhatsApp (entregado)": "Confirmed by: WhatsApp (delivered)", "esperando confirmación": "awaiting confirmation",
  "depende de": "depends on", "reemplaza a": "replaces", "Ver en el grafo": "See in the graph", "Ver en el libro": "See in the ledger",
  "Pedido": "Order", "Cambio aprobado": "Change approved", "Cambio rechazado": "Change declined",
  "Cancelado por la tienda": "Cancelled by the store", "Cancelado por el cliente": "Cancelled by the customer",
  "Confirmado por el cliente": "Confirmed by the customer", "Confirmado por la tienda": "Confirmed by the store",
  "Cancelado": "Cancelled",
  "Estado": "Status",
  "Cambio pedido": "Change asked",
  "Cambio revisado": "Change reviewed",
  "Intento rechazado": "Refused attempt",
  "Sin confirmar": "Unconfirmed",
  "Respondelo en el pedido.": "Answer it on the order.",
  // Deed pages (deed.ts, deed-live-view.ts)
  "EN VIVO": "LIVE", Vigente: "In force", "En duda": "In doubt", Operación: "Operation", "Operación:": "Operation:",
  "Cerrado por": "Closed by", "Bloqueado por": "Blocked by", "(lo reemplazó)": "(replaced it)", "(lo canceló)": "(cancelled it)",
  "Este pedido no tiene hechos todavía.": "This order has no facts yet.", "Buscar": "Search", Deed: "Deed",
  "No encontré un pedido con ese código en esta tienda.": "I didn't find an order with that code in this store.",
  "no tiene permiso": "not allowed", "el pedido ya estaba cancelado": "the order was already cancelled",
  "Intentó registrar un mensaje del cliente": "Tried to record a customer message",
  "Hechos del pedido y cómo se apoyan": "The order's facts and how they rest on each other",
  "Pedido que se muestra": "Order shown", Estados: "States", "sin respaldo": "nothing backing it",
  "mensaje del cliente": "customer message", foto: "photo", "toque del personal": "staff tap", "confirmación": "confirmation",
  "otro respaldo": "other backing", "repartidor": "courier", "hecho": "fact",
  "Ver como estaba": "See how it was", Ver: "See", Ahora: "Now",
  // The Libro (libro.ts, deed-libro.ts)
  Libro: "Ledger", "Ver libro": "See the ledger", "Volver al libro": "Back to the ledger", "Descargar entrada": "Download entry",
  "lo que se dijo y lo que pasó": "what was said and what happened",
  "AGENTE dijo": "AGENT said", "LIBRO empareja": "LEDGER pairs", "MUNDO registró": "WORLD recorded",
  "AGENTE dijo:": "AGENT said:", "LIBRO empareja:": "LEDGER pairs:", "MUNDO registró:": "WORLD recorded:",
  Emparejado: "Paired", "Sin pareja": "Unpaired", "Sin par": "No pair",
  "Sin confirmación de entrega todavía es «en duda», nunca rojo. Tocá una fila para ver su detalle.":
    "No delivery confirmation yet means «in doubt», never red. Tap a row to see its details.",
  "Lo que dijo el agente, lo que el libro empareja y lo que registró el mundo": "What the agent said, what the ledger pairs and what the world recorded",
  "Todavía no hay nada que comparar en este pedido.": "Nothing to compare in this order yet.",
  Hora: "Time", Hecho: "Fact", Tocó: "Tapped by", "Afirmación": "Claim", Mensaje: "Message", "ID de WhatsApp": "WhatsApp ID",
  "Envío": "Delivery", Intento: "Attempt", "Decidido por": "Decided by", "ver el hecho": "see the fact",
  "Sesión de consola": "Console session", "Personal tocó": "Staff tapped",
  "Respuesta en cola": "Reply queued", "Respuesta enviada": "Reply sent", "Respuesta en espera": "Reply waiting",
  "Respuesta no enviada": "Reply not sent", "No se sabe si salió la respuesta": "Unknown whether the reply went out",
  "Estado de respuesta desconocido": "Unknown reply state",
  "Enviado, sin confirmación todavía": "Sent, no confirmation yet", "Entregado al teléfono": "Delivered to the phone",
  "Leído": "Read", Escuchado: "Played", "Falló el envío": "Sending failed", "No se envió": "Not sent",
  "No se sabe si salió": "Unknown whether it went out", "Sin confirmación de entrega todavía": "No delivery confirmation yet",
  "Total sin calcular": "Total not worked out",
  armando: "building", "por confirmar": "to confirm", confirmado: "confirmed", preparando: "preparing", listo: "ready",
  "en camino": "on the way", entregado: "delivered", cancelado: "cancelled",
  // Pendientes (pendientes.ts) and the cards waiting for a yes (inbox.ts)
  Resuelto: "Done", urgente: "urgent",
  "Aquí aparecen los clientes que piden hablar con vos, las preguntas que quedaron en «te confirmo», los mensajes que no salieron, y los cambios y facturas por aprobar.":
    "Here you'll see customers who want to talk to you, questions left at «I'll confirm», messages that didn't go out, and changes and invoices to approve.",
  "Ese pendiente ya no estaba en la lista.": "That item was no longer on the list.",
  "Tu respuesta queda lista, pero WhatsApp no deja mandarla hasta que el cliente vuelva a escribir. Llamale si es urgente.":
    "Your reply is ready, but WhatsApp won't let us send it until the customer writes again. Call them if it's urgent.",
  "Lleva más de dos minutos esperando respuesta. Ya le avisamos que lo estamos revisando.":
    "They've been waiting for a reply for over two minutes. We already told them we're looking at it.",
  "Pidió hablar con alguien de la tienda.": "Asked to talk to someone at the store.",
  "Preguntó un precio que no está confirmado. Le dijimos que le confirmamos.": "Asked about a price that isn't confirmed. We told them we'd confirm.",
  "Preguntó si hay un producto y no lo sabemos. Le dijimos que le confirmamos.": "Asked if we have a product and we don't know. We told them we'd confirm.",
  "Confirmó un pedido con un producto sin precio. Le dijimos que le confirmamos el precio.":
    "Confirmed an order with a product without a price. We told them we'd confirm the price.",
  "Preguntó el horario y no está puesto. Le dijimos que le confirmamos.": "Asked for the hours and they aren't set. We told them we'd confirm.",
  "Su pedido está listo, pero WhatsApp no deja avisarle hasta que vuelva a escribir. Llamale.":
    "Their order is ready, but WhatsApp won't let us tell them until they write again. Call them.",
  "Un aviso no pudo salir: WhatsApp no deja escribirle hasta que vuelva a escribir. Llamale.":
    "A notice couldn't go out: WhatsApp won't let us write to them until they write again. Call them.",
  "Una respuesta no salió porque un dato cambió antes de enviarla. Revisá su conversación.":
    "A reply didn't go out because something changed before it was sent. Check their conversation.",
  "Un cliente lo pidió así en un pedido que confirmó. Si es lo mismo, el asistente lo va a reconocer la próxima vez.":
    "A customer asked for it this way in an order they confirmed. If it's the same thing, the assistant will recognize it next time.",
  "Sí": "Yes", No: "No", "Sí hay, a L 65": "In stock, L 65",
  "Un cliente pidió un cambio": "A customer asked for a change", "proveedor sin nombre": "unnamed supplier",
  // Products, the store, its hours (productos.ts, tienda.ts, negocio.ts)
  "¿Se acabó?": "Sold out?", "Marcado No hay": "Marked out of stock", "Sí hay": "In stock",
  "Ya tenés un producto con ese nombre. Buscalo en la lista y tocá Editar.": "You already have a product with that name. Find it on the list and tap Edit.",
  "Ya hay otro producto con ese nombre.": "There's already another product with that name.",
  "Escribí el nombre del producto (máximo 80 caracteres).": "Write the product's name (at most 80 characters).",
  "No pude leer el precio. Escribilo así: 18 o 18.50, sin comas. Si no lo sabés, dejalo vacío.":
    "I couldn't read the price. Write it like this: 18 or 18.50, no commas. If you don't know it, leave it empty.",
  "Revisá los otros nombres: máximo 10, uno por línea.": "Check the other names: at most 10, one per line.",
  "No pude leer la cantidad de siempre. Escribila así: 1 o 0.5, sin comas. Si no sabés, dejala vacía.":
    "I couldn't read the usual amount. Write it like this: 1 or 0.5, no commas. If you don't know, leave it empty.",
  "Ese producto ya no está en la lista.": "That product is no longer on the list.",
  "No se guardó: la lista cambió mientras tanto. Revisala y tocá Guardar otra vez.": "Not saved: the list changed in the meantime. Check it and tap Save again.",
  "Eso ya se guardó hace un momento. Esperá un minuto para cambiarlo otra vez.": "That was saved a moment ago. Wait a minute to change it again.",
  "Escribí el nombre de la tienda (hasta 120 caracteres).": "Write the store's name (up to 120 characters).",
  "Revisá el horario: cada día necesita hora de apertura y de cierre (como 08:00 y 18:00), y abrir antes de cerrar.":
    "Check the hours: each day needs an opening and a closing time (like 08:00 and 18:00), and must open before it closes.",
  "Todavía no hay horario.": "No hours set yet.", "Envío gratis.": "Free delivery.", "Envío: todavía sin precio.": "Delivery: no price yet.",
  "Es lo que el asistente les dice a los clientes.": "It's what the assistant tells customers.",
  "El horario se cambia en": "Hours are changed in", "Mercadito, farmacia…": "Corner store, pharmacy…",
  "Tienda de demostración: los productos, precios y clientes son de ejemplo.": "Demo store: the products, prices and customers are examples.",
  Horario: "Hours", Abierto: "Open", Abre: "Opens", Cierra: "Closes",
  Domingo: "Sunday", Lunes: "Monday", Martes: "Tuesday", "Miércoles": "Wednesday", Jueves: "Thursday", Viernes: "Friday", "Sábado": "Saturday",
  // Sign-in (auth.ts) and the header (layout.ts)
  "Este código ya no sirve. Pedí uno nuevo en la tienda.": "This code doesn't work anymore. Ask the store for a new one.",
  "Esta parte es solo para el dueño.": "This part is for the owner only.",
  "Esa acción venció. Volvé a la lista e intentá otra vez.": "That action expired. Go back to the list and try again.",
  "La consola no está lista todavía.": "The console isn't ready yet.",
  "Dueño (demo)": "Owner (demo)",
  // Anotar
  "Esto entendí": "Here's what I understood", "Todavía no se guarda nada.": "Nothing is saved yet.",
  "Te muestro lo que entendí. Todavía no se guarda nada.": "I'll show you what I understood. Nothing is saved yet.",
  "Anotar otra cosa": "Add something else",
  "Escribí lo que pasó o tomale foto. Te muestro lo que entendí.": "Write what happened or take a photo. I'll show you what I understood.",
  "¿Qué es?": "What is it?", "Venta, fiado o producto nuevo": "Sale, credit or new product", "Pedido a mano": "Manual order",
  "Factura de proveedor": "Supplier invoice", "Escribilo aquí": "Write it here", "Foto (si querés)": "Photo (optional)",
  Leer: "Read", "Producto nuevo:": "New product:", "Unidad:": "Unit:", "Hay:": "In stock:", "Precio:": "Price:",
  "Total impreso:": "Printed total:", "Nombre del cliente": "Customer name", "Aquí no encontré nada para anotar.": "I didn't find anything to add here.",
  "Sin productos.": "No products.", "solo en tienda": "in store only", "Escribí algo o tomá una foto, y lo leo.": "Write something or take a photo, and I'll read it.",
  "Mandame una foto y un texto a la vez, nada más.": "Send one photo and one text at a time.",
  "No pude abrir esa foto. Probá tomándola otra vez desde aquí.": "I couldn't open that photo. Try taking it again from here.",
  "Por hoy ya se leyó todo lo que alcanza. Mañana se puede otra vez.": "Today's reading limit is used up. You can try again tomorrow.",
  "No pude leerlo ahorita. Probá otra vez en un rato.": "I couldn't read it right now. Try again in a bit.",
  "Algo no se lee bien": "Something isn't readable", "No dice el tamaño": "The size isn't given", "No sé qué producto es": "I don't know which product this is",
  "Trae instrucciones para el sistema; no les hice caso": "It contains instructions for the system; I ignored them",
  "Ventas, fiado y pedidos a mano": "Sales, credit and manual orders",
  // Products
  "Todavía no hay productos.": "No products yet.", "Agregar producto": "Add product", "Agregar un producto": "Add a product",
  Nombre: "Name", "Precio en lempiras": "Price in lempiras", "(vacío si no lo sabés)": "(empty if you don't know)",
  "Otros nombres que usan los clientes": "Other names customers use", "(opcional, uno por línea)": "(optional, one per line)",
  "Pegar una lista de muchos productos": "Paste a list of many products", "Datos del producto": "Product details",
  "(uno por línea)": "(one per line)", "Cómo se vende": "How it's sold", "Por unidad": "By unit", "Por libra": "By the pound",
  "No sé": "Not sure", "Cantidad de siempre": "Usual amount", "Volver a Productos": "Back to Products",
  "(opcional: lo que casi todos llevan, por ejemplo 1)": "(optional: what most people take, for example 1)",
  "Si un cliente no dice cuánto, el asistente le propone esa cantidad y el cliente la confirma.": "If a customer doesn't say how much, the assistant suggests that amount and the customer confirms it.",
  "Producto agregado.": "Product added.", "Precio confirmado.": "Price confirmed.", "Confirmar precio": "Confirm price",
  "Precio propuesto. El dueño lo confirma.": "Price proposed. The owner confirms it.", "Proponer precio": "Propose price",
  "Ya hay un producto con ese nombre.": "There's already a product with that name.", "Sin precio": "No price", "sin precio": "no price",
  "Ese precio ya se guardó hace un momento. Esperá un minuto para cambiarlo otra vez.": "That price was saved a moment ago. Wait a minute to change it again.",
  "Ese producto no está en la lista.": "That product isn't on the list.",
  "El precio cambió mientras tanto. La lista ya está al día.": "The price changed in the meantime. The list is up to date.",
  "La lista de productos no está lista todavía.": "The product list isn't ready yet.", "Listo. Cambios guardados.": "Done. Changes saved.",
  "Listo. Marcado No hay: el asistente le dice al cliente que se acabó.": "Done. Marked out of stock: the assistant tells customers it's sold out.",
  "Listo. Ya no está marcado No hay.": "Done. No longer marked out of stock.",
  "Los productos están en Productos": "Products live in Products", "Ir a Productos": "Go to Products",
  "Pegar una lista": "Paste a list", "Guardar horario": "Save hours", "Envío a domicilio": "Home delivery",
  "Cuánto cobrás por llevarlo, en lempiras": "What you charge to deliver, in lempiras",
  "(0 si es gratis; vacío si todavía no sabés)": "(0 if free; empty if you don't know yet)", "Guardar envío": "Save delivery fee",
  Tienda: "Store", "Listo. Producto agregado.": "Done. Product added.", "Listo. Producto quitado.": "Done. Product removed.",
  "Listo. Productos guardados.": "Done. Products saved.", "Listo. Horario guardado.": "Done. Hours saved.",
  "Listo. Envío guardado.": "Done. Delivery fee saved.", "No había productos para guardar.": "There were no products to save.",
  "Marcá los días que abrís. El asistente se lo dice a los clientes que preguntan.": "Mark the days you're open. The assistant tells customers who ask.",
  // Más, Mi tienda, Facturas, Empleados
  "Nombre, horario, envío, dirección y notas.": "Name, hours, delivery, address and notes.", Empleados: "Staff",
  "Invitar, permisos y quitar.": "Invite, permissions and remove.", Facturas: "Invoices",
  "La lista de facturas de proveedores.": "The list of supplier invoices.", "Aviso de privacidad": "Privacy notice",
  "Lo que ven los clientes.": "What customers see.", "Horario y envío": "Hours and delivery",
  "Cambiar horario y envío": "Change hours and delivery", "Nombre de la tienda": "Store name", "Tipo de tienda": "Store type",
  "Zonas de entrega": "Delivery zones", "Notas para el asistente": "Notes for the assistant", "Dirección": "Address",
  "Horario (dejá vacío el día que no abrís)": "Hours (leave empty the days you're closed)",
  "Listo, guardamos los datos de la tienda.": "Done, we saved the store's details.", "Esto es solo para el dueño.": "This is for the owner only.",
  "Probar como cliente": "Try it as a customer", "Tu WhatsApp para clientes": "Your WhatsApp for customers",
  "Escribile como si fueras cliente y mirá lo que ellos ven.": "Write to it as a customer and see what they see.",
  "Subir factura": "Upload invoice", "Por revisar": "To review", Registrada: "Recorded", Rechazada: "Declined", Anulada: "Voided",
  "Factura registrada. El inventario ya está al día.": "Invoice recorded. Stock is up to date.",
  "Factura rechazada.": "Invoice declined.", "Factura anulada. El inventario volvió a como estaba antes de ella.": "Invoice voided. Stock is back to how it was before it.",
  "Invitar a alguien": "Invite someone", "Hacer código": "Make a code", "Volver a invitar": "Invite again", "Código nuevo": "New code",
  "Mandarlo por WhatsApp": "Send it by WhatsApp", "Volver a Empleados": "Back to Staff", "Sí, quitar": "Yes, remove",
  "Listo. Esa persona ya no puede entrar a la consola.": "Done. That person can't sign in to the console anymore.",
  // Pendientes
  "No hay nada pendiente.": "Nothing to do.", "Tu respuesta": "Your reply", "Esperando respuesta": "Waiting for a reply",
  "Piden hablar con vos": "They want to talk to you", "Preguntas por confirmar": "Questions to confirm",
  "Avisos que no salieron": "Notices that didn't go out", "Respuestas detenidas": "Replies held back",
  "(le llega por WhatsApp con tu nombre)": "(they get it on WhatsApp with your name)",
  "Listo, ya no aparece en la lista.": "Done, it's off the list.", "Listo, le mandamos tu respuesta.": "Done, we sent your reply.",
  "Escribí la respuesta antes de tocar Responder.": "Write the reply before tapping Reply.",
  "Listo. La próxima vez el asistente lo reconoce.": "Done. Next time the assistant recognizes it.",
  "Listo. El asistente no va a usar ese nombre.": "Done. The assistant won't use that name.",
  "Antes de empezar": "Before you start",
  // lane fix-demo-security
  "Esta tienda de demostración ya usó todas sus lecturas. Tocá «Empezar de nuevo» arriba para seguir probando.":
    "This demo store has used all its readings. Tap «Start over» at the top to keep trying.",
  // lane fix-seed-queue
  "Buenos días.": "Good morning.",
  "Estamos cargando unos días de pedidos de ejemplo. Esta página se actualiza sola.": "We're loading a few days of sample orders. This page updates itself.",
  "Los pedidos de ejemplo van llegando.": "The sample orders are on their way.",
  // lane fix-demo-frame: Anotar and Facturas (demo-frame lane)
  "Escribí lo que pasó o sacale una foto. Te muestro lo que entendí.": "Write what happened or take a photo. I'll show you what I understood.",
  "Escribí lo que pasó. Te muestro lo que entendí.": "Write what happened. I'll show you what I understood.",
  "En la demostración no se suben fotos.": "Photos are off in the demo.",
  "Vendí tres refrescos a L 20 cada uno": "I sold three sodas at L 20 each",
  "Eso está muy pesado para leerlo de una vez. La foto puede pesar hasta 5 MB y el texto unos 2,000 caracteres.":
    "That's too much to read at once. The photo can be up to 5 MB and the text about 2,000 characters.",
  "Las notas de voz aquí vienen pronto. Por ahora escribilo o sacale una foto.": "Voice notes are coming here soon. For now, type it or take a photo.",
  Venta: "Sale", Entrega: "Delivery", Factura: "Invoice", "Factura de": "Invoice from",
  "Lo pasa a traer": "Picks it up", "A domicilio": "Home delivery", "Sin decir cómo": "Pickup or delivery not said",
  "¿cuántos?": "how many?", "sin decir": "not said", "sin contar": "not counted", "c/u": "each",
  "La foto pesa más de 10 MB. Mandá una que pese menos.": "The photo is over 10 MB. Send a smaller one.",
  "No llegó ninguna foto. Elegí la foto de la factura.": "No photo arrived. Choose the invoice photo.",
  "Mandá una foto JPG, PNG o WEBP de la factura.": "Send a JPG, PNG or WEBP photo of the invoice.",
  "Todavía no leo PDF. Mandá una foto o una captura de la factura.": "I can't read PDFs yet. Send a photo or a screenshot of the invoice.",
  "No pude leer esa factura. Probá con otra foto, más cerca y con buena luz.": "I couldn't read that invoice. Try another photo, closer and in good light.",
  "Esa factura ya la habías subido. Aquí está.": "You'd already uploaded that invoice. Here it is.",
  "Cambios guardados. Revisalos y aprobá la factura.": "Changes saved. Check them and approve the invoice.",
  "Revisá la línea marcada: nombre (hasta 120 caracteres), cantidad como 12 o 1.5, costo como 15.50 o vacío.":
    "Check the marked line: name (up to 120 characters), quantity like 12 or 1.5, cost like 15.50 or empty.",
  "La factura necesita al menos una línea.": "The invoice needs at least one line.",
  "La factura cambió mientras tanto. Revisá la versión nueva antes de aprobar.": "The invoice changed in the meantime. Check the new version before approving.",
  "Falta la cantidad en una línea. Escribila y guardá los cambios.": "A line is missing its quantity. Type it and save the changes.",
  "Ya hay un producto con el nombre de una línea nueva. Elegilo en la lista y guardá los cambios.":
    "There's already a product with a new line's name. Pick it in the list and save the changes.",
  "Esa factura ya quedó registrada. No la repetí.": "That invoice was already recorded. I didn't record it twice.",
  "Esa factura ya estaba rechazada.": "That invoice was already declined.",
  "Escribí el motivo del rechazo (hasta 200 caracteres).": "Write the reason for declining (up to 200 characters).",
  "Esa factura ya no se puede cambiar.": "That invoice can't be changed anymore.",
  "Esa factura ya estaba anulada. No hice ningún cambio.": "That invoice was already voided. I didn't change anything.",
  "No puedo anularla: parte de esos productos ya salió del inventario.": "I can't void it: some of those products have already left stock.",
  "Esa factura no está en la lista.": "That invoice isn't on the list.", "Ver todas las facturas": "See all invoices",
  "Ver las facturas": "See the invoices",
  "En la demostración no se suben fotos de facturas. Abrí una de la lista para revisarla.":
    "Invoice photos are off in the demo. Open one from the list to review it.",
  "Todavía no hay facturas.": "No invoices yet.", "Proveedor sin nombre": "Unnamed supplier", "línea": "line", "líneas": "lines",
  Vencida: "Expired", "Foto de la factura (JPG, PNG o WEBP, hasta 10 MB)": "Invoice photo (JPG, PNG or WEBP, up to 10 MB)",
  "Leer factura": "Read invoice", "Revisar factura": "Review invoice", Proveedor: "Supplier", "Fecha:": "Date:", "Línea": "Line",
  nuevo: "new", producto: "product", "Producto en la factura": "Product on the invoice", Cantidad: "Quantity",
  "Costo c/u (L)": "Cost each (L)", "Producto de la tienda": "Store product", "Crear como producto nuevo": "Create as a new product",
  "Quitar esta línea": "Remove this line", "Guardar cambios": "Save changes", "Motivo del rechazo": "Reason for declining",
  "Anular factura": "Void invoice", "sin costo": "no cost",
  // Shared with pedidos.ts (the order-changes lane lists these too): keep one copy when merging.
  "Aprobar ✓": "Approve ✓", "Rechazar ✗": "Decline ✗",
  // lane fix-order-changes (preparacion.ts, pedidos.ts, order-trail.ts)
  "Ese botón ya no vale. El pedido ya está al día.": "That button no longer works. The order is up to date.",
  "Cambio sin responder": "Change not answered",
  "El cliente pidió un cambio que espera respuesta.": "The customer asked for a change that is waiting for an answer.",
  "Revisalo antes de marcar Listo: después ya no se puede aprobar.": "Review it before marking it Ready: after that it can't be approved.",
  "El pedido ya está listo, así que ya no se puede aprobar. Rechazalo con un motivo y le avisamos al cliente.":
    "The order is ready, so the change can't be approved anymore. Decline it with a reason and we'll tell the customer.",
  "Ver el cambio": "See the change",
  "El pedido ya avanzó y ese cambio ya no se puede aprobar. Rechazalo con un motivo y le avisamos al cliente.":
    "The order has moved on, so that change can't be approved anymore. Decline it with a reason and we'll tell the customer.",
  "El pedido ya avanzó, así que este cambio ya no se puede aprobar. Rechazalo con un motivo y le avisamos al cliente.":
    "The order has moved on, so this change can't be approved anymore. Decline it with a reason and we'll tell the customer.",
  "Escribí un motivo corto (hasta 200 caracteres).": "Write a short reason (up to 200 characters).",
  "Falta saber si lo pasan a traer o se lo llevamos. Preguntale al cliente.": "We don't know yet if it's pickup or delivery. Ask the customer.",
  Despachar: "Dispatch", Hoy: "Today", "nada por preparar": "nothing to prepare",
  Motivo: "Reason", "cerrado por": "closed by", "(reemplazado)": "(superseded)", "(cancelado)": "(cancelled)",
  mensaje: "message", "✓ Entregado": "✓ Delivered", Personal: "Staff", Cliente: "Customer",
};
