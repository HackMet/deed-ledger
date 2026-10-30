import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Guard, guardedBatch } from "../src/infrastructure/d1/fence";
import { newPhone, seedStore } from "./helpers/seed";

describe("guardedBatch post-guards", () => {
  const insertFact = (id: string, businessId: string) =>
    env.DB.prepare(
      `INSERT INTO facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json)
       VALUES (?1, ?2, 'receipt', ?1, 'actor-1', 0, 0, '{}')`,
    ).bind(id, businessId);

  const factExists = (id: string): Guard => ({
    holdsSql: `SELECT 1 FROM facts WHERE id = ?`,
    params: [id],
    error: () => new Error(`fact ${id} was not written`),
  });

  it("a post-guard that does not hold rolls back every statement of the batch", async () => {
    const store = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });

    await expect(
      guardedBatch(
        env.DB,
        [],
        [insertFact("fact-a", store.businessId), insertFact("fact-b", store.businessId)],
        [factExists("fact-missing")],
      ),
    ).rejects.toThrow("fact fact-missing was not written");

    const written = await env.DB.prepare(`SELECT id FROM facts WHERE business_id = ?`).bind(store.businessId).all();
    expect(written.results).toEqual([]);
    const guards = await env.DB.prepare(`SELECT guard_id FROM batch_guards`).all();
    expect(guards.results).toEqual([]);
  });

  it("a post-guard that holds keeps every statement of the batch", async () => {
    const store = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });

    const results = await guardedBatch(env.DB, [], [insertFact("fact-a", store.businessId)], [factExists("fact-a")]);

    expect(results).toHaveLength(1);
    const written = await env.DB.prepare(`SELECT id FROM facts WHERE business_id = ?`).bind(store.businessId).all();
    expect(written.results).toEqual([{ id: "fact-a" }]);
    const guards = await env.DB.prepare(`SELECT guard_id FROM batch_guards`).all();
    expect(guards.results).toEqual([]);
  });
});
