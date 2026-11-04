import { describe, expect, it } from "vitest";
import { totalOf } from "../src/domain/order-total";
import { labelOf, lineByLabel, nextVersion, wordsWithoutQuantity } from "../src/domain/orders";
import type { OrderLineView } from "../src/domain/contract/outcomes";
import { changedOrder, readbackOrder } from "./fixtures/contract";

const [aceite, arroz, azucar, jabon] = readbackOrder.lines as [OrderLineView, OrderLineView, OrderLineView, OrderLineView];
const priced = (over: Partial<OrderLineView>): OrderLineView => ({ ...aceite, ...over });

describe("changing an unmatched line's quantity", () => {
  const unmatched = priced({ productId: null, productName: null, text: "1 aceite clover", quantity: "1" });

  it("drops the old quantity from its words, so the line shows one number", () => {
    const next = nextVersion({ version: 1, lines: [unmatched] }, { op: "set_quantity", label: "L1", quantity: "3" });
    expect(next?.lines[0]).toMatchObject({ text: "aceite clover", quantity: "3" });
  });

  it("keeps a matched line's words", () => {
    const next = nextVersion({ version: 1, lines: [{ ...aceite, text: "2 aceite" }] }, { op: "set_quantity", label: "L1", quantity: "3" });
    expect(next?.lines[0]?.text).toBe("2 aceite");
  });

  it("keeps a number that isn't the quantity, so brands and sizes survive", () => {
    const line = priced({ productId: null, productName: null, text: "Tres Rosas", quantity: "1" });
    const next = nextVersion({ version: 1, lines: [line] }, { op: "set_quantity", label: "L1", quantity: "2" });
    expect(next?.lines[0]?.text).toBe("Tres Rosas");
  });

  it.each([
    ["1 aceite clover", "1", "aceite clover"],
    ["2,5 libras de queso", "2.5", "libras de queso"],
    ["2.5 libras de queso", "2.5", "libras de queso"],
    ["dos libras de azúcar", "2", "libras de azúcar"],
    ["Una bolsa", "1", "bolsa"],
    ["uno de arroz", "1", "de arroz"],
    ["un jabón", "1", "jabón"],
    ["tres tomates", "3", "tomates"],
    ["diez huevos", "10", "huevos"],
    ["2lb azucar", "2", "lb azucar"],
    ["1/2 libra de queso", "0.5", "libra de queso"],
    ["media libra de queso", "0.5", "libra de queso"],
    ["doce huevos", "12", "huevos"],
    ["x2 aceite", "2", "aceite"],
    ["catorce huevos", "14", "huevos"],
    ["dieciséis panes", "16", "panes"],
    ["veintidós panes", "22", "panes"],
    ["treinta y dos panes", "32", "panes"],
    ["dos y medio de pollo", "2.5", "de pollo"],
    ["una y media libra", "1.5", "libra"],
    ["2 1/2 libras de pollo", "2.5", "libras de pollo"],
    ["1/3 libra de queso", "0.333", "libra de queso"],
    ["x 2 aceite", "2", "aceite"],
    ["02 aceite", "2", "aceite"],
    [" 2 aceite", "2", "aceite"],
    ["2 3 huevos", "3", "2 3 huevos"],
    ["1/0 aceite", "1", "1/0 aceite"],
    ["treinta y media libra", "30", "treinta y media libra"],
    ["dos y tres panes", "2", "y tres panes"],
    ["Tres Rosas", "1", "Tres Rosas"],
    ["7 up", "2", "7 up"],
    ["2 litros de coca", "3", "2 litros de coca"],
    ["aceite 2", "2", "aceite 2"],
    ["1/3 libra", "1", "1/3 libra"],
    ["constructor uno", "1", "constructor uno"],
    ["aceite", "1", "aceite"],
    ["2", "2", "2"],
    ["2 aceite", null, "2 aceite"],
  ])("reads %s × %s as %s", (text, quantity, words) => {
    expect(wordsWithoutQuantity(text, quantity)).toBe(words);
  });
});

describe("totalOf", () => {
  it("matches the readback fixture: L 315 pickup, L 345 after the change", () => {
    expect(totalOf(readbackOrder.lines, 0)).toEqual({ total: 31500, delivery: 0, excluded: [] });
    expect(totalOf(changedOrder.lines, 0).total).toBe(34500);
  });

  it("rounds half up at a .5 centavo boundary, per line", () => {
    // 0.5 x 1 centavo = 0.5 -> 1; 1.5 x 1 = 1.5 -> 2; 0.499 x 1 = 0.499 -> 0
    expect(totalOf([priced({ quantity: "0.5", unitPrice: 1 })], 0).total).toBe(1);
    expect(totalOf([priced({ quantity: "1.5", unitPrice: 1 })], 0).total).toBe(2);
    expect(totalOf([priced({ quantity: "0.499", unitPrice: 1 })], 0).total).toBe(0);
  });

  it("rounds each line before summing, never the sum", () => {
    // two lines of 0.5 centavo: per line 1 + 1 = 2; rounding the sum (1.0) would give 1
    const half = priced({ quantity: "0.5", unitPrice: 1 });
    expect(totalOf([half, half], 0).total).toBe(2);
  });

  it("multiplies a fractional quantity by a price exactly", () => {
    // 2.250 lb x L 30.00 = L 67.50
    expect(totalOf([priced({ quantity: "2.25", unitPrice: 3000 })], 0).total).toBe(6750);
    // 0.333 x 1999 = 665.667 -> 666
    expect(totalOf([priced({ quantity: "0.333", unitPrice: 1999 })], 0).total).toBe(666);
  });

  it("is null when one price is unknown, even though the other lines are known", () => {
    const result = totalOf([aceite, priced({ unitPrice: null }), jabon], 0);
    expect(result.total).toBeNull();
    expect(totalOf([aceite, priced({ quantity: null })], 0).total).toBeNull();
  });

  it("excludes and lists a restricted line, and an out-of-stock one", () => {
    const restricted = priced({ restricted: true, unitPrice: 9900 });
    const gone = priced({ availability: "se_acabo" });
    const result = totalOf([aceite, restricted, arroz, gone], 0);
    expect(result.excluded).toEqual([1, 3]);
    expect(result.total).toBe(6000 + 9000);
  });

  it("does not let an excluded line with an unknown price null the total", () => {
    const restricted = priced({ restricted: true, unitPrice: null });
    expect(totalOf([aceite, restricted], 0).total).toBe(6000);
  });

  it("includes the delivery fee in the total and reports it separately", () => {
    expect(totalOf(readbackOrder.lines, 5000)).toEqual({ total: 36500, delivery: 5000, excluded: [] });
  });
});

describe("totalOf with an unknown or invalid input", () => {
  it("a null delivery fee makes the total null, and delivery is null too", () => {
    const result = totalOf(readbackOrder.lines, null);
    expect(result.total).toBeNull();
    expect(result.delivery).toBeNull();
  });

  it("a fee that is not a whole number of centavos makes the total null", () => {
    const result = totalOf(readbackOrder.lines, 12.5);
    expect(result.total).toBeNull();
    expect(result.delivery).toBeNull();
  });

  it("a fractional price is unknown and does not throw", () => {
    const line = priced({ unitPrice: 10.5 });
    expect(() => totalOf([line], 0)).not.toThrow();
    expect(totalOf([line], 0).total).toBeNull();
  });

  it("an order whose every line is excluded totals null, not the fee alone", () => {
    const gone = priced({ availability: "se_acabo" });
    const restricted = priced({ restricted: true });
    expect(totalOf([gone, restricted], 5000)).toEqual({ total: null, delivery: 5000, excluded: [0, 1] });
  });

  it("a known whole fee still adds to the total and is reported separately", () => {
    expect(totalOf(readbackOrder.lines, 5000)).toEqual({ total: 36500, delivery: 5000, excluded: [] });
  });
});

describe("order versions and labels", () => {
  it("labels are 1-based by position", () => {
    expect([0, 1, 3].map(labelOf)).toEqual(["L1", "L2", "L4"]);
    expect(lineByLabel(readbackOrder, "L3")).toBe(azucar);
  });

  it("renumbers labels per version after a line is removed", () => {
    const next = nextVersion(readbackOrder, { op: "remove", label: "L2" });
    expect(next?.version).toBe(2);
    expect(next?.lines.map((l) => l.lineId)).toEqual(["line-1", "line-3", "line-4"]);
    expect(lineByLabel(next!, "L2")?.lineId).toBe("line-3");
    expect(lineByLabel(next!, "L4")).toBeNull();
  });

  it("never modifies the previous version", () => {
    const before = structuredClone(readbackOrder);
    nextVersion(readbackOrder, { op: "remove", label: "L1" });
    nextVersion(readbackOrder, { op: "set_quantity", label: "L3", quantity: "3" });
    expect(readbackOrder).toEqual(before);
  });

  it("set_quantity yields the changed fixture's lines", () => {
    const next = nextVersion(readbackOrder, { op: "set_quantity", label: "L3", quantity: "3" });
    expect(next?.lines.map((l) => l.quantity)).toEqual(changedOrder.lines.map((l) => l.quantity));
  });

  it("add appends a line that gets the next label", () => {
    const next = nextVersion(readbackOrder, { op: "add", line: priced({ lineId: "line-5" }) });
    expect(next?.lines).toHaveLength(5);
    expect(lineByLabel(next!, "L5")?.lineId).toBe("line-5");
  });

  it("add rejects a negative or malformed quantity, and keeps an unknown one", () => {
    expect(nextVersion(readbackOrder, { op: "add", line: priced({ lineId: "line-5", quantity: "-3" }) })).toBeNull();
    expect(nextVersion(readbackOrder, { op: "add", line: priced({ lineId: "line-5", quantity: "1e3" }) })).toBeNull();
    expect(nextVersion(readbackOrder, { op: "add", line: priced({ lineId: "line-5", quantity: null }) })?.lines).toHaveLength(5);
  });

  it("a label that doesn't resolve returns null and never guesses a neighbour", () => {
    for (const label of ["L0", "L5", "L99", "l1", "L", "", "L1 ", "L-1", "L1.5", "2", "L01"]) {
      expect(lineByLabel(readbackOrder, label)).toBeNull();
    }
    expect(nextVersion(readbackOrder, { op: "remove", label: "L5" })).toBeNull();
    expect(nextVersion(readbackOrder, { op: "set_quantity", label: "L0", quantity: "2" })).toBeNull();
    expect(nextVersion(readbackOrder, { op: "set_quantity", label: "L1", quantity: "-2" })).toBeNull();
  });
});
