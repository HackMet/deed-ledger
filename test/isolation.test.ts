import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { harness, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { imageMessage, textMessage, wamid, webhook } from "./helpers/whatsapp";

const T0 = 1_793_196_000;

describe("two stores", () => {
  it("with the same member phone in each never cross: messages, jobs, replies and media stay in their store", async () => {
    const h = harness();
    const shared = newPhone();
    const a = await seedStore({ name: "Tienda A", members: [{ phone: shared, role: "owner" }] });
    const b = await seedStore({ name: "Tienda B", members: [{ phone: shared, role: "staff" }] });

    await h.post(webhook(a.phoneNumberId, { messages: [imageMessage({ from: shared, id: wamid(), timestampS: T0, mediaId: "m-a", caption: "para A" })] }));
    await h.post(webhook(b.phoneNumberId, { messages: [imageMessage({ from: shared, id: wamid(), timestampS: T0, mediaId: "m-b", caption: "para B" })] }));

    // One person, two memberships, two separate conversations.
    expect(await rows(`SELECT id FROM users WHERE phone = ?1`, shared)).toHaveLength(1);
    const inboundA = await rows<{ text_body: string; conversation_id: string }>(
      `SELECT text_body, conversation_id FROM inbound_messages WHERE business_id = ?1`,
      a.businessId,
    );
    const inboundB = await rows<{ text_body: string; conversation_id: string }>(
      `SELECT text_body, conversation_id FROM inbound_messages WHERE business_id = ?1`,
      b.businessId,
    );
    expect(inboundA.map((row) => row.text_body)).toEqual(["para A"]);
    expect(inboundB.map((row) => row.text_body)).toEqual(["para B"]);
    expect(inboundA[0]!.conversation_id).not.toBe(inboundB[0]!.conversation_id);

    // Processing store A touches only store A.
    h.clock.advance(4_000);
    const rings = h.doorbell.take();
    await h.deliver(rings.filter((ring) => ring.conversation.businessId === a.businessId));
    const jobState = async (businessId: string) =>
      (await rows<{ job_state: string }>(`SELECT job_state FROM inbound_messages WHERE business_id = ?1`, businessId)).map(
        (row) => row.job_state,
      );
    expect(await jobState(a.businessId)).toEqual(["done"]);
    expect(await jobState(b.businessId)).toEqual(["pending"]);
    expect(h.channel.sent.map((sent) => [sent.fromPhoneNumberId, sent.toPhone, sent.body])).toEqual([
      [a.phoneNumberId, shared, RECEIVED_PLACEHOLDER],
    ]);

    await h.deliver(rings.filter((ring) => ring.conversation.businessId === b.businessId));
    expect(h.channel.sent.map((sent) => sent.fromPhoneNumberId)).toEqual([a.phoneNumberId, b.phoneNumberId]);

    // Media lives under each store's own prefix, and nowhere else.
    const keysA = (await env.MEDIA.list({ prefix: `stores/${a.businessId}/` })).objects.map((o) => o.key);
    const keysB = (await env.MEDIA.list({ prefix: `stores/${b.businessId}/` })).objects.map((o) => o.key);
    expect(keysA).toHaveLength(1);
    expect(keysB).toHaveLength(1);
    const assetsA = await rows<{ stored_key: string }>(`SELECT stored_key FROM media_assets WHERE business_id = ?1`, a.businessId);
    expect(assetsA.map((row) => row.stored_key)).toEqual(keysA);
  });

  it("scope every repository read: another store's IDs return nothing", async () => {
    const h = harness();
    const onlyInB = newPhone();
    const a = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    const b = await seedStore({ members: [{ phone: onlyInB, role: "owner" }] });
    await h.post(webhook(b.phoneNumberId, { messages: [textMessage({ from: onlyInB, id: wamid(), timestampS: T0, body: "Hola" })] }));
    const [conversationB] = await rows<{ id: string }>(`SELECT id FROM conversations WHERE business_id = ?1`, b.businessId);
    const guessed = { businessId: a.businessId, conversationId: conversationB!.id };

    expect(await h.deps.tenancy.findActiveMember({ businessId: a.businessId }, onlyInB)).toBeNull();
    expect(await h.deps.tenancy.findChannelAccountOf({ businessId: a.businessId }, b.channelAccountId)).toBeNull();
    expect(await h.deps.jobs.snapshot(guessed, h.clock.now() + 60_000, 10)).toEqual({
      openCount: 0,
      newestReceivedAtMs: null,
      seq: 0,
      jobs: [],
    });
    expect(await h.deps.jobs.hasArrivalsAfter(guessed, 0)).toBe(false);
    expect(await h.deps.jobs.claimLease(guessed, "lease-x", 60_000)).toBe("missing");
    expect(await h.deps.outbox.customerPhone({ businessId: a.businessId }, conversationB!.id)).toBeNull();
    expect(await h.deps.outbox.listDispatchable(h.clock.now(), 10, guessed)).toEqual([]);
  });

  it("refuse cross-store references in the database itself", async () => {
    const a = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    const bPhone = newPhone();
    const b = await seedStore({ members: [{ phone: bPhone, role: "owner" }] });
    const h = harness();
    await h.post(webhook(b.phoneNumberId, { messages: [textMessage({ from: bPhone, id: wamid(), timestampS: T0, body: "Hola" })] }));
    const [conversationB] = await rows<{ id: string }>(`SELECT id FROM conversations WHERE business_id = ?1`, b.businessId);

    // A store-A message pointing at store B's conversation violates the composite foreign key.
    await expect(
      env.DB.prepare(
        `INSERT INTO inbound_messages (id, business_id, conversation_id, provider, provider_message_id,
           provider_timestamp_s, order_ts_s, received_at_ms, kind, job_state)
         VALUES (?1, ?2, ?3, 'whatsapp', ?4, ?5, ?5, ?6, 'text', 'pending')`,
      )
        .bind(crypto.randomUUID(), a.businessId, conversationB!.id, wamid(), T0, 0)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);

    // A media key outside the owning store's prefix violates its CHECK.
    await expect(
      env.DB.prepare(
        `INSERT INTO media_assets (id, business_id, provider, provider_media_id, object_key, state, created_at_ms)
         VALUES (?1, ?2, 'whatsapp', 'm-x', ?3, 'pending', 0)`,
      )
        .bind(crypto.randomUUID(), a.businessId, `stores/${b.businessId}/media/x`)
        .run(),
    ).rejects.toThrow(/CHECK/);

    // A conversation between store A's number and store B's customer.
    const [customerB] = await rows<{ id: string }>(`SELECT id FROM customers WHERE business_id = ?1`, b.businessId);
    await expect(
      env.DB.prepare(
        `INSERT INTO conversations (id, business_id, channel_account_id, customer_id, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, 0)`,
      )
        .bind(crypto.randomUUID(), a.businessId, a.channelAccountId, customerB!.id)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("keep their customers apart: one phone is a separate customer of each store, and reads never cross", async () => {
    const h = harness();
    const shared = newPhone();
    const a = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    // A member of store B writes to store A: to A, they are simply a customer.
    const b = await seedStore({ members: [{ phone: shared, role: "owner" }] });
    for (const store of [a, b]) {
      await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: shared, id: wamid(), timestampS: T0, body: "Hola" })] }));
    }
    const of = async (businessId: string) => {
      const [row] = await rows<{ conversation_id: string; customer_id: string }>(
        `SELECT c.id AS conversation_id, c.customer_id FROM conversations c
         JOIN customers cu ON cu.business_id = c.business_id AND cu.id = c.customer_id
         WHERE c.business_id = ?1 AND cu.phone = ?2`,
        businessId,
        shared,
      );
      return row!;
    };
    const inA = await of(a.businessId);
    const inB = await of(b.businessId);
    expect(inA.customer_id).not.toBe(inB.customer_id);
    expect(inA.conversation_id).not.toBe(inB.conversation_id);

    // Store A's scope never reads store B's conversation or customer, and the other way round.
    expect(await h.deps.customers.ofConversation({ businessId: a.businessId, conversationId: inB.conversation_id })).toBeNull();
    expect(await h.deps.customers.ofConversation({ businessId: b.businessId, conversationId: inA.conversation_id })).toBeNull();
    expect(await h.deps.outbox.customerPhone({ businessId: a.businessId }, inB.conversation_id)).toBeNull();
    expect(await h.deps.outbox.customerPhone({ businessId: a.businessId }, inA.conversation_id)).toBe(shared);
    expect((await h.deps.customers.ofConversation({ businessId: a.businessId, conversationId: inA.conversation_id }))?.id).toBe(
      inA.customer_id,
    );

    // Each store's replies go to its own conversation, from its own number.
    h.clock.advance(4_000);
    await h.deliver();
    expect(h.channel.sent.map((sent) => [sent.fromPhoneNumberId, sent.toPhone]).sort()).toEqual(
      [
        [a.phoneNumberId, shared],
        [b.phoneNumberId, shared],
      ].sort(),
    );
  });
});
