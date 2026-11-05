/**
 * The demo phone's English subtitles (D-63): every fixed sentence the assistant can send has one, the
 * messages seen live translate whole, and nothing unknown is guessed.
 */
import { describe, expect, it } from "vitest";
import { DEMO_PRESETS } from "../src/domain/demo";
import { FIXED_EN, FIXED_SPANISH, buttonInEnglish, customerInEnglish, replyInEnglish } from "../src/interfaces/http/demo-english";

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
      "🏪 Lo recogés en la tienda.",
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
  });
});
