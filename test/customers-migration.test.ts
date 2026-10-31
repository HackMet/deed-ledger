import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { D1IntakeRepository } from "../src/infrastructure/d1/intake-repository";
import { newPhone, newPhoneNumberId } from "./helpers/seed";
import { wamid } from "./helpers/whatsapp";

const T = Date.UTC(2026, 9, 20);

/**
 * 0004 rebuilds conversations (its foreign key moves from memberships to customers). Run it on a
 * database that already holds conversations, messages, replies and a live lease, as production will.
 */
describe("migration 0004 (customers) on a database with existing rows", () => {
  it("keeps every conversation, message and reply, and makes each member who wrote a customer of that store", async () => {
    const db = env.MIGRATION_TEST_DB;
    const before = env.TEST_MIGRATIONS.filter((migration) => migration.name < "0004");
    const after = env.TEST_MIGRATIONS.filter((migration) => migration.name >= "0004");
    expect(after.map((migration) => migration.name)).toEqual(["0004_customers.sql", "0005_burst_reads.sql"]);
    await applyD1Migrations(db, before);

    // Two stores; one person is a member of both and wrote to both, another wrote only to store A.
    const shared = { id: "user-shared", phone: newPhone() };
    const other = { id: "user-other", phone: newPhone() };
    const stores = ["a", "b"].map((name) => ({
      businessId: `store-${name}`,
      locationId: `loc-${name}`,
      channelId: `chan-${name}`,
      phoneNumberId: newPhoneNumberId(),
    }));
    const [a, b] = stores as [(typeof stores)[0], (typeof stores)[0]];
    const statements: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO users (id, phone, created_at_ms) VALUES (?, ?, ?), (?, ?, ?)`).bind(
        shared.id,
        shared.phone,
        T,
        other.id,
        other.phone,
        T,
      ),
    ];
    for (const s of stores) {
      statements.push(
        db.prepare(`INSERT INTO businesses (id, name, created_at_ms) VALUES (?, 'Tienda', ?)`).bind(s.businessId, T),
        db.prepare(`INSERT INTO locations (id, business_id, name, created_at_ms) VALUES (?, ?, 'Principal', ?)`).bind(s.locationId, s.businessId, T),
        db
          .prepare(
            `INSERT INTO channel_accounts (id, business_id, location_id, provider, phone_number_id, created_at_ms)
             VALUES (?, ?, ?, 'whatsapp', ?, ?)`,
          )
          .bind(s.channelId, s.businessId, s.locationId, s.phoneNumberId, T),
        db
          .prepare(`INSERT INTO memberships (business_id, user_id, role, created_at_ms) VALUES (?, ?, 'owner', ?)`)
          .bind(s.businessId, shared.id, T),
      );
    }
    statements.push(
      db.prepare(`INSERT INTO memberships (business_id, user_id, role, created_at_ms) VALUES (?, ?, 'staff', ?)`).bind(a.businessId, other.id, T),
    );
    const conversation = (id: string, s: (typeof stores)[0], userId: string, lease: string | null) =>
      db
        .prepare(
          `INSERT INTO conversations (id, business_id, channel_account_id, user_id, last_inbound_at_ms, lease_id, lease_until_ms, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, s.businessId, s.channelId, userId, T + 5, lease, lease === null ? null : T + 60_000, T);
    const message = (id: string, s: (typeof stores)[0], conversationId: string, state: "done" | "pending") =>
      db
        .prepare(
          `INSERT INTO inbound_messages (id, business_id, conversation_id, provider, provider_message_id, provider_timestamp_s,
             order_ts_s, received_at_ms, kind, text_body, job_state, job_finished_at_ms)
           VALUES (?, ?, ?, 'whatsapp', ?, 1, 1, ?, 'text', 'Hola', ?, ?)`,
        )
        .bind(id, s.businessId, conversationId, `wamid.${id}`, T, state, state === "done" ? T + 1 : null);
    statements.push(
      conversation("conv-a-shared", a, shared.id, "lease-live"),
      conversation("conv-a-other", a, other.id, null),
      conversation("conv-b-shared", b, shared.id, null),
      message("in-1", a, "conv-a-shared", "done"),
      message("in-2", a, "conv-a-shared", "pending"),
      message("in-3", b, "conv-b-shared", "done"),
      db
        .prepare(
          `INSERT INTO outbound_messages (id, business_id, channel_account_id, conversation_id, seq, job_id, kind, body_text,
             dedupe_key, status, expires_at_ms, created_at_ms, updated_at_ms)
           VALUES ('out-1', ?, ?, 'conv-a-shared', 1, 'in-1', 'reply', 'Recibido', 'reply:in-1:0:0', 'sent', ?, ?, ?)`,
        )
        .bind(a.businessId, a.channelId, T + 60_000, T, T),
    );
    await db.batch(statements);

    await applyD1Migrations(db, after);

    // Every conversation kept, with its ID, window and lease; each now points at a customer.
    const conversations = await db
      .prepare(
        `SELECT c.id, c.business_id, c.last_inbound_at_ms, c.lease_id, c.lease_until_ms, cu.phone
         FROM conversations c JOIN customers cu ON cu.business_id = c.business_id AND cu.id = c.customer_id
         ORDER BY c.id`,
      )
      .all();
    expect(conversations.results).toEqual([
      { id: "conv-a-other", business_id: a.businessId, last_inbound_at_ms: T + 5, lease_id: null, lease_until_ms: null, phone: other.phone },
      {
        id: "conv-a-shared",
        business_id: a.businessId,
        last_inbound_at_ms: T + 5,
        lease_id: "lease-live",
        lease_until_ms: T + 60_000,
        phone: shared.phone,
      },
      { id: "conv-b-shared", business_id: b.businessId, last_inbound_at_ms: T + 5, lease_id: null, lease_until_ms: null, phone: shared.phone },
    ]);
    // The shared phone is a separate customer in each store.
    const customers = await db.prepare(`SELECT id, business_id, phone, name FROM customers ORDER BY business_id, phone`).all<{
      id: string;
      business_id: string;
      phone: string;
      name: string | null;
    }>();
    expect(customers.results).toHaveLength(3);
    const sharedIds = customers.results.filter((row) => row.phone === shared.phone).map((row) => row.id);
    expect(new Set(sharedIds).size).toBe(2);
    expect(customers.results.every((row) => row.name === null)).toBe(true);

    // Messages and replies still point at their conversations; nothing dangles.
    expect((await db.prepare(`SELECT id, conversation_id FROM inbound_messages ORDER BY id`).all()).results).toEqual([
      { id: "in-1", conversation_id: "conv-a-shared" },
      { id: "in-2", conversation_id: "conv-a-shared" },
      { id: "in-3", conversation_id: "conv-b-shared" },
    ]);
    expect((await db.prepare(`SELECT conversation_id FROM outbound_messages`).all()).results).toEqual([{ conversation_id: "conv-a-shared" }]);
    expect((await db.prepare(`PRAGMA foreign_key_check`).all()).results).toEqual([]);

    // 0005: messages already handled count as read; the open one doesn't.
    expect((await db.prepare(`SELECT inbound_message_id FROM burst_reads ORDER BY inbound_message_id`).all()).results).toEqual([
      { inbound_message_id: "in-1" },
      { inbound_message_id: "in-3" },
    ]);

    // The composite keys still hold: store A's conversation can't point at store B's customer.
    const customerInB = customers.results.find((row) => row.business_id === b.businessId)!.id;
    await expect(
      db
        .prepare(`INSERT INTO conversations (id, business_id, channel_account_id, customer_id, created_at_ms) VALUES ('x', ?, ?, ?, 0)`)
        .bind(a.businessId, a.channelId, customerInB)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);

    // A migrated member writing again is recognized: same customer, same conversation.
    const intake = new D1IntakeRepository(db);
    const recorded = await intake.recordCustomerMessage(
      { businessId: a.businessId },
      {
        channelAccountId: a.channelId,
        event: { type: "message", phoneNumberId: a.phoneNumberId, ...textMessageEvent(shared.phone) },
        receivedAtMs: T + 10_000,
        orderTsS: Math.floor((T + 10_000) / 1000),
        newCustomerId: "new-customer",
        newConversationId: "new-conversation",
        newInboundId: "in-4",
        newMediaAssetId: "new-asset",
        hourlyCap: 300,
      },
    );
    expect(recorded).toEqual({ conversationId: "conv-a-shared", customerId: expect.any(String), outcome: "new" });
    expect(recorded.customerId).not.toBe("new-customer");
  });
});

function textMessageEvent(from: string) {
  return {
    senderPhone: from,
    providerMessageId: wamid(),
    providerTimestampS: 1,
    kind: "text" as const,
    textBody: "Otra vez",
    replyId: null,
    contextMessageId: null,
    media: null,
  };
}
