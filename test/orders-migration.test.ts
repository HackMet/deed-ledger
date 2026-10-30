import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newPhone, seedStore } from "./helpers/seed";

describe("orders schema", () => {
  it("rejects a second operation with the same key: the key is the idempotency anchor", async () => {
    const store = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    const insertOperation = () =>
      env.DB.prepare(`INSERT INTO operations (business_id, operation_key, outcome_json, created_at_ms) VALUES (?1, 'op-duplicate', '{}', 0)`)
        .bind(store.businessId)
        .run();

    await insertOperation();
    await expect(insertOperation()).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("rejects an order line with a zero quantity: unknown is NULL, never 0", async () => {
    const store = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });

    await expect(
      env.DB.prepare(
        `INSERT INTO order_lines (business_id, order_id, version, line_no, product_id, qty_milli, excluded_from_total)
         VALUES (?1, 'order-1', 1, 1, 'product-1', 0, 0)`,
      )
        .bind(store.businessId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
