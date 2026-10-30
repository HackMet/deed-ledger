import { describe, expect, it } from "vitest";
import {
  type BurstReading,
  CONSOLE_KINDS,
  CUSTOMER_KINDS,
  type Evidence,
  isCustomerKind,
  type ObservationBody,
} from "../src/domain/contract/observation";
import type { OrderView } from "../src/domain/contract/outcomes";
import { isCentavos, isDecimalString, toThousandths } from "../src/domain/contract/numbers";
import { allOrders, allReadings, burstText, firstOrder, firstOrderMatches, ids, moreSugar, packingContext } from "./fixtures/contract";

/** Every value in an object tree, with the key it sits under. */
function* walk(value: unknown, key = ""): Generator<[string, unknown]> {
  yield [key, value];
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* walk(v, k);
  }
}

function evidenceOf(reading: BurstReading): Evidence[] {
  return [...walk(reading)]
    .map(([, v]) => v)
    .filter((v): v is Evidence => v !== null && typeof v === "object" && "source" in v && "message" in v);
}

const QUANTITY_KEYS = new Set(["quantity", "receivedQuantity", "count"]);
const MONEY_KEYS = new Set(["unitPrice", "unitCost", "price", "amount", "total", "fee", "balance"]);

describe("exact numbers", () => {
  it("converts decimal strings to thousandths without floats", () => {
    expect(toThousandths("2")).toBe(2000);
    expect(toThousandths("0.5")).toBe(500);
    expect(toThousandths("1.25")).toBe(1250);
    expect(toThousandths("0.001")).toBe(1);
    // 0.1 + 0.2 as floats is 0.30000000000000004; here it is exact.
    expect(toThousandths("0.1")! + toThousandths("0.2")!).toBe(toThousandths("0.3"));
    for (const bad of ["", "-1", "1.2345", "1,5", "01", " 2", "2.", ".5", "1e3", "dos"]) {
      expect(toThousandths(bad), bad).toBeNull();
    }
  });

  it("accepts only non-negative integer centavos", () => {
    expect(isCentavos(31500)).toBe(true);
    expect(isCentavos(0)).toBe(true);
    for (const bad of [-1, 25.5, Number.NaN, "2550", null]) expect(isCentavos(bad)).toBe(false);
  });
});

describe("contract fixtures", () => {
  it("keeps customer and console kinds apart, and customer bursts to customer kinds", () => {
    expect(CUSTOMER_KINDS.filter((kind) => (CONSOLE_KINDS as readonly string[]).includes(kind))).toEqual([]);
    expect(CONSOLE_KINDS.some(isCustomerKind)).toBe(false);
    for (const [name, reading] of Object.entries(allReadings)) {
      expect(reading.observations.length, name).toBeGreaterThan(0);
      for (const observation of reading.observations) expect(isCustomerKind(observation.kind), name).toBe(true);
    }
  });

  it("use decimal strings for quantities and integer centavos for money, never floats", () => {
    for (const [name, value] of Object.entries({ ...allReadings, ...allOrders })) {
      for (const [key, v] of walk(value)) {
        if (v === null) continue;
        if (QUANTITY_KEYS.has(key)) expect(isDecimalString(v), `${name}.${key}`).toBe(true);
        if (MONEY_KEYS.has(key) && typeof v !== "object") expect(isCentavos(v), `${name}.${key}`).toBe(true);
      }
    }
  });

  it("point every piece of evidence at a message of its burst, inside its bounds", () => {
    for (const [name, reading] of Object.entries(allReadings)) {
      const burst = burstText[name as keyof typeof burstText];
      for (const evidence of evidenceOf(reading)) {
        expect(evidence.message, name).toBeLessThan(burst.length);
        const text = burst[evidence.message];
        if (evidence.source === "image") {
          expect(text, `${name}: a box must be on a photo`).toBeNull();
          const [left, top, right, bottom] = evidence.box;
          expect(0 <= left && left < right && right <= 1 && 0 <= top && top < bottom && bottom <= 1, name).toBe(true);
        } else {
          expect(typeof text, `${name}: a span must be on text`).toBe("string");
          expect(0 <= evidence.start && evidence.start < evidence.end && evidence.end <= text!.length, name).toBe(true);
        }
      }
    }
  });

  it("quote the words a transcript span points to", () => {
    const sugar = linesOf(firstOrder.observations[0]!)[3]!;
    const evidence = sugar.evidence;
    expect(evidence.source).toBe("transcript");
    if (evidence.source !== "transcript") return;
    expect(burstText.firstOrder[evidence.message]!.slice(evidence.start, evidence.end)).toBe(sugar.text);
  });

  it("match lines by index into the burst, never by a model-supplied ID", () => {
    for (const match of firstOrderMatches) {
      expect(match.line).toBeLessThan(linesOf(firstOrder.observations[match.observation]!).length);
    }
    const text = JSON.stringify(allReadings);
    for (const id of [...Object.values(ids), ...firstOrderMatches.map((m) => m.productId)]) expect(text).not.toContain(id);
  });

  it("aim order edits at a line label from the context perception was given", () => {
    const refs = new Set(packingContext.openOrder!.lines.map((l) => l.ref));
    const change = moreSugar.observations[0]!;
    expect(change.kind).toBe("order_change");
    if (change.kind !== "order_change") return;
    for (const edit of change.edits) if (edit.op !== "add" && edit.target.ref !== null) expect(refs.has(edit.target.ref)).toBe(true);
  });

  it("total an order exactly from its lines, and only when every price is known", () => {
    const totalOf = (order: OrderView) => {
      let sum = 0;
      for (const l of order.lines) {
        if (l.unitPrice === null || l.quantity === null) return null;
        const thousandths = toThousandths(l.quantity)!;
        expect((l.unitPrice * thousandths) % 1000, l.lineId).toBe(0);
        sum += (l.unitPrice * thousandths) / 1000;
      }
      return sum;
    };
    for (const [name, order] of Object.entries(allOrders)) expect(order.total, name).toBe(totalOf(order));
  });
});

function linesOf(observation: ObservationBody) {
  return observation.kind === "customer_order" ? observation.lines : [];
}
