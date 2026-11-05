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
import { WELCOME_ASK } from "../../domain/customer-controls";
import { DEMO_PRESETS } from "../../domain/demo";

/** Every fixed reply sentence, Spanish → English. A test checks each COPY entry and phrase has one. */
export const FIXED_EN: Readonly<Record<string, string>> = {
  [COPY.safeReply]: "Let me check and I'll confirm.",
  [COPY.slowNotice]: "We got your message, we're looking at it.",
  [COPY.typedFallback]: "Reply Confirm, Fix or Cancel.",
  [COPY.typedFallbackSoft]: "_Or write: confirm, fix or cancel._",
  [COPY.fixHint]: "If something's wrong, write to me or send a voice note.",
  [COPY.confirmLater]: "For these I'll confirm stock and price",
  [COPY.readbackTitle]: "Your order:",
  [COPY.changedTitle]: "Done, here's your order now:",
  [COPY.staleTapTitle]: "Your order changed since that message. Here it is now:",
  [COPY.confirmQuestion]: "Shall I prepare it like this?",
  [COPY.soldOutAll]: "What else can I send you? If you don't want anything else, reply Cancel.",
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
  [COPY.changeRequested]: "Your order was already confirmed, so I passed this change to the store:",
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
  [COPY.refusedTap]: "That button no longer applies. If you need something with your order, write to me.",
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
  [COPY.confirmNudge]: "To get it ready, tap Confirmar ✅",
  [COPY.confirmNudgeTyped]: "To get it ready, reply Confirmar.",
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
  // Others.
  "¡Buenas! 👋": "Hi! 👋",
  "¿Lo recogés en la tienda o te lo llevamos?": "Will you pick it up at the store, or shall we deliver it?",
  "¿Lo pasás a traer o te lo llevamos?": "Will you come for it, or shall we deliver it?",
  "Te aviso apenas esté listo.": "I'll let you know as soon as it's ready.",
  "Te aviso cuando esté listo.": "I'll let you know when it's ready.",
  "¡Tu pedido ya está listo! 🙌": "Your order is ready! 🙌",
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
    ["Mantequilla crema", "Cream butter"],
    ["Queso seco", "Dry cheese"],
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
    ["Tajadas de plátano", "Plantain chips"],
    ["Galletas de soda", "Soda crackers"],
    ["Chicle (unidad)", "Gum (each)"],
    ["Bolsa de hielo", "Bag of ice"],
    ["Gas para encendedor", "Lighter fluid"],
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
    .replace(/ de envío\b/gu, " delivery")
    .replace(/ y /gu, " and ")
    .replace(PRODUCT_PATTERN, (_m, before: string, name: string) => `${before}${PRODUCT_MAP.get(name) ?? name}`);
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
  [/^Total: (.+)$/u, (rest) => `Total: ${wordsIn(rest)}`],
  [/^Me falta saber cuánto querés de (.+)\.$/u, (names) => `I still need to know how much you want of ${wordsIn(names)}.`],
  [/^Te puse 1 de (.+)\.$/u, (names) => `I put down 1 of ${wordsIn(names)}.`],
  [/^¿Cuánto querés de (.+)\?$/u, (name) => `How much ${wordsIn(name)} do you want?`],
  [/^¿Cuántas libras querés de (.+)\?$/u, (name) => `How many pounds of ${wordsIn(name)}?`],
  [/^¿De qué tamaño querés (.+)\?$/u, (name) => `What size ${wordsIn(name)}?`],
  [/^¿Cuál (.+) querés\? Decime la marca o mandame una foto\.$/u, (name) => `Which ${wordsIn(name)}? Tell me the brand or send a photo.`],
  [/^No alcancé a leer bien (.+)\. ¿Me lo escribís\?$/u, (name) => `I couldn't quite read ${wordsIn(name)}. Can you write it for me?`],
  [/^No alcancé a leer bien (.+)\. ¿Me los escribís\?$/u, (names) => `I couldn't quite read ${wordsIn(names)}. Can you write them for me?`],
  [/^(.+): sí hay\.$/u, (name) => `${wordsIn(name)}: in stock.`],
  [/^(•\s)?(.+): eso solo lo vendemos aquí en la tienda\.$/u, (bullet, name) => `${bullet ?? ""}${wordsIn(name)}: only sold here in the store.`],
  [/^¿Te mandamos (.+?)(?: \((L [\d.,]+)\))? o lo quitamos\?(.*)$/u, (item, price, rest) =>
    `Shall we send ${wordsIn(item)}${price ? ` (${price})` : ""} instead, or remove it?${rest ? ` ${sentences(rest.trim())}` : ""}`],
  [/^Perdón, ahorita no hay (.+?) 😔(.*)$/u, (name, rest) => `Sorry, we're out of ${wordsIn(name)} right now 😔${rest ? ` ${sentences(rest.trim())}` : ""}`],
  [/^Tu pedido queda en (L [\d.,]+)\.$/u, (total) => `Your order comes to ${total}.`],
  [/^Si querés otra cosa en su lugar, decime\.$/u, () => "If you want something else instead, tell me."],
  [/^¡Tu pedido #(\S+) ya está listo! 🙌$/u, (code) => `Your order #${code} is ready! 🙌`],
  [/^Tu pedido #(\S+) ya está listo\.$/u, (code) => `Your order #${code} is ready.`],
  [/^Se lo dejo anotado a (.+), te escribe por aquí\.$/u, (name) => `I've noted it for ${name}, they'll write to you here.`],
  [/^La tienda confirmó tu pago de (L [\d.,]+)\. ¡Gracias!$/u, (amount) => `The store confirmed your payment of ${amount}. Thanks!`],
  [/^No pudimos hacer el cambio: (.+)\.$/u, (reason) => `We couldn't make the change: ${reason}.`],
  [/^Tu pedido va en camino con (.+) 🛵$/u, (name) => `Your order is on its way with ${name} 🛵`],
  [/^Abrimos (.+)$/u, (when) => `We're open ${when}`],
  // Bullets: the readback's lines and the echo.
  [/^• Agregar (.+)$/u, (item) => `• Add ${wordsIn(item)}`],
  [/^• Quitar (.+)$/u, (item) => `• Remove ${wordsIn(item)}`],
  [/^• (.+) \(antes (.+)\)$/u, (item, before) => `• ${wordsIn(item)} (was ${wordsIn(before)})`],
  [/^(•|…) ?y (\d+) más$/u, (mark, n) => `${mark} and ${n} more`],
  [/^• (.+) \(¿cuántas libras\?\)$/u, (item) => `• ${wordsIn(item)} (how many pounds?)`],
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
  return body === null ? null : (CUSTOMER_EN[body.trim()] ?? null);
}

/** A button's title in English, for a small label under it. */
export function buttonInEnglish(title: string): string | null {
  return CUSTOMER_EN[title] ?? FIXED_EN[title] ?? null;
}

/** Every fixed sentence the assistant can send, for the coverage test. */
export const FIXED_SPANISH: readonly string[] = [...Object.values(COPY), ...SAY_PHRASES.filter((p) => p !== "")];
