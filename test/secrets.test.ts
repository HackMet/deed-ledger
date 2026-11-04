import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildRuntime } from "../src/composition";

describe("test environment", () => {
  it("has every secret blank, whatever .dev.vars or the shell holds", () => {
    expect(env.WHATSAPP_APP_SECRET).toBe("");
    expect(env.WHATSAPP_VERIFY_TOKEN).toBe("");
    expect(env.WHATSAPP_TOKEN).toBe("");
    expect(env.SENDER_HASH_SALT).toBe("");
    expect(env.LINK_SIGNING_SECRET).toBe("");
    expect(env.MODEL_API_KEY).toBe("");
  });

  it("builds a WhatsApp channel that can't send", () => {
    const { deps } = buildRuntime(env);
    expect(deps.channel.configured).toBe(false);
  });

  it("applies every migration to the local D1", async () => {
    const { results } = await env.DB.prepare(`SELECT name FROM d1_migrations ORDER BY id`).all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual([
      "0001_tenancy.sql",
      "0002_messaging.sql",
      "0003_console_auth.sql",
      "0004_customers.sql",
      "0005_burst_reads.sql",
      "0006_reply_claims.sql",
      "0007_model_spend.sql",
      "0008_console_staff.sql",
      "0010_customer_controls.sql",
      "0011_store_aliases.sql",
      "0014_console_notices.sql",
      "0015_member_names.sql",
      "0016_pretend_engine_state.sql",
      "0017_customer_places.sql",
      "0018_pendientes.sql",
      "0019_store_setup.sql",
      "0020_ledger.sql",
      "0021_orders.sql",
      "0022_order_line_details.sql",
      "0023_order_facts.sql",
      "0024_change_requests.sql",
      "0025_dispatch.sql",
      "0026_console_receipts.sql",
      "0027_deed_checks.sql",
      "0028_agent_id.sql",
      "0030_planner_memory.sql",
      "0031_one_product_list.sql",
    ]);
  });

  it("widens the fact and evidence kinds for order facts and gives orders their fact ids", async () => {
    const sqlOf = async (name: string) =>
      (await env.DB.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(name).first<{ sql: string }>())?.sql ?? "";
    for (const kind of ["order_version", "order_confirm", "order_cancel", "order_status", "business_info"]) {
      expect(await sqlOf("facts")).toContain(`'${kind}'`);
    }
    for (const kind of ["member", "session"]) expect(await sqlOf("fact_evidence")).toContain(`'${kind}'`);
    // The rebuild leaves no table behind.
    expect(await sqlOf("facts_new")).toBe("");
    expect(await sqlOf("fact_evidence_new")).toBe("");
    const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('orders')`).all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual(expect.arrayContaining(["version_fact_id", "confirm_fact_id"]));
  });

  it("creates the final schema directly: every outbound row has an expiry and a send order", async () => {
    const { results } = await env.DB.prepare(`SELECT name, "notnull" AS required FROM pragma_table_info('outbound_messages')`).all<{
      name: string;
      required: number;
    }>();
    const columns = new Map(results.map((row) => [row.name, row.required]));
    expect(columns.get("expires_at_ms")).toBe(1);
    expect(columns.get("seq")).toBe(1);
    expect(columns.has("job_id")).toBe(true);
  });
});
