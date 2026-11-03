import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { JobHandler } from "../src/application/ports";
import { MEMBER_MESSAGES_PER_HOUR } from "../src/domain/processing";
import { constraintFailingDb, gatedDb } from "./helpers/fakes";
import { conversationOf, type Harness, harness, OUTLIVES_TEST_MS, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { imageMessage, textMessage, wamid, webhook } from "./helpers/whatsapp";

const HOUR = 60 * 60 * 1000;
const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

async function storeWithOwner() {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  return { store, phone };
}

function say(h: Harness, phoneNumberId: string, from: string, body: string, timestampS = nowS(h), id = wamid()) {
  return h.post(webhook(phoneNumberId, { messages: [textMessage({ from, id, timestampS, body })] }));
}

describe("provider time (F7)", () => {
  it("is clamped for ordering, and the 24-hour window runs from our own receive time", async () => {
    const order: string[] = [];
    const lasting: JobHandler = {
      async handle({ job, isNewestOfBurst }) {
        order.push(job.textBody ?? "");
        return { replies: isNewestOfBurst ? [{ body: "ok", ttlMs: OUTLIVES_TEST_MS }] : [] };
      },
    };
    const h = harness({ jobHandler: lasting });
    const { store, phone } = await storeWithOwner();
    const year = 365 * 24 * 60 * 60;
    await say(h, store.phoneNumberId, phone, "A, fechado un año adelante", nowS(h) + year);
    h.clock.advance(400_000);
    await say(h, store.phoneNumberId, phone, "B", nowS(h));
    h.clock.advance(4_000);
    h.channel.nextResults.push({ ok: false, disposition: "retry", errorCode: "http_429" });
    await h.deliver(h.doorbell.take().slice(0, 1));
    expect(order).toEqual(["A, fechado un año adelante", "B"]); // A clamped to received + 5 minutes

    h.clock.advance(25 * HOUR); // 25 h after B arrived: the window is closed, whatever A claimed
    await h.runCron();
    expect(h.sentTo(phone)).toEqual([]);
    expect(await rows(`SELECT status FROM outbound_messages WHERE business_id = ?`, store.businessId)).toEqual([
      { status: "waiting_window" },
    ]);
  });
});

describe("intake failures (F8)", () => {
  it("answers 200 to a permanent write error, logging IDs only, and 500 stays for transient ones", async () => {
    const { store, phone } = await storeWithOwner();
    const h = harness({ db: constraintFailingDb(env.DB) });
    expect((await say(h, store.phoneNumberId, phone, "texto privado")).status).toBe(200);
    const [logged] = h.log.fields("intake_rejected_permanently");
    expect(logged).toMatchObject({ businessId: store.businessId, channelAccountId: store.channelAccountId });
    expect(h.log.lines.join("\n")).not.toContain("texto privado");
    expect(h.doorbell.rings).toEqual([]);
    expect(await rows(`SELECT id FROM inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([]);
  });

  it("can't delete a membership; a deactivated member writing to the store is still its customer", async () => {
    const { store, phone } = await storeWithOwner();
    await expect(env.DB.prepare(`DELETE FROM memberships WHERE business_id = ?`).bind(store.businessId).run()).rejects.toThrow(
      /deactivated, never deleted/,
    );
    await env.DB.prepare(`UPDATE memberships SET active = 0 WHERE business_id = ?`).bind(store.businessId).run();
    const h = harness();
    await say(h, store.phoneNumberId, phone, "Hola");
    // Memberships only matter for the console: the message is stored as a customer's.
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ?`, store.businessId)).toHaveLength(1);
    expect(await rows(`SELECT 1 FROM customers WHERE business_id = ? AND phone = ?`, store.businessId, phone)).toHaveLength(1);
    expect(await rows(`SELECT 1 FROM unknown_inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([]);
  });
});

describe("de-duplication (F9)", () => {
  it("is scoped to the store: the same provider message ID in two stores is two messages", async () => {
    const h = harness();
    const a = await storeWithOwner();
    const b = await storeWithOwner();
    const id = wamid();
    await say(h, a.store.phoneNumberId, a.phone, "para A", nowS(h), id);
    await say(h, b.store.phoneNumberId, b.phone, "para B", nowS(h), id);
    expect(await rows(`SELECT text_body FROM inbound_messages WHERE business_id = ?`, a.store.businessId)).toEqual([{ text_body: "para A" }]);
    expect(await rows(`SELECT text_body FROM inbound_messages WHERE business_id = ?`, b.store.businessId)).toEqual([{ text_body: "para B" }]);
    expect(h.doorbell.rings).toHaveLength(2);
  });
});

describe("spam bounds (F11)", () => {
  it(`caps a customer conversation at ${MEMBER_MESSAGES_PER_HOUR} messages an hour, logged`, async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    await say(h, store.phoneNumberId, phone, "primero");
    const conversation = await conversationOf(store.businessId);
    const filler = Array.from({ length: MEMBER_MESSAGES_PER_HOUR - 1 }, (_, n) =>
      env.DB.prepare(
        `INSERT INTO inbound_messages (id, business_id, conversation_id, provider, provider_message_id, provider_timestamp_s,
           order_ts_s, received_at_ms, kind, job_state)
         VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, ?, 'text', 'done')`,
      ).bind(crypto.randomUUID(), store.businessId, conversation.conversationId, wamid(`FILL${n}`), nowS(h), nowS(h), h.clock.now()),
    );
    await env.DB.batch(filler);
    h.doorbell.take();

    expect((await say(h, store.phoneNumberId, phone, "uno de más")).status).toBe(200);
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ?`, store.businessId)).toHaveLength(MEMBER_MESSAGES_PER_HOUR);
    expect(h.log.fields("customer_intake_capped")).toHaveLength(1);
    expect(h.doorbell.rings).toEqual([]);
  });

  it("writes no media asset for a message that is a duplicate or over the cap (G9)", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    const photo = (id: string, mediaId: string) =>
      h.post(webhook(store.phoneNumberId, { messages: [imageMessage({ from: phone, id, timestampS: nowS(h), mediaId })] }));
    const assets = async () => (await rows(`SELECT 1 FROM media_assets WHERE business_id = ?`, store.businessId)).length;

    // A duplicate: the same message again, even naming other media, adds nothing.
    const id = wamid();
    await photo(id, "m-first");
    await photo(id, "m-other");
    expect(await assets()).toBe(1);

    // Over the hourly cap: photos are dropped whole, with no asset rows left behind.
    const conversation = await conversationOf(store.businessId);
    const filler = Array.from({ length: MEMBER_MESSAGES_PER_HOUR - 1 }, (_, n) =>
      env.DB.prepare(
        `INSERT INTO inbound_messages (id, business_id, conversation_id, provider, provider_message_id, provider_timestamp_s,
           order_ts_s, received_at_ms, kind, job_state)
         VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, ?, 'text', 'done')`,
      ).bind(crypto.randomUUID(), store.businessId, conversation.conversationId, wamid(`FILL${n}`), nowS(h), nowS(h), h.clock.now()),
    );
    await env.DB.batch(filler);
    for (let n = 0; n < 3; n++) expect((await photo(wamid(), `m-capped-${n}`)).status).toBe(200);
    expect(await assets()).toBe(1);
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ?`, store.businessId)).toHaveLength(MEMBER_MESSAGES_PER_HOUR);
    expect(h.log.fields("customer_intake_capped")).toHaveLength(3);
  });
});

describe("the acknowledgement (F19)", () => {
  it("can't answer 200 before the intake write commits", async () => {
    const { store, phone } = await storeWithOwner();
    const gate = gatedDb(env.DB);
    const h = harness({ db: gate.db });
    let answered = false;
    const { response } = await h.start(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
    void response.then(() => {
      answered = true;
    });

    await vi.waitUntil(() => gate.waiting(), { timeout: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false); // the write is held, and so is the answer
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([]);

    gate.open();
    expect((await response).status).toBe(200);
    expect(await rows(`SELECT 1 FROM inbound_messages WHERE business_id = ?`, store.businessId)).toHaveLength(1);
  });
});
