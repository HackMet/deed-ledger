import { describe, expect, it } from "vitest";
import {
  applyEdit,
  type CatalogEntry,
  draftFromReading,
  type LineEdit,
  matchLine,
  missingQuantity,
  parseCostCentavos,
  parseQtyMilli,
  parseReceiptReading,
} from "../src/domain/receipt-draft";
import { RecordedReceiptReader } from "../src/integrations/perception/recorded-receipt-reader";
import { receiptFixtures, receiptRecordings } from "./fixtures/receipts";

const catalog: CatalogEntry[] = [
  { id: "p-coca", name: "Coca-Cola 600 ml", aliases: [] },
  { id: "p-agua", name: "Agua Cristal 600 ml", aliases: ["agua pura chica"] },
];

const edit = (over: Partial<LineEdit> = {}): LineEdit => ({ name: "Coca-Cola 600 ml", qty: "12", cost: "15.00", product: "auto", remove: false, ...over });

describe("K14: reading a supplier invoice into a draft", () => {
  it("validates a reading schema-first and keeps an absent cost or quantity null, never 0", () => {
    const reading = parseReceiptReading(receiptFixtures.distribuidora.reading)!;
    expect(reading.supplier).toBe("Distribuidora Ejemplo");
    expect(reading.lines[2]).toEqual({ name: "Galletas Ejemplo", qtyMilli: 6000, unit: "paquete", unitCostCentavos: null });
    expect(parseReceiptReading(receiptFixtures.sinCantidad.reading)!.lines[0]!.qtyMilli).toBeNull();

    for (const bad of [
      null,
      { supplier: "X", lines: [] },
      { supplier: "X", lines: [{ name: "", qtyMilli: 1000 }] },
      { supplier: "X", lines: [{ name: "a", qtyMilli: 1.5 }] },
      { supplier: "X", lines: [{ name: "a", qtyMilli: 0 }] },
      { supplier: "X", lines: [{ name: "a", unitCostCentavos: -1 }] },
      { supplier: "X", date: "2 de noviembre", lines: [{ name: "a" }] },
      { supplier: 7, lines: [{ name: "a" }] },
      { supplier: "X", lines: [{ name: "a".repeat(121) }] },
    ]) {
      expect(parseReceiptReading(bad)).toBeNull();
    }
  });

  it("matches an exact name (case and spacing aside) or a known alias, and marks anything else nuevo", () => {
    expect(matchLine("coca-cola  600 ML", catalog)).toEqual({ productId: "p-coca", how: "exact_name" });
    expect(matchLine("Agua pura chica", catalog)).toEqual({ productId: "p-agua", how: "known_alias" });
    // Close is not the same: no fuzzy guess.
    expect(matchLine("Coca Cola 600ml", catalog)).toBeNull();
    expect(matchLine("Cocá-Cola 600 ml", catalog)).toBeNull();

    const draft = draftFromReading(parseReceiptReading(receiptFixtures.distribuidora.reading)!, catalog);
    expect(draft.lines.map((line) => line.match)).toEqual([
      { productId: "p-coca", how: "exact_name" },
      { productId: "p-agua", how: "exact_name" },
      null,
    ]);
  });

  it("applies the owner's edit: numbers parsed exactly, products only from the store, removed lines dropped", () => {
    const previous = draftFromReading(parseReceiptReading(receiptFixtures.distribuidora.reading)!, catalog);
    const result = applyEdit(
      {
        supplier: " Distribuidora  Ejemplo ",
        lines: [
          edit({ qty: "10,5", cost: "14,75", product: "p-coca" }),
          edit({ name: "Agua Cristal 600 ml", qty: "24", cost: "", product: "nuevo" }),
          edit({ remove: true }),
        ],
      },
      catalog,
      previous,
    );
    expect(result).toEqual({
      ok: true,
      body: {
        supplier: "Distribuidora Ejemplo",
        date: "2026-11-02",
        lines: [
          { name: "Coca-Cola 600 ml", qtyMilli: 10_500, unit: "unidad", unitCostCentavos: 1475, match: { productId: "p-coca", how: "exact_name" } },
          { name: "Agua Cristal 600 ml", qtyMilli: 24_000, unit: "unidad", unitCostCentavos: null, match: null },
        ],
      },
    });
    expect(applyEdit({ supplier: "X", lines: [edit({ product: "another-store-product" })] }, catalog, previous)).toEqual({ ok: false, field: "product", line: 1 });
    expect(applyEdit({ supplier: "X", lines: [edit({ qty: "0" })] }, catalog, previous)).toEqual({ ok: false, field: "qty", line: 1 });
    expect(applyEdit({ supplier: "X", lines: [edit({ cost: "-1" })] }, catalog, previous)).toEqual({ ok: false, field: "cost", line: 1 });
    expect(applyEdit({ supplier: "X", lines: [edit({ remove: true })] }, catalog, previous)).toEqual({ ok: false, field: "lines", line: null });
  });

  it("parses quantities and costs without floats", () => {
    expect(parseQtyMilli("1.25")).toBe(1250);
    expect(parseQtyMilli("")).toBeNull();
    expect(parseQtyMilli("1e3")).toBeUndefined();
    expect(parseCostCentavos("0")).toBe(0);
    expect(parseCostCentavos("12.345")).toBeUndefined();
  });

  it("names the first line approval can't post because its quantity is unknown", () => {
    const draft = draftFromReading(parseReceiptReading(receiptFixtures.sinCantidad.reading)!, catalog);
    expect(missingQuantity(draft)).toBe(1);
  });

  it("the recorded reader answers by the image's SHA-256 and refuses any image it has no recording for", async () => {
    const reader = new RecordedReceiptReader(receiptRecordings);
    const known = await reader.read({ businessId: "b" }, { bytes: new ArrayBuffer(0), contentType: "image/png", sha256: receiptFixtures.distribuidora.sha256 }, null);
    expect(known.type).toBe("reading");
    const unknown = await reader.read({ businessId: "b" }, { bytes: new ArrayBuffer(0), contentType: "image/png", sha256: "0".repeat(64) }, null);
    expect(unknown).toEqual({ type: "refused", reason: "unreadable" });
    for (const fixture of receiptRecordings) expect(fixture.source).toBe("fixture");
  });
});
