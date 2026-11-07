/**
 * The demo phone's English subtitles (D-63): every fixed sentence the assistant can send has one, the
 * messages seen live translate whole, and nothing unknown is guessed.
 */
import { describe, expect, it } from "vitest";
import { DEMO_PRESETS } from "../src/domain/demo";
import { FIXED_EN, FIXED_SPANISH, buttonInEnglish, customerInEnglish, replyInEnglish } from "../src/interfaces/http/demo-english";
import type { EngineOutcome, OrderLineView, OrderView } from "../src/domain/contract/outcomes";
import { RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { renderNotice, renderOutcome } from "../src/domain/replies";
import { readbackOrder, readyOrder } from "./fixtures/contract";

const item = (n: number, over: Partial<OrderLineView>): OrderLineView => ({
  lineId: `line-${n}`,
  text: "",
  productId: `p-${n}`,
  productName: null,
  quantity: "1",
  unit: null,
  unitPrice: null,
  availability: "hay",
  restricted: false,
  mark: null,
  substitute: null,
  ...over,
});

const say = (outcome: EngineOutcome) => renderOutcome(outcome, { customerId: "c-1" })!.body;
const english = (body: string) => replyInEnglish(body);

describe("the demo's English subtitles", () => {
  it("know every fixed sentence the assistant can send", () => {
    const missing = FIXED_SPANISH.filter((spanish) => FIXED_EN[spanish] === undefined);
    expect(missing).toEqual([]);
  });

  it("translate a first readback whole, keeping amounts, prices and the store's name", () => {
    const body = [
      "¡Buenas! 👋 Soy el asistente de *Mercadito Demo* 🛒",
      "",
      "Ya escuché tu nota de voz 👍",
      "",
      "Tu pedido:",
      "• 1 Cartón de huevos (30) · L 135",
      "• 2 libras de Azúcar · L 32",
      "• 1 libra de Arroz · L 18",
      "",
      "🏪 Lo pasás a traer a la tienda.",
      "💵 Total: L 185. Pagás cuando lo recogés.",
      "",
      "¿Te lo preparo así?",
      "",
      "_Si no querés recibir mensajes, escribí ALTO. Tus datos: http://127.0.0.1:8794/privacidad_",
    ].join("\n");
    expect(replyInEnglish(body)).toBe(
      [
        "Hi! 👋 I'm the ordering assistant for *Mercadito Demo* 🛒",
        "",
        "Heard your voice note 👍",
        "",
        "Your order:",
        "• 1 Carton of eggs (30) · L 135",
        "• 2 lb Sugar · L 32",
        "• 1 lb Rice · L 18",
        "",
        "🏪 You pick it up at the store.",
        "💵 Total: L 185. You pay when you pick it up.",
        "",
        "Shall I prepare it like this?",
        "",
        "_To stop messages, write ALTO. Your data: http://127.0.0.1:8794/privacidad_",
      ].join("\n"),
    );
  });

  it("translate the confirmation, the name question and a change passed to the store", () => {
    expect(replyInEnglish("¡Va! ¿A nombre de quién lo anoto?")).toBe("Great! What name should I put the order under?");
    expect(replyInEnglish("Listo, Marta 🙌 Tu pedido quedó anotado. Total: L 74. Te aviso cuando esté listo.")).toBe(
      "Done, Marta 🙌 Your order is in. Total: L 74. I'll let you know when it's ready.",
    );
    expect(
      replyInEnglish(
        [
          "Ya vi tu lista 👍",
          "",
          "Tu pedido ya está confirmado. Este cambio está esperando que la tienda lo revise:",
          "• Agregar 3 libras de Arroz",
          "• Agregar 2 Aceite Clover 1 L",
          "• 3 Azúcar 1 lb (antes 2)",
          "• y 1 más",
          "Te aviso apenas lo revisen.",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Got your list 👍",
        "",
        "Your order is already confirmed. This change is waiting for the store to review it:",
        "• Add 3 lb Rice",
        "• Add 2 Clover cooking oil 1 L",
        "• 3 Sugar 1 lb (was 2)",
        "• and 1 more",
        "I'll let you know as soon as they review it.",
      ].join("\n"),
    );
    expect(replyInEnglish("Vas primero en la fila. Te aviso apenas esté listo.")).toBe("You're first in line. I'll let you know as soon as it's ready.");
  });

  it("keep the words the assistant reads in Spanish, and say hours, the delivery fee and products plainly", () => {
    expect(replyInEnglish("Respondé Confirmar, Corregir o Cancelar.")).toBe("Reply Confirmar, Corregir or Cancelar (confirm, fix or cancel).");
    expect(replyInEnglish("Total: L 74 (L 54 + L 20 de envío).")).toBe("Total: L 74 (L 54 + L 20 delivery fee).");
    expect(replyInEnglish("Abrimos de lunes a sábado de 6 a. m. a 8 p. m., y el domingo de 7 a. m. a 12 del mediodía.")).toBe(
      "We're open Monday to Saturday from 6 a.m. to 8 p.m., and Sunday from 7 a.m. to 12 noon.",
    );
    expect(replyInEnglish("• 1 Gas para encendedor · L 30")).toBe("• 1 Lighter refill gas · L 30");
  });

  it("never guess: an unknown sentence stays Spanish, and a message with nothing known gets no subtitle", () => {
    expect(replyInEnglish("Una frase que no conocemos.")).toBeNull();
    expect(replyInEnglish("Perfecto. Una frase que no conocemos.")).toBe("Perfect. Una frase que no conocemos.");
    expect(replyInEnglish(null)).toBeNull();
    // "Sal" (salt) never eats "Salsa de tomate".
    expect(replyInEnglish("• 2 Salsa de tomate · L 40")).toBe("• 2 Tomato sauce · L 40");
  });

  it("translate what the customer side sends: the presets and taps, never typed text", () => {
    expect(customerInEnglish("text", DEMO_PRESETS.texto.body)).toBe("Hi, send me 2 Coca-Cola 600 ml and a pound of beans, to go");
    expect(customerInEnglish("interactive", "Confirmar")).toBe("Confirm");
    expect(customerInEnglish("audio", null)).toContain("a carton of eggs, two pounds of sugar and a pound of rice");
    expect(customerInEnglish("image", null)).toBe("Photo of a handwritten order list");
    expect(customerInEnglish("text", "quiero 3 libras de arroz")).toBeNull();
    expect(buttonInEnglish("Corregir")).toBe("Fix");
    expect(buttonInEnglish("🙋 Hablar con Johan")).toBe("🙋 Talk to Johan");
    expect(customerInEnglish("interactive", "🙋 Hablar con Johan")).toBe("🙋 Talk to Johan");
  });

  it("translate the ready notice with its number, total, missing items and pickup line", () => {
    const order: OrderView = {
      ...readyOrder,
      code: "12",
      lines: [
        item(1, { productName: "Arroz", quantity: "2", unitPrice: 1800 }),
        item(2, { productName: "Frijoles rojos", availability: "se_acabo", mark: "no_hay" }),
      ],
      total: 3600,
    };
    const body = renderNotice({ type: "order_ready", order }).body;
    expect(body).toBe("¡Tu pedido #12 ya está listo! 🙌 Total: L 36, sin Frijoles rojos. Ya podés pasar a traerlo.");
    expect(english(body)).toBe("Your order #12 is ready! 🙌 Total: L 36, without Red beans. You can come by for it.");
    const plain = renderNotice({ type: "order_ready", order: readyOrder }).body;
    expect(english(plain)).toBe("Your order is ready! 🙌 Total: L 345. You can come by for it.");
  });

  it("translate the planner's assumed amount without swallowing the next sentence, and the bare product question", () => {
    const order: OrderView = { ...readbackOrder, state: "armando", lines: [item(1, { productName: "Arroz", quantitySource: "suggested" })] };
    const body = say({ type: "ask", question: "quantities", line: null, order, questions: { kind: "fulfillment", lineIds: [] }, assumed: ["line-1"] });
    expect(body).toBe("Te puse 1 de Arroz. Si querés más, decime.\n\n¿Lo recogés en la tienda o te lo llevamos?");
    expect(english(body)).toBe("I put down 1 of Rice. If you want more, tell me.\n\nWill you pick it up at the store, or shall we deliver it?");
    expect(english("¿Cuál producto querés? Decime la marca o mandame una foto.")).toBe("Which product do you want? Tell me the brand or send a photo.");
  });

  it("translate options, the quantities example, stock lines and the delivery place", () => {
    const order: OrderView = { ...readbackOrder, state: "armando", lines: [item(1, { text: "aceite", productId: null, quantity: null })] };
    const options = say({
      type: "ask",
      question: "ambiguous_product",
      line: 0,
      order,
      questions: { kind: "options", lineIds: ["line-1"], options: { "line-1": [
        { productId: "p-a", name: "Aceite Clover 1 L", unitPrice: 6000 },
        { productId: "p-b", name: "Manteca", unitPrice: null },
      ] } },
    });
    expect(english(options)).toBe("For aceite I have:\n1. Clover cooking oil 1 L · L 60\n2. Lard\nWhich one should I send? Reply with the number or the name.");
    expect(english("¿Cuántos querés de estos?\n• Arroz (¿cuántas libras?)\n• Sal\nEscribime todo junto, por ejemplo: «2 libras de arroz, 1 sal».")).toBe(
      "How many of these do you want?\n• Rice (how many pounds?)\n• Salt\nWrite it all in one message, for example: «2 libras de arroz, 1 sal».",
    );
    const stocked: OrderView = {
      ...readbackOrder,
      fulfillment: { mode: "delivery", placeId: null, placeText: "Barrio El Centro, frente a la iglesia", fee: null },
      lines: [
        item(1, { productName: "Arroz", quantity: "5", inStock: "3", unitPrice: 1800 }),
        item(2, { productName: "Sal", availability: "se_acabo", mark: "no_hay" }),
        item(3, { productName: "Azúcar", quantity: null }),
        item(4, { productName: "Café molido", quantitySource: "suggested", unitPrice: 4000 }),
      ],
      total: null,
    };
    expect(english(say({ type: "readback", order: stocked }))).toBe(
      [
        "Your order:",
        "• 5 Rice: I show 3 in stock.",
        "• Salt: out of stock right now.",
        "• Sugar: amount missing.",
        "• 1 Ground coffee (I put down 1) · L 40",
        "",
        "📍 We'll deliver it to: Barrio El Centro, frente a la iglesia",
        "💵 I'll confirm the total. You pay when we deliver it.",
        "",
        "Right now I show 3 of Rice. Shall I send 3, or remove it?",
        "Reply 3 or quitar (remove).",
      ].join("\n"),
    );
  });

  it("translate answers, the balance, the ready status, the substitute offer and the placeholder", () => {
    const answer = say({ type: "answer", topic: "price", facts: [
      { asked: "arroz", productId: "p-1", unitPrice: 1800, availability: "hay", restricted: false },
      { asked: "frijoles", productId: null, unitPrice: null, availability: "no_se", restricted: false },
    ] });
    expect(english(answer)).toBe("Rice: L 18.\nFrijoles: I'll confirm the price.");
    expect(english(say({ type: "answer", topic: "availability", facts: [
      { asked: "sal", productId: "p-1", unitPrice: null, availability: "se_acabo", restricted: false },
      { asked: "leche", productId: null, unitPrice: null, availability: "no_se", restricted: false },
    ] }))).toBe("Salt: out of stock right now.\nLeche: I'll confirm whether we have it.");
    expect(english(say({ type: "balance", balance: 12050 }))).toBe("Your balance with the store is L 120.50.");
    expect(english(say({ type: "order_status", order: { ...readyOrder, code: "7" } }))).toBe("Your order #7 is ready. See you soon 🙌");
    const offer = renderNotice({
      type: "substitute_offered",
      lineId: "line-1",
      order: { ...readbackOrder, state: "confirmado", lines: [item(1, { productName: "Arroz", availability: "se_acabo", substitute: { productId: "p-9", productName: "Maseca", unitPrice: null } })] },
    }).body;
    expect(english(offer)).toBe("We're out of Rice right now. Shall we send Maseca corn flour instead, or remove it? I'll confirm the price. Tap a button or tell me which you prefer.");
    expect(english(["¡Buenas! 👋 Soy el asistente de *Mercadito Demo* 🛒", RECEIVED_PLACEHOLDER, "_Si no querés recibir mensajes, escribí ALTO._"].join("\n"))).toBe(
      "Hi! 👋 I'm the ordering assistant for *Mercadito Demo* 🛒\nGot your message. I'm looking at it.\n_To stop messages, write ALTO._",
    );
  });
});
