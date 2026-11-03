import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BurstReading } from "../src/domain/contract/observation";
import { readingSourceOf } from "../src/application/order-reading";
import { firstOrder, ids } from "./fixtures/contract";
import { engine, newStore, placeFirstOrder, T0 } from "./helpers/orders";

/** The first order with the second line's quantity missing: the customer's list said "arroz" and no number. */
const missingQuantity: BurstReading = {
  ...firstOrder,
  observations: firstOrder.observations.map((observation) =>
    observation.kind === "customer_order"
      ? { ...observation, lines: observation.lines.map((line, n) => (n === 1 ? { ...line, quantity: null } : line)) }
      : observation,
  ),
};

describe("the engine's reads for perception", () => {
  it("offers the reader its two reads, so the reader is built for an OrderEngine", () => {
    expect(readingSourceOf(engine)).not.toBeNull();
  });

  it("catalog: each store sees only its own products, never a store_products row", async () => {
    const mine = await newStore();
    const theirs = await newStore();
    await env.DB.prepare(
      `INSERT INTO store_products (id, business_id, name, name_key, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 0, 0)`,
    )
      .bind(crypto.randomUUID(), mine.businessId, "Solo Tienda", "solo tienda")
      .run();

    const catalog = await engine.catalog(mine.context());
    expect(catalog.map((p) => p.productId).sort()).toEqual(mine.matches.map((m) => m.productId).sort());
    expect(catalog.every((p) => p.productId.startsWith(`${mine.businessId}:`))).toBe(true);
    expect(catalog.map((p) => p.names[0])).not.toContain("Solo Tienda");
    expect(catalog.find((p) => p.productId.startsWith(`${theirs.businessId}:`))).toBeUndefined();

    const theirsCatalog = await engine.catalog(theirs.context());
    expect(theirsCatalog.map((p) => p.productId).sort()).toEqual(theirs.matches.map((m) => m.productId).sort());
  });

  it("catalog: a product keeps its name, no aliases and no barcode, ordered by name", async () => {
    const s = await newStore();
    const catalog = await engine.catalog(s.context());
    expect(catalog.map((p) => [p.names, p.aliases, p.barcode])).toEqual([
      [["arroz-1lb"], [], null],
      [["azucar-1lb"], [], null],
      [["jabon-xtra"], [], null],
    ]);
  });

  it("no open order reads as nothing open and nothing pending", async () => {
    const s = await newStore();
    expect(await engine.perceptionContext(s.context())).toEqual({ openOrder: null, pendingQuestion: null });
  });

  it("an open order reads as labelled lines, the text rule the memory engine uses", async () => {
    const s = await newStore();
    await placeFirstOrder(s);
    const context = await engine.perceptionContext(s.context());
    expect(context).toEqual({
      openOrder: {
        lines: [
          { ref: "L1", text: "1 aceite clover: 1" },
          { ref: "L2", text: "arroz-1lb: 3" },
          { ref: "L3", text: "jabon-xtra: 3" },
          { ref: "L4", text: "azucar-1lb: 2" },
        ],
      },
      pendingQuestion: null,
    });
  });

  it("a line with no quantity reads as '?'; pendingQuestion stays null until the engine asks about quantities", async () => {
    // PENDING: OrderEngine.onBurst has no question about a missing quantity, so there is no ask to echo.
    const s = await newStore();
    await placeFirstOrder(s, ids.customer, T0, missingQuantity);
    const context = await engine.perceptionContext(s.context());
    expect(context.openOrder?.lines[1]).toEqual({ ref: "L2", text: "arroz-1lb: ?" });
    expect(context.pendingQuestion).toBeNull();
  });
});
