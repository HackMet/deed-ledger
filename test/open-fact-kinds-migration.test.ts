import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const T = Date.UTC(2026, 10, 1);

/**
 * 0029 rebuilds facts and fact_evidence without their kind lists. Run it on a database that already holds
 * facts (with agent ids, a draft and media evidence), as production will.
 */
describe("migration 0029 (open fact kinds) on a database with existing facts", () => {
  it("keeps every fact, evidence row, column, index, trigger and the agent_id CHECK, and admits a kind the old CHECK refused", async () => {
    const db = env.MIGRATION_TEST_DB;
    const before = env.TEST_MIGRATIONS.filter((migration) => migration.name < "0029");
    const after = env.TEST_MIGRATIONS.filter((migration) => migration.name === "0029_open_fact_kinds.sql");
    expect(after).toHaveLength(1);
    await applyD1Migrations(db, before);

    await db.prepare(`INSERT INTO businesses (id, name, created_at_ms) VALUES ('biz-0029', 'Tienda', ?)`).bind(T).run();
    await db
      .prepare(
        `INSERT INTO facts (id, business_id, kind, operation_key, draft_id, draft_revision, actor_user_id, valid_from_ms,
           recorded_at_ms, body_json, agent_id)
         VALUES ('fact-a', 'biz-0029', 'receipt', 'key-a', 'draft-a', 3, 'member-a', ?, ?, '{"total":5}', NULL),
                ('fact-b', 'biz-0029', 'order_version', 'key-b', NULL, NULL, 'customer-b', ?, ?, '{}', 'abcdef12')`,
      )
      .bind(T, T, T, T)
      .run();
    await db
      .prepare(
        `INSERT INTO fact_evidence (business_id, fact_id, kind, ref_id, content_sha256)
         VALUES ('biz-0029', 'fact-a', 'confirmation', 'conf-a', NULL),
                ('biz-0029', 'fact-a', 'inbound_message', 'in-a', NULL),
                ('biz-0029', 'fact-b', 'media_asset', 'media-b', 'sha-b')`,
      )
      .run();
    const rowsOf = async () => {
      const facts = await db
        .prepare(`SELECT id, business_id, kind, operation_key, draft_id, draft_revision, actor_user_id, valid_from_ms, recorded_at_ms, body_json, agent_id FROM facts ORDER BY id`)
        .all();
      const evidence = await db.prepare(`SELECT business_id, fact_id, kind, ref_id, content_sha256 FROM fact_evidence ORDER BY fact_id, ref_id`).all();
      return { facts: facts.results, evidence: evidence.results };
    };
    const indexesOf = async (table: string) =>
      (await db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`).bind(table).all()).results;
    const triggersOf = async () =>
      (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('facts', 'fact_evidence')`).all()).results;
    const rowsBefore = await rowsOf();
    const indexesBefore = [...(await indexesOf("facts")), ...(await indexesOf("fact_evidence"))];
    const triggersBefore = await triggersOf();
    expect(triggersBefore).toEqual([]);

    await applyD1Migrations(db, after);

    expect(await rowsOf()).toEqual(rowsBefore);
    expect([...(await indexesOf("facts")), ...(await indexesOf("fact_evidence"))].map((row) => row.name)).toEqual(
      indexesBefore.map((row) => row.name),
    );
    expect(await triggersOf()).toEqual(triggersBefore);

    // The agent_id CHECK survives the rebuild, and the UNIQUE keys still refuse a second write of one key.
    await expect(
      db.prepare(`INSERT INTO facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json, agent_id)
        VALUES ('fact-c', 'biz-0029', 'price', 'key-c', 'u', ?, ?, '{}', 'NOTHEX!!')`).bind(T, T).run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.prepare(`INSERT INTO facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json)
        VALUES ('fact-d', 'biz-0029', 'price', 'key-a', 'u', ?, ?, '{}')`).bind(T, T).run(),
    ).rejects.toThrow(/UNIQUE/);

    // The kind CHECK is gone: a kind the policy names is written, and so is any other kind the database takes;
    // the batch's post-guard is what refuses an unknown one (see test/deed-core-d1-store.test.ts).
    await db
      .prepare(`INSERT INTO facts (id, business_id, kind, operation_key, actor_user_id, valid_from_ms, recorded_at_ms, body_json)
        VALUES ('fact-e', 'biz-0029', 'made_up', 'key-e', 'u', ?, ?, '{}')`).bind(T, T).run();
    await db
      .prepare(`INSERT INTO fact_evidence (business_id, fact_id, kind, ref_id, content_sha256) VALUES ('biz-0029', 'fact-e', 'made_up', 'x', NULL)`)
      .run();

    // Updates and deletes behave as before: no trigger on facts or fact_evidence, before or after.
    const updated = await db.prepare(`UPDATE facts SET body_json = '{"total":6}' WHERE id = 'fact-a'`).run();
    expect(updated.meta.changes).toBe(1);
    const deleted = await db.prepare(`DELETE FROM facts WHERE id = 'fact-e'`).run();
    expect(deleted.meta.changes).toBe(1);

    const sqlOf = async (name: string) =>
      (await db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(name).first<{ sql: string }>())?.sql ?? "";
    expect(await sqlOf("facts")).not.toContain("CHECK (kind");
    expect(await sqlOf("fact_evidence")).not.toContain("CHECK (kind");
    expect(await sqlOf("facts_new")).toBe("");
    expect(await sqlOf("fact_evidence_new")).toBe("");
  });
});
