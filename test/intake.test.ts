import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { UNKNOWN_SENDER_NOTICE } from "../src/domain/copy";
import { failingBatchDb, recordingDb } from "./helpers/fakes";
import { harness, rows } from "./helpers/harness";
import { newPhone, newPhoneNumberId, seedStore } from "./helpers/seed";
import { imageMessage, statusUpdate, textMessage, wamid, webhook } from "./helpers/whatsapp";

const T0 = 1_793_196_000; // provider timestamps (Unix seconds), synthetic

async function storeWithOwner() {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  return { store, phone };
}

describe("member messages", () => {
  it("saves the message and its pending job before answering 200, then rings with only the reference", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    const id = wamid();
    const response = await h.post(
      webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id, timestampS: T0, body: "Vinieron 2 cajas" })] }),
    );
    expect(response.status).toBe(200);

    const saved = await rows<{ job_state: string; attempts: number; kind: string; text_body: string; conversation_id: string }>(
      `SELECT job_state, attempts, kind, text_body, conversation_id FROM inbound_messages WHERE business_id = ?1`,
      store.businessId,
    );
    expect(saved).toEqual([
      { job_state: "pending", attempts: 0, kind: "text", text_body: "Vinieron 2 cajas", conversation_id: expect.any(String) },
    ]);
    expect(h.doorbell.rings).toEqual([
      { conversation: { businessId: store.businessId, conversationId: saved[0]!.conversation_id }, delaySeconds: 0 },
    ]);
  });

  it("absorbs duplicate deliveries: one inbound row, one job, and no ring for a duplicate", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    const id = wamid();
    const body = webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id, timestampS: T0, body: "Hola" })] });
    expect((await h.post(body)).status).toBe(200);
    expect(h.doorbell.take()).toHaveLength(1);
    expect((await h.post(body)).status).toBe(200);
    expect(h.doorbell.take()).toEqual([]); // the sweep recovers a lost ring; duplicates don't ring
    // The same message again, batched with a new one.
    const other = wamid();
    expect(
      (
        await h.post(
          webhook(store.phoneNumberId, {
            messages: [
              textMessage({ from: phone, id, timestampS: T0, body: "Hola" }),
              textMessage({ from: phone, id: other, timestampS: T0 + 1, body: "Otra" }),
            ],
          }),
        )
      ).status,
    ).toBe(200);

    const saved = await rows<{ provider_message_id: string }>(
      `SELECT provider_message_id FROM inbound_messages WHERE business_id = ?1 ORDER BY provider_timestamp_s`,
      store.businessId,
    );
    expect(saved.map((row) => row.provider_message_id)).toEqual([id, other]);
    const [conversations] = await rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM conversations WHERE business_id = ?1`,
      store.businessId,
    );
    expect(conversations?.n).toBe(1);
    expect(h.log.fields("inbound_recorded").map((line) => line.outcome)).toEqual(["new", "duplicate", "duplicate", "new"]);
    expect(h.doorbell.take()).toHaveLength(1); // only for the new message in the last delivery
  });

  it("answers 500 when the write fails, and saves the message once when Meta retries", async () => {
    const { store, phone } = await storeWithOwner();
    const body = webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: T0, body: "Hola" })] });

    const broken = harness({ db: failingBatchDb(env.DB) });
    expect((await broken.post(body)).status).toBe(500);
    expect(broken.doorbell.rings).toEqual([]);
    expect(await rows(`SELECT id FROM inbound_messages WHERE business_id = ?1`, store.businessId)).toHaveLength(0);

    const healthy = harness();
    expect((await healthy.post(body)).status).toBe(200);
    expect((await healthy.post(body)).status).toBe(200);
    expect(await rows(`SELECT id FROM inbound_messages WHERE business_id = ?1`, store.businessId)).toHaveLength(1);
  });

  it("keeps media under the store's prefix", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    await h.post(
      webhook(store.phoneNumberId, {
        messages: [imageMessage({ from: phone, id: wamid(), timestampS: T0, mediaId: "media-synthetic-1", caption: "Factura" })],
      }),
    );
    const assets = await rows<{ object_key: string; state: string; id: string }>(
      `SELECT id, object_key, state FROM media_assets WHERE business_id = ?1`,
      store.businessId,
    );
    expect(assets).toHaveLength(1);
    expect(assets[0]!.object_key).toBe(`stores/${store.businessId}/media/${assets[0]!.id}`);
    expect(assets[0]!.state).toBe("pending");
  });

  it("ignores a receiving number no store owns: nothing saved, no reply", async () => {
    const h = harness();
    const response = await h.post(
      webhook(newPhoneNumberId(), { messages: [textMessage({ from: newPhone(), id: wamid(), timestampS: T0, body: "Hola" })] }),
    );
    expect(response.status).toBe(200);
    expect(h.doorbell.rings).toEqual([]);
    expect(h.channel.sent).toEqual([]);
    expect(h.log.events()).toContain("webhook_event_for_unknown_number");
  });
});

describe("numbers that aren't members", () => {
  it("get exactly one fixed reply, and nothing of the store is read", async () => {
    const { store } = await storeWithOwner();
    const stranger = newPhone();
    const id = wamid();
    const recorder = recordingDb(env.DB);
    const h = harness({ db: recorder.db });

    const response = await h.post(
      webhook(store.phoneNumberId, {
        messages: [imageMessage({ from: stranger, id, timestampS: T0, mediaId: "media-stranger", caption: "Mi pedido" })],
      }),
    );
    expect(response.status).toBe(200);

    // One reply, the fixed text, to the sender, from the store's number.
    expect(h.channel.sent).toEqual([
      { fromPhoneNumberId: store.phoneNumberId, toPhone: stranger, body: UNKNOWN_SENDER_NOTICE, providerMessageId: expect.any(String) },
    ]);
    // No job, no conversation, no media, no doorbell, no download.
    expect(h.doorbell.rings).toEqual([]);
    expect(h.mediaSource).toMatchObject({ fetched: [] });
    expect(await rows(`SELECT id FROM inbound_messages WHERE business_id = ?1`, store.businessId)).toHaveLength(0);
    expect(await rows(`SELECT id FROM conversations WHERE business_id = ?1`, store.businessId)).toHaveLength(0);
    expect(await rows(`SELECT id FROM media_assets WHERE business_id = ?1`, store.businessId)).toHaveLength(0);

    // Every statement touched only the number mapping, memberships, and the hashed records, plus the
    // send's claim guard (batch_guards holds no data: each guard row is deleted in its own batch).
    const allowed = new Set([
      "channel_accounts",
      "memberships",
      "users",
      "unknown_inbound_messages",
      "outbound_messages",
      "batch_guards",
    ]);
    const touched = new Set(
      recorder.statements.flatMap((sql) => [...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/gi)].map((m) => m[1]!)),
    );
    expect([...touched].filter((table) => !allowed.has(table))).toEqual([]);
    expect(await rows(`SELECT guard_id FROM batch_guards`)).toEqual([]);

    // Only keyed hashes are kept: no phone number, no message ID (it embeds the phone), no content.
    const kept = await rows(`SELECT * FROM unknown_inbound_messages WHERE business_id = ?1`, store.businessId);
    const outbox = await rows(`SELECT * FROM outbound_messages WHERE business_id = ?1`, store.businessId);
    const stored = JSON.stringify([kept, outbox]);
    expect(kept).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(stored).not.toContain(stranger);
    expect(stored).not.toContain(id);
    expect(stored).not.toContain("Mi pedido");
    expect(outbox[0]).toMatchObject({ status: "sent", provider_message_id: null, conversation_id: null });
  });

  it("get the notice at most once per 24 hours", async () => {
    const { store } = await storeWithOwner();
    const stranger = newPhone();
    const h = harness();
    const say = (body: string) =>
      h.post(
        webhook(store.phoneNumberId, {
          messages: [textMessage({ from: stranger, id: wamid(), timestampS: Math.floor(h.clock.now() / 1000), body })],
        }),
      );

    await say("Hola");
    h.clock.advance(60_000);
    await say("¿Hay alguien?");
    h.clock.advance(23 * 60 * 60 * 1000);
    await say("Hola otra vez");
    expect(h.channel.sent).toHaveLength(1);

    h.clock.advance(60 * 60 * 1000 + 1);
    await say("Buenas");
    expect(h.channel.sent).toHaveLength(2);
    expect(await rows(`SELECT 1 FROM unknown_inbound_messages WHERE business_id = ?1`, store.businessId)).toHaveLength(4);
  });

  it("don't get a second notice when Meta redelivers the same message", async () => {
    const { store } = await storeWithOwner();
    const body = webhook(store.phoneNumberId, { messages: [textMessage({ from: newPhone(), id: wamid(), timestampS: T0, body: "Hola" })] });
    const h = harness();
    await h.post(body);
    h.clock.advance(25 * 60 * 60 * 1000); // retries can come days later
    await h.post(body);
    expect(h.channel.sent).toHaveLength(1);
  });

  it("logs no phone numbers, message IDs or content", async () => {
    const { store, phone } = await storeWithOwner();
    const stranger = newPhone();
    const ids = [wamid(), wamid()];
    const h = harness();
    await h.post(
      webhook(store.phoneNumberId, {
        messages: [
          textMessage({ from: stranger, id: ids[0]!, timestampS: T0, body: "texto privado uno" }),
          textMessage({ from: phone, id: ids[1]!, timestampS: T0, body: "texto privado dos" }),
        ],
      }),
    );
    h.clock.advance(5_000);
    await h.deliver();
    const logged = h.log.lines.join("\n");
    for (const secret of [stranger, phone, ...ids, "texto privado"]) expect(logged).not.toContain(secret);
  });
});

describe("delivery status callbacks", () => {
  it("only move forward, ignore unknown messages, and stay inside the store", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    const other = await storeWithOwner();
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: T0, body: "Hola" })] }));
    h.clock.advance(5_000);
    await h.deliver();
    const [sent] = await rows<{ provider_message_id: string; id: string }>(
      `SELECT id, provider_message_id FROM outbound_messages WHERE business_id = ?1`,
      store.businessId,
    );
    expect(sent?.provider_message_id).toMatch(/^wamid\.TEST-OUT-/);
    const status = (s: string, ts: number, phoneNumberId = store.phoneNumberId, id = sent!.provider_message_id) =>
      h.post(webhook(phoneNumberId, { statuses: [statusUpdate({ id, status: s, timestampS: ts })] }));
    const current = async () =>
      (await rows<{ provider_status: string }>(`SELECT provider_status FROM outbound_messages WHERE id = ?1`, sent!.id))[0]
        ?.provider_status;

    expect((await status("delivered", T0 + 10)).status).toBe(200);
    expect(await current()).toBe("delivered");
    await status("sent", T0 + 5); // late, older status
    expect(await current()).toBe("delivered");
    await status("read", T0 + 20, other.store.phoneNumberId); // another store's number
    expect(await current()).toBe("delivered");
    await status("read", T0 + 20);
    expect(await current()).toBe("read");
    expect((await status("read", T0 + 30, store.phoneNumberId, "wamid.TEST-UNKNOWN")).status).toBe(200);
    expect((await status("bogus", T0 + 40)).status).toBe(200);
    expect(await current()).toBe("read");
  });
});
