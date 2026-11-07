/**
 * The demo phone in English (D-63). The assistant speaks Honduran Spanish, as it does to real
 * customers; with the console set to English, the phone shows the same chat in English instead.
 * Display only: nothing here reaches a customer, the engine or a model. Every reply is built from fixed
 * templates (`domain/replies.ts`, the planner's fixed phrases), so a word list covers them; a
 * sentence it doesn't know stays in Spanish rather than being guessed, and a message with nothing
 * known is shown as sent.
 */
import { BUTTON_TITLES, COPY, WHAT_TO_ORDER } from "../../domain/replies";
import { SAY_PHRASES } from "../../domain/planner/wire";
import { DELETION_CONFIRMED, RESUMED, STOPPED_REMINDER, WELCOME_ASK } from "../../domain/customer-controls";
import {
  CANCEL_AFTER_DISPATCH,
  CHANGE_AFTER_READY,
  COULD_NOT_OPEN_MEDIA,
  couldNotDownload,
  couldNotProcess,
  HANDED_TO_STORE,
  RECEIVED_PLACEHOLDER,
} from "../../domain/copy";
import { DEMO_PRESETS } from "../../domain/demo";

/** Every fixed reply sentence, Spanish → English. A test checks each COPY entry and phrase has one. */
export const FIXED_EN: Readonly<Record<string, string>> = {
  [COPY.safeReply]: "Let me check and I'll confirm.",
  [COPY.slowNotice]: "Got your message, I'm looking at it.",
  [COPY.typedFallback]: "Reply Confirmar, Corregir or Cancelar (confirm, fix or cancel).",
  [COPY.typedFallbackSoft]: "_Or write: confirmar, corregir or cancelar._",
  [COPY.fixHint]: "If something's wrong, write to me or send a voice note.",
  [COPY.confirmLater]: "For these I'll confirm stock and price",
  [COPY.readbackTitle]: "Your order:",
  [COPY.changedTitle]: "Done, here's your order now:",
  [COPY.staleTapTitle]: "Your order changed since that message. Here it is now:",
  [COPY.confirmQuestion]: "Shall I prepare it like this?",
  [COPY.soldOutAll]: "What else can I send you? If you don't want anything else, reply Cancelar (cancel).",
  [COPY.pickup]: "You pick it up at the store.",
  [COPY.payOnPickup]: "You pay when you pick it up.",
  [COPY.payOnDelivery]: "You pay when we deliver it.",
  [COPY.totalUnknown]: "I'll confirm the total.",
  [COPY.confirmed]: "Done 🙌 Your order is in. I'll let you know when it's ready.",
  [COPY.askName]: "Great! What name should I put the order under?",
  [COPY.askNameAgain]: "It's just to note whose order it is 🙂 What name should I put it under?",
  [COPY.cancelled]: "Done, I cancelled your order. Whenever you need something, I'm here 🙌",
  [COPY.statusBuilding]: "We're still putting your order together.",
  [COPY.statusAwaitingConfirm]: "Your order is ready to go, it just needs your confirmation.",
  [COPY.statusOnList]: "Your order is in line. I'll let you know as soon as it's ready.",
  [COPY.changeRequested]: "Your order is already confirmed. This change is waiting for the store to review it:",
  [COPY.changeRequestedPlain]: "Your order is already confirmed. Your change is waiting for the store to review it.",
  [COPY.changeRequestedAfter]: "I'll let you know as soon as they review it.",
  [COPY.statusReady]: "Your order is ready.",
  [COPY.statusOnTheWay]: "Your order is on its way 🛵",
  [COPY.statusDelivered]: "Your order was delivered.",
  [COPY.statusCancelled]: "That order is cancelled. If you want to place another, write to me.",
  [COPY.noOpenOrder]: "You don't have an open order. Want to place one? Tell me what you need.",
  [COPY.balanceUnknown]: "Let me check your balance and I'll confirm.",
  [COPY.balanceZero]: "You don't owe the store anything.",
  [COPY.paymentClaimed]: "Got your receipt. I'll let you know when the store confirms the payment.",
  [COPY.handoff]: "I've noted it for the store, they'll write to you here.",
  [COPY.stopped]: "If you don't want more messages, write just the word ALTO.",
  [COPY.stoppedDelete]: "If you want us to delete your data, write: borren mis datos.",
  [COPY.outOfScope]: "I don't know about that 😅 I help with orders, prices and the store's hours. What can I send you?",
  [COPY.refusedTap]: "That button doesn't work anymore. If you need something with your order, write to me.",
  [COPY.whichProduct]: "Which product are you asking about?",
  [COPY.hoursUnknown]: "I'll confirm the hours.",
  [COPY.paymentRejected]: "We couldn't confirm that payment. If you have another receipt, send it to me.",
  [COPY.pickupReady]: "You can come by for it.",
  [COPY.substituteFallback]: "Tap a button or tell me which you prefer.",
  [COPY.substituteFallbackTyped]: "Tell me which you prefer.",
  [COPY.removeTitle]: "Remove",
  [COPY.samePlace]: "Shall we take it to the usual place?",
  [COPY.samePlaceFallback]: "Reply Sí (yes) or Otro lugar (another place).",
  [COPY.samePlacePin]: "Last time you sent us your location.",
  [COPY.deliveryToPin]: "We'll take it to the location you sent us.",
  [COPY.welcome]: "At your service! 🙌",
  [COPY.confirmNudge]: "To get it ready, tap Confirm ✅",
  [COPY.confirmNudgeTyped]: "To get it ready, reply Confirmar (confirm).",
  [COPY.anythingElse]: "What else can I send you?",
  [COPY.pickOption]: "Which one should I send? Reply with the number.",
  [COPY.noted]: "Noted ✅",
  [COPY.quantitiesTitle]: "How many of these do you want?",
  [COPY.pickOptionByName]: "Which one should I send? Reply with the number or the name.",
  [COPY.assumedMore]: "If you want more, tell me.",
  [COPY.assumedOther]: "If you want a different amount, tell me.",
  [WHAT_TO_ORDER]: "What can I send you? Write me the list, send a photo or a voice note.",
  [WELCOME_ASK]: "I'll take your order and let you know when it's ready. What can I send you?",
  // The planner's fixed openers (domain/planner/wire.ts).
  "Va 👍": "OK 👍",
  "Con gusto.": "Happy to.",
  "Perfecto.": "Perfect.",
  "Ya vi tu lista 👍": "Got your list 👍",
  "Ya escuché tu nota de voz 👍": "Heard your voice note 👍",
  "Va, le agrego eso.": "OK, I'll add that.",
  "Dale, ya lo cambio.": "Sure, changing it now.",
  "Con gusto te ayudo con tu pedido 🙂": "Happy to help with your order 🙂",
  "Yo te ayudo con tu pedido 🙂": "I'll help you with your order 🙂",
  // Fixed messages outside the order flow (domain/copy.ts, domain/customer-controls.ts).
  [RECEIVED_PLACEHOLDER]: "Got your message. I'm looking at it.",
  [COULD_NOT_OPEN_MEDIA]: "I couldn't open that file. Can you send it again, or write me what you need?",
  [couldNotDownload("image")]: "I couldn't download the photo. Can you send it again, or write me what you need?",
  [couldNotDownload("audio")]: "I couldn't download the voice note. Can you send it again, or write me what you need?",
  [couldNotDownload("text")]: "I couldn't download the file. Can you send it again, or write me what you need?",
  [couldNotProcess("image")]: "Sorry, I couldn't read your photo. Can you send it again, or write me what you need?",
  [couldNotProcess("audio")]: "Sorry, I couldn't hear your voice note. Can you send it again, or write me what you need?",
  [HANDED_TO_STORE]: "I passed it to the store so they can help you 🙏",
  [CHANGE_AFTER_READY]: "It's ready already. Want to place a new order?",
  [CANCEL_AFTER_DISPATCH]: "It's already on the way; please talk to the store.",
  "¿Pauso los mensajes? 🙏": "Shall I pause the messages? 🙏",
  "_También podés escribir ALTO._": "_You can also write ALTO._",
  [STOPPED_REMINDER]: "Your messages are paused, so I'm not answering orders. If you want me to help you again, write SEGUIR.",
  [RESUMED]: "Done, we're back on. What can I send you?",
  [DELETION_CONFIRMED]:
    "Done, we'll delete your data from this store: your number, your name, your messages, photos and voice notes. " +
    "The amounts of your purchases and credit stay in the store's accounts, without your name or your number. " +
    "We won't write to you again.",
  "Listo, pausé los mensajes.": "Done, I paused the messages.",
  "Si querés que te atienda otra vez, escribí SEGUIR.": "If you want me to help you again, write SEGUIR.",
  "Si necesitás hablar con alguien de la tienda, pedímelo y le aviso.": "If you need to talk to someone at the store, ask me and I'll let them know.",
  "Listo, se lo dejo anotado a la tienda, te escriben por aquí.": "Done, I've noted it for the store, they'll write to you here.",
  // The questions and lines the replies build around a name (domain/replies.ts).
  "No alcancé a leer una parte de tu lista. ¿Me la escribís?": "I couldn't quite read part of your list. Can you write it for me?",
  "¿De qué tamaño lo querés?": "What size do you want?",
  "¿Cuál producto querés? Decime la marca o mandame una foto.": "Which product do you want? Tell me the brand or send a photo.",
  "Te ayudo con tu pedido. ¿Qué te mando?": "I'll help you with your order. What can I send you?",
  "¿Cuántos querés?": "How many do you want?",
  "¿Cuántos querés de cada uno?": "How many of each do you want?",
  "¿A dónde te lo llevamos? Mandame tu ubicación o escribime la dirección.": "Where should we deliver it? Send me your location or write me the address.",
  "Tengo estos:": "I have these:",
  "Te lo llevamos al lugar que nos diste.": "We'll take it to the place you gave us.",
  "Te lo llevamos. Falta la dirección.": "We'll deliver it. The address is still missing.",
  "Te lo llevamos.": "We'll deliver it.",
  "Falta la dirección.": "The address is still missing.",
  "El precio te lo confirmo.": "I'll confirm the price.",
  "Te esperamos 🙌": "See you soon 🙌",
  // Others.
  "¡Buenas! 👋": "Hi! 👋",
  "¿Lo recogés en la tienda o te lo llevamos?": "Will you pick it up at the store, or shall we deliver it?",
  "¿Lo pasás a traer o te lo llevamos?": "Will you come for it, or shall we deliver it?",
  "Te aviso apenas esté listo.": "I'll let you know as soon as it's ready.",
  "Te aviso cuando esté listo.": "I'll let you know when it's ready.",
  "Tu cambio fue aprobado. Tu pedido ya quedó actualizado ✅": "Your change was approved. Your order is updated ✅",
  "Tu pedido sigue como estaba.": "Your order stays as it was.",
};

/** What the customer side sends: the presets, and the button titles a tap echoes. */
const CUSTOMER_EN: Readonly<Record<string, string>> = {
  [DEMO_PRESETS.texto.body]: "Hi, send me 2 Coca-Cola 600 ml and a pound of beans, to go",
  [BUTTON_TITLES.confirm]: "Confirm",
  [BUTTON_TITLES.correct]: "Fix",
  [BUTTON_TITLES.cancel]: "Cancel",
  "Sí": "Yes",
  "Otro lugar": "Another place",
  "Sí, pausar": "Yes, pause",
  "🕘 Horario": "🕘 Hours",
  "✋ Hablar con alguien": "✋ Talk to someone",
};

/** The preset voice note, as spoken (scripts/make-demo-presets.mjs). */
export const VOICE_NOTE_EN =
  "Voice note: “Hi, I need a carton of eggs, two pounds of sugar and a pound of rice. I'll come by for it shortly.”";

/** The demo store's products (application/demo-store.ts), longest first so "Pan dulce" wins over "Pan". */
const PRODUCTS_EN: readonly (readonly [string, string])[] = (
  [
    ["Cartón de huevos", "Carton of eggs"],
    ["Huevo (unidad)", "Egg (each)"],
    ["Agua Azul", "Agua Azul water"],
    ["Frijoles rojos", "Red beans"],
    ["Arroz", "Rice"],
    ["Azúcar", "Sugar"],
    ["Maseca", "Maseca corn flour"],
    ["Harina de trigo", "Wheat flour"],
    ["Aceite Clover", "Clover cooking oil"],
    ["Manteca", "Lard"],
    ["Leche entera", "Whole milk"],
    ["Mantequilla crema", "Honduran table cream"],
    ["Queso seco", "Hard salted cheese"],
    ["Café molido", "Ground coffee"],
    ["Pan de molde", "Sliced bread"],
    ["Pan dulce (unidad)", "Sweet bread (each)"],
    ["Tortillas (paquete de 10)", "Tortillas (pack of 10)"],
    ["Consomé de pollo (cubito)", "Chicken bouillon (cube)"],
    ["Sal", "Salt"],
    ["Salsa de tomate", "Tomato sauce"],
    ["Espagueti", "Spaghetti"],
    ["Sardina en lata", "Canned sardines"],
    ["Jabón Xtra (barra)", "Xtra soap (bar)"],
    ["Detergente", "Detergent"],
    ["Papel higiénico (4 rollos)", "Toilet paper (4 rolls)"],
    ["Pasta dental", "Toothpaste"],
    ["Baleadas congeladas (paquete)", "Frozen baleadas (pack)"],
    ["Tajadas de plátano", "Fried plantain slices"],
    ["Galletas de soda", "Soda crackers"],
    ["Chicle (unidad)", "Gum (each)"],
    ["Bolsa de hielo", "Bag of ice"],
    ["Gas para encendedor", "Lighter refill gas"],
  ] as const
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length);

const ORDINALS_EN: Readonly<Record<string, string>> = {
  primero: "first", segundo: "second", tercero: "third", cuarto: "fourth", quinto: "fifth",
  sexto: "sixth", "séptimo": "seventh", octavo: "eighth", noveno: "ninth", "décimo": "tenth",
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const PRODUCT_PATTERN = new RegExp(`(^|[^\\p{L}])(${PRODUCTS_EN.map(([es]) => escape(es)).join("|")})(?![\\p{L}])`, "gu");
const PRODUCT_MAP = new Map(PRODUCTS_EN);

/** Product names and amounts inside a line: "2 libras de Azúcar" → "2 lb Sugar". */
function wordsIn(text: string): string {
  return text
    .replace(/\bmedia libra de /gu, "½ lb ")
    .replace(/\b(\d+(?:[.,]\d+)?) libras? de /gu, "$1 lb ")
    .replace(/\b(\d+(?:[.,]\d+)?) libras?\b/gu, "$1 lb")
    .replace(/ de envío\b/gu, " delivery fee")
    .replace(/\(te puse (\d+(?:[.,]\d+)?)\)/gu, "(I put down $1)")
    .replace(/ y /gu, " and ")
    .replace(PRODUCT_PATTERN, (_m, before: string, name: string) => `${before}${PRODUCT_MAP.get(name) ?? name}`);
}

const DAYS_EN: Readonly<Record<string, string>> = {
  lunes: "Monday", martes: "Tuesday", "miércoles": "Wednesday", jueves: "Thursday", viernes: "Friday", "sábado": "Saturday", domingo: "Sunday",
};
const DAY = "(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const CLOCK = "(\\d{1,2}(?::\\d{2})? (?:a\\.m\\.|p\\.m\\.|noon))";

/** The hours as `formatStoreHours` says them: "de lunes a sábado de 6 a. m. a 8 p. m., y el domingo …". */
export function hoursInEnglish(when: string): string {
  return when
    .replace(/12 del mediodía/gu, "12 noon")
    .replace(/a\. m\./gu, "a.m.")
    .replace(/p\. m\./gu, "p.m.")
    .replace(/\b(lunes|martes|miércoles|jueves|viernes|sábado|domingo)(?![\p{L}])/gu, (day: string) => DAYS_EN[day] ?? day)
    .replace(new RegExp(`\\bde ${DAY} a ${DAY}`, "gu"), "$1 to $2")
    .replace(new RegExp(`\\bel ${DAY}`, "gu"), "$1")
    .replace(new RegExp(`\\bde ${CLOCK} a ${CLOCK}`, "gu"), "from $1 to $2")
    .replace(/, y /gu, ", and ")
    .replace(/ y /gu, " and ");
}

type Rule = readonly [RegExp, (...groups: string[]) => string];

/** Sentences built around a name, an amount or a product. */
const RULES: readonly Rule[] = [
  [/^¡Buenas! 👋 Soy el asistente de \*(.+)\* 🛒$/u, (store) => `Hi! 👋 I'm the ordering assistant for *${store}* 🛒`],
  [/^¡Buenas, (.+)! 👋$/u, (name) => `Hi, ${name}! 👋`],
  [/^_Si no querés recibir mensajes, escribí ALTO\.(?: Tus datos: (\S+))?_$/u, (url) => `_To stop messages, write ALTO.${url ? ` Your data: ${url}` : ""}_`],
  [/^_Tus datos: (\S+)_$/u, (url) => `_Your data: ${url}_`],
  [/^Listo(?:, (.+?))? 🙌 Tu pedido( #\S+)? quedó anotado\.(?: Total: (L [\d.,]+)\.)? Te aviso cuando esté listo\.$/u,
    (name, code, total) => `Done${name ? `, ${name}` : ""} 🙌 Your order${code ?? ""} is in.${total ? ` Total: ${total}.` : ""} I'll let you know when it's ready.`],
  [/^Vas (\S+) en la fila\.$/u, (nth) => `You're ${ORDINALS_EN[nth] ?? nth} in line.`],
  [/^Vas en el lugar (\d+) de la fila\.$/u, (n) => `You're number ${n} in line.`],
  [/^Total: (L [\d.,]+), sin ((?:(?!\. ).)+)\.$/u, (total, names) => `Total: ${total}, without ${wordsIn(names.replace(/ ni /gu, " or "))}.`],
  [/^Total: ((?:(?!\. ).)+)$/u, (rest) => `Total: ${wordsIn(rest)}`],
  [/^Me falta saber cuánto querés de ((?:(?!\. ).)+)\.$/u, (names) => `I still need to know how much you want of ${wordsIn(names)}.`],
  // "Te puse 1 de piña y catsup." or "Te puse 2 de piña y 1 de tomate.": one sentence, never the next one.
  [/^Te puse ((?:(?!\. ).)+)\.$/u, (said) => `I put down ${wordsIn(said.replace(/(\d+(?:[.,]\d+)?) de /gu, "$1 of "))}.`],
  [/^Para (.+) tengo:$/u, (name) => `For ${wordsIn(name)} I have:`],
  [/^(\d+)\. (.+)$/u, (n, option) => `${n}. ${wordsIn(option)}`],
  [/^Escribime todo junto, por ejemplo: «(.+)»\.$/u, (example) => `Write it all in one message, for example: «${example}».`],
  [/^Escribime, por ejemplo: «(.+)»\.$/u, (example) => `Write me, for example: «${example}».`],
  [/^De (.+) ahorita me aparecen ((?:(?!\. ).)+)\.$/u, (name, left) => `Right now I show ${wordsIn(left)} of ${wordsIn(name)}.`],
  [/^¿Te mando (.+) o lo quitamos\?$/u, (left) => `Shall I send ${wordsIn(left)}, or remove it?`],
  [/^Escribime (.+) o quitar\.$/u, (left) => `Reply ${left} or quitar (remove).`],
  [/^Ahorita no hay ((?:(?!\. ).)+)\.$/u, (name) => `We're out of ${wordsIn(name)} right now.`],
  [/^Te lo llevamos a: (.+)$/u, (place) => `We'll deliver it to: ${place}`],
  [/^La vez pasada te lo llevamos a: (.+)\.$/u, (place) => `Last time we took it to: ${place}.`],
  [/^Tu saldo pendiente con la tienda es (L [\d.,]+)\.$/u, (amount) => `Your balance with the store is ${amount}.`],
  [/^Listo, se lo dejo anotado a (.+), te escribe por aquí\.$/u, (name) => `Done, I've noted it for ${name}, they'll write to you here.`],
  [/^Si necesitás hablar con (.+), pedímelo y le aviso\.$/u, (name) => `If you need to talk to ${name}, ask me and I'll let them know.`],
  [/^¿Cuánto querés de (.+)\?$/u, (name) => `How much ${wordsIn(name)} do you want?`],
  [/^¿Cuántas libras querés de (.+)\?$/u, (name) => `How many pounds of ${wordsIn(name)}?`],
  [/^¿De qué tamaño querés (.+)\?$/u, (name) => `What size ${wordsIn(name)}?`],
  [/^¿Cuál (.+) querés\? Decime la marca o mandame una foto\.$/u, (name) => `Which ${wordsIn(name)}? Tell me the brand or send a photo.`],
  [/^No alcancé a leer bien (.+)\. ¿Me lo escribís\?$/u, (name) => `I couldn't quite read ${wordsIn(name)}. Can you write it for me?`],
  [/^No alcancé a leer bien (.+)\. ¿Me los escribís\?$/u, (names) => `I couldn't quite read ${wordsIn(names)}. Can you write them for me?`],
  [/^(.+): sí hay\.$/u, (name) => `${wordsIn(name)}: in stock.`],
  [/^([^•].*): ahorita no hay\.$/u, (name) => `${wordsIn(name)}: out of stock right now.`],
  [/^(.+): el precio te lo confirmo\.$/u, (name) => `${wordsIn(name)}: I'll confirm the price.`],
  [/^(.+): te confirmo si hay\.$/u, (name) => `${wordsIn(name)}: I'll confirm whether we have it.`],
  [/^([^•\d].*): (L [\d.,]+)\.$/u, (name, price) => `${wordsIn(name)}: ${price}.`],
  [/^(•\s)?(.+): eso solo lo vendemos aquí en la tienda\.$/u, (bullet, name) => `${bullet ?? ""}${wordsIn(name)}: only sold here in the store.`],
  [/^¿Te mandamos (.+?)(?: \((L [\d.,]+)\))? o lo quitamos\?(.*)$/u, (item, price, rest) =>
    `Shall we send ${wordsIn(item)}${price ? ` (${price})` : ""} instead, or remove it?${rest ? ` ${sentences(rest.trim())}` : ""}`],
  [/^Perdón, ahorita no hay (.+?) 😔(.*)$/u, (name, rest) => `Sorry, we're out of ${wordsIn(name)} right now 😔${rest ? ` ${sentences(rest.trim())}` : ""}`],
  [/^Tu pedido queda en (L [\d.,]+)\.$/u, (total) => `Your order comes to ${total}.`],
  [/^Si querés otra cosa en su lugar, decime\.$/u, () => "If you want something else instead, tell me."],
  // "¡Tu pedido #12 ya está listo! 🙌 Total: L 50, sin Arroz. Ya podés pasar a traerlo." Code and the rest optional.
  [/^¡Tu pedido(?: #(\S+))? ya está listo! 🙌(?: (.+))?$/u, (code, rest) =>
    `Your order${code ? ` #${code}` : ""} is ready! 🙌${rest ? ` ${sentences(rest)}` : ""}`],
  [/^Tu pedido #(\S+) ya está listo\.$/u, (code) => `Your order #${code} is ready.`],
  [/^Se lo dejo anotado a (.+), te escribe por aquí\.$/u, (name) => `I've noted it for ${name}, they'll write to you here.`],
  [/^La tienda confirmó tu pago de (L [\d.,]+)\. ¡Gracias!$/u, (amount) => `The store confirmed your payment of ${amount}. Thanks!`],
  [/^No pudimos hacer el cambio: (.+)\.$/u, (reason) => `We couldn't make the change: ${reason}.`],
  [/^Tu pedido va en camino con (.+) 🛵$/u, (name) => `Your order is on its way with ${name} 🛵`],
  [/^Abrimos (.+)$/u, (when) => `We're open ${hoursInEnglish(when)}`],
  // Bullets: the readback's lines and the echo.
  [/^• Agregar (.+)$/u, (item) => `• Add ${wordsIn(item)}`],
  [/^• Quitar (.+)$/u, (item) => `• Remove ${wordsIn(item)}`],
  [/^• (.+) \(antes (.+)\)$/u, (item, before) => `• ${wordsIn(item)} (was ${before === "sin cantidad" ? "no amount" : wordsIn(before)})`],
  [/^(•|…) ?y (\d+) más$/u, (mark, n) => `${mark} and ${n} more`],
  [/^• (.+) \(¿cuántas libras\?\)$/u, (item) => `• ${wordsIn(item)} (how many pounds?)`],
  [/^• (.+): ahorita no hay\.$/u, (item) => `• ${wordsIn(item)}: out of stock right now.`],
  [/^• (.+): falta la cantidad\.$/u, (item) => `• ${wordsIn(item)}: amount missing.`],
  [/^• (.+): me aparecen (.+)\.$/u, (item, left) => `• ${wordsIn(item)}: I show ${wordsIn(left)} in stock.`],
  [/^• (.+)$/u, (item) => `• ${wordsIn(item)}`],
];

/** One sentence, or null when it isn't known. */
function sentence(text: string): string | null {
  const fixed = FIXED_EN[text];
  if (fixed !== undefined) return fixed;
  for (const [pattern, render] of RULES) {
    const match = pattern.exec(text);
    if (match !== null) return render(...match.slice(1).map((group) => group ?? ""));
  }
  return null;
}

/** A line of several sentences, each translated on its own; unknown ones stay as they are. */
function sentences(text: string): string {
  return text
    .split(/(?<=[.!?…])\s+(?=[¡¿\p{Lu}_])/u)
    .map((part) => sentence(part) ?? part)
    .join(" ");
}

/** A leading emoji ("🏪 ", "💵 ") is kept and the rest translated. */
const EMOJI_LEAD = /^((?:\p{Extended_Pictographic}|️)+\s+)(.*)$/u;

function line(text: string): { readonly text: string; readonly known: boolean } {
  if (text.trim() === "") return { text, known: false };
  const whole = sentence(text);
  if (whole !== null) return { text: whole, known: true };
  const lead = EMOJI_LEAD.exec(text);
  const [prefix, rest] = lead === null ? ["", text] : [lead[1]!, lead[2]!];
  const translated = sentences(rest);
  return { text: `${prefix}${translated}`, known: translated !== rest };
}

/** The store's message in English, line by line; null when nothing in it is known. */
export function replyInEnglish(body: string | null): string | null {
  if (body === null || body.trim() === "") return null;
  const lines = body.split("\n").map(line);
  return lines.some((l) => l.known) ? lines.map((l) => l.text).join("\n") : null;
}

/** What the customer sent, in English: the presets and button taps. Typed text gets none. */
export function customerInEnglish(kind: string, body: string | null): string | null {
  if (kind === "image") return "Photo of a handwritten order list";
  if (kind === "audio") return VOICE_NOTE_EN;
  return body === null ? null : (CUSTOMER_EN[body.trim()] ?? talkTo(body.trim()));
}

/** The first message's "🙋 Hablar con Johan" button, with the owner's name in it. */
function talkTo(title: string): string | null {
  const name = /^🙋 Hablar con (.+)$/u.exec(title)?.[1];
  return name === undefined ? null : `🙋 Talk to ${name}`;
}

/** A button's title in English, for a small label under it. */
export function buttonInEnglish(title: string): string | null {
  return CUSTOMER_EN[title] ?? FIXED_EN[title] ?? talkTo(title);
}

/** Every fixed sentence the assistant can send, for the coverage test. */
export const FIXED_SPANISH: readonly string[] = [...Object.values(COPY), ...SAY_PHRASES.filter((p) => p !== "")];
