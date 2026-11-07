/** English for the order screens' sentences that carry a name, a time or a step number. */
import { describe, expect, it } from "vitest";
import { englishPhrase } from "../src/interfaces/http/console/language";

describe("order screen sentences in the English view", () => {
  it.each([
    ["Marta Reyes cambió el pedido a las 8:05 a. m. Revisá la línea marcada.", /^Marta Reyes changed the order at 8:05 a\.m\. Check the marked line\.$/],
    ["El pedido cambió. Revisá las líneas marcadas.", /^The order changed\. Check the marked lines\.$/],
    ["Al marcar Listo se le avisa a Rosa con el total.", /^Marking it Ready lets Rosa know the total\.$/],
    ["Al marcar Listo se le avisa al cliente.", /^Marking it Ready lets the customer know\.$/],
    ["Ya está listo. Cuando Rosa ya lo tenga, tocá Entregado.", /^It's ready\. When Rosa has it, tap Delivered\.$/],
    ["agente planner-1", /^agent planner-1$/],
    ["cambió 3:04 p. m.", /^changed 3:04 p\.?\s?m\.?$/],
  ])("%s", (spanish, english) => {
    expect(englishPhrase(spanish)).toMatch(english);
  });
});
