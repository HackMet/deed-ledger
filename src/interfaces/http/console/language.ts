/**
 * The console's language: Spanish or English, picked with the ES | EN switch in the header and kept in a
 * cookie per browser. Without a choice, `CONSOLE_LANG` decides ("en" on the deployed demo); unset, Spanish.
 *
 * English is applied to the finished page: only the console's own words in text nodes are replaced, from
 * the fixed list below. Tags, attributes (button values, form fields, links), scripts and styles are left
 * alone, and anything not on the list (product and customer names, what people typed) stays as it is.
 * Messages to customers on WhatsApp are not part of the console and stay in Spanish.
 */
import type { Context, MiddlewareHandler } from "hono";

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
      out += part.replace(/^<html lang="es"/, '<html lang="en"');
      continue;
    }
    out += skip === null ? translateText(part) : part;
  }
  return out;
}

function translateText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return text;
  const translated = translatePhrase(trimmed);
  return translated === trimmed ? text : text.replace(trimmed, translated);
}

function translatePhrase(phrase: string): string {
  const exact = EN[phrase];
  if (exact !== undefined) return exact;
  for (const [pattern, replace] of PATTERNS) {
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
  [/^Buen día, (.+)\.$/, "Good morning, $1."],
  [/^Buenas tardes, (.+)\.$/, "Good afternoon, $1."],
  [/^Buenas noches, (.+)\.$/, "Good evening, $1."],
  [/^Hoy · (\d+) por preparar$/, "Today · $1 to prepare"],
  [/^(\d+) por preparar$/, "$1 to prepare"],
  [/^Para aprobar \((\d+)\)$/, "To approve ($1)"],
  [/^Cómo piden los clientes \((\d+)\)$/, "How customers ask for things ($1)"],
  [/^(\d+) productos?$/, (_m, n) => `${n} product${n === "1" ? "" : "s"}`],
  [/^(\d+) PRODUCTOS?$/, (_m, n) => `${n} PRODUCT${n === "1" ? "" : "S"}`],
  [/^Versión (\d+)$/, "Version $1"],
  [/^Pedido sin confirmar$/, "Unconfirmed order"],
  [/^Pedido (.+)$/, "Order $1"],
  [/^Intentos rechazados (\d+)$/, "Attempts refused $1"],
  [/^Afirmaciones verificadas (\d+), pasaron (\d+)$/, "Claims checked $1, held true $2"],
  [/^Entrega: (.+)$/, "Delivery: $1"],
  [/^confirmado (.+)$/, "confirmed $1"],
  [/^Hace (\d+) min$/, "$1 min ago"],
  [/^En camino con (.+)$/, "On the way with $1"],
  [/^Lo lleva (.+)$/, "Delivering: $1"],
  [/^Fiado a (.+)$/, "On credit to $1"],
  [/^Código para (.+)$/, "Code for $1"],
  [/^Precio anotado antes: (.+)$/, "Price noted before: $1"],
  [/^Propuesto: (.+)$/, "Proposed: $1"],
  [/^Ahora: (.+)$/, "Now: $1"],
  [/^Total: (.+)$/, (_m, rest) => `Total: ${EN[rest!] ?? rest}`],
];

/** The console's own words, Spanish → English. Missing phrases stay in Spanish. */
const EN: Record<string, string> = {
  // Tabs, header, shared
  Inicio: "Home", Pedidos: "Orders", Anotar: "Add", Productos: "Products", "Más": "More", Pendientes: "To do",
  Volver: "Back", "Más opciones": "More options", Guardar: "Save", Cancelar: "Cancel", Editar: "Edit", Quitar: "Remove",
  Agregar: "Add", Revisar: "Review", Responder: "Reply", Entendido: "Got it", Aprobar: "Approve", Rechazar: "Decline",
  "Dueño": "Owner", "Dueña": "Owner", Empleado: "Staff", Empleada: "Staff", "Mi tienda": "My store",
  "Entrar a la consola": "Sign in to the console", Entrar: "Sign in", Consola: "Console",
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
  "Ese botón ya no aplica. El pedido ya está al día.": "That button no longer applies. The order is up to date.",
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
  "Pasaron": "Held true",
  "Intentos rechazados": "Attempts refused",
  "Buscar pedido por código": "Find an order by code",
  "Ver libro": "See the book",
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
  "Intentó un mensaje del cliente": "Tried a customer message",
  "Intentó una acción": "Tried an action",
  "Intentó una acción de la tienda": "Tried a store action",
  "ya se hizo antes": "already done",
  "versión vieja": "old version",
  "no te toca": "not your turn",
  "no existe": "doesn't exist",
  "no está respaldado por los registros": "not backed by the records",
  "el estado no lo permite": "the state doesn't allow it",
  "ancestro cancelado": "cancelled ancestor",
  "rechazado": "refused",
  "Deed en vivo": "Deed live",
  "Se actualiza cada 3 segundos": "Updates every 3 seconds",
  "El más reciente": "Most recent",
  "Ver el detalle": "See details",
  "El grafo de cada pedido y cada verificación, al momento.": "Each order's graph and every check, as they happen.",
  "Todavía no hay pedidos. Cuando entre uno, su grafo aparece acá.": "No orders yet. When one comes in, its graph shows up here.",
  "Verificaciones": "Checks",
  "Vivo": "Live",
  "Cerrado": "Closed",
  "Bloqueado": "Blocked",
  "Pendiente": "Pending",
  "Versión": "Version",
  "Confirmado": "Confirmed",
  "Cancelado": "Cancelled",
  "Estado": "Status",
  "Cambio pedido": "Change asked",
  "Cambio revisado": "Change reviewed",
  "Intento rechazado": "Refused attempt",
  "Sin confirmar": "Unconfirmed",
  "Aprobalo o rechazalo en el pedido.": "Approve or decline it on the order.",
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
};
