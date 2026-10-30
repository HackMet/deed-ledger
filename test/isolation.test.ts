import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RECEIVED_PLACEHOLDER, UNKNOWN_SENDER_NOTICE } from "../src/domain/copy";
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
    expect(await h.deps.outbox.memberPhone({ businessId: a.businessId }, conversationB!.id)).toBeNull();
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

    // A conversation between store A's number and someone who isn't a member of store A.
    await expect(
      env.DB.prepare(
        `INSERT INTO conversations (id, business_id, channel_account_id, user_id, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, 0)`,
      )
        .bind(crypto.randomUUID(), a.businessId, a.channelAccountId, b.members[0]!.userId)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("treat a member of store B writing to store A's number as unknown to A", async () => {
    const h = harness();
    const bOwner = newPhone();
    const a = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    const b = await seedStore({ members: [{ phone: bOwner, role: "owner" }] });
    await h.post(webhook(a.phoneNumberId, { messages: [textMessage({ from: bOwner, id: wamid(), timestampS: T0, body: "Hola" })] }));

    expect(h.sentTo(bOwner)).toEqual([UNKNOWN_SENDER_NOTICE]);
    expect(h.channel.sent[0]?.fromPhoneNumberId).toBe(a.phoneNumberId);
    expect(await rows(`SELECT id FROM inbound_messages WHERE business_id IN (?1, ?2)`, a.businessId, b.businessId)).toEqual([]);
    expect(await rows(`SELECT id FROM conversations WHERE business_id IN (?1, ?2)`, a.businessId, b.businessId)).toEqual([]);
    expect(h.doorbell.rings).toEqual([]);
  });
});
