import { describe, expect, it } from "vitest";
import { parseReadbackButton, readbackOperationKey, typedReadbackWord } from "../src/domain/burst";
import { normalizeCustomerName } from "../src/domain/customer";

describe("readback answers", () => {
  it("accept the three words typed alone, in any case, with or without accents and punctuation", () => {
    for (const text of ["confirmar", "Confirmar", "CONFIRMAR", "confirmár", " Confirmar! ", "¡Confirmar!", "confirmar."]) {
      expect(typedReadbackWord(text)).toBe("confirm");
    }
    expect(typedReadbackWord("Corregir")).toBe("correct");
    expect(typedReadbackWord("CANCELÁR")).toBe("cancel");
  });

  it("treat anything longer as a message to read", () => {
    for (const text of ["confirmar pero sin arroz", "no confirmar", "confirmado", "", null, "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(typedReadbackWord(text)).toBeNull();
    }
  });

  it("parse button IDs that are operation keys, and refuse anything else", () => {
    expect(parseReadbackButton("confirm:o-1:v3")).toEqual({ word: "confirm", orderId: "o-1", version: 3 });
    expect(parseReadbackButton("cancel:abc:def:v1")).toEqual({ word: "cancel", orderId: "abc:def", version: 1 });
    for (const id of ["confirm:o-1:v0", "confirm:o-1", "approve:o-1:v1", "confirm::v1", "confirm:o 1:v1", `confirm:${"x".repeat(250)}:v1`, null]) {
      expect(parseReadbackButton(id)).toBeNull();
    }
  });

  it("share one operation key between the button and the typed word", () => {
    const tapped = parseReadbackButton("confirm:o-9:v2")!;
    expect(readbackOperationKey(tapped)).toBe("confirm:o-9:v2");
    expect(readbackOperationKey({ word: typedReadbackWord("Confirmar")!, orderId: "o-9", version: 2 })).toBe("confirm:o-9:v2");
  });
});

describe("customer names", () => {
  it("are tidied and cut to 120 characters, never to half a character", () => {
    expect(normalizeCustomerName("  Carla   Martínez \n")).toBe("Carla Martínez");
    expect(normalizeCustomerName("   ")).toBeNull();
    expect([...normalizeCustomerName("ñ".repeat(200))!]).toHaveLength(120);
  });
});
