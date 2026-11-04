import { describe, expect, it } from "vitest";
import { orderRef } from "../src/domain/order-ref";

describe("orderRef", () => {
  it("is 8 hex characters, the same for one order and different for another", () => {
    expect(orderRef("order-1")).toMatch(/^[0-9a-f]{8}$/);
    expect(orderRef("order-1")).toBe(orderRef("order-1"));
    expect(orderRef("order-2")).not.toBe(orderRef("order-1"));
  });
});
