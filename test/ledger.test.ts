import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newPhone, seedStore } from "./helpers/seed";

describe("ledger schema", () => {
  it("rejects a negative stock balance: verified stock never goes negative", async () => {
    const store = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });

    await expect(
      env.DB.prepare(`INSERT INTO stock_balances (business_id, product_id, qty_milli, updated_at_ms) VALUES (?1, ?2, ?3, ?4)`)
        .bind(store.businessId, "product-negative", -1, 0)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects a second fact with the same operation key: one logical operation, one fact", async () => {
    const store = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    const insertFact = (id: string) =>
      env.DB.prepare(
        `INSERT INTO facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json)
         VALUES (?1, ?2, 'receipt', 'op-duplicate', 'actor-1', 0, 0, '{}')`,
      )
        .bind(id, store.businessId)
        .run();

    await insertFact("fact-first");
    await expect(insertFact("fact-second")).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
