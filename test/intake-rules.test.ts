import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { JobHandler } from "../src/application/ports";
import { UNKNOWN_SENDER_NOTICE } from "../src/domain/copy";
import { UNKNOWN_SENDER_MESSAGES_PER_DAY } from "../src/domain/outbox";
import { MEMBER_MESSAGES_PER_HOUR } from "../src/domain/processing";
import { constraintFailingDb, gatedDb, hookDb } from "./helpers/fakes";
import { conversationOf, type Harness, harness, OUTLIVES_TEST_MS, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { imageMessage, textMessage, wamid, webhook } from "./helpers/whatsapp";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
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

  it("can't delete a membership; a deactivated member is treated as unknown", async () => {
    const { store, phone } = await storeWithOwner();
    await expect(env.DB.prepare(`DELETE FROM memberships WHERE business_id = ?`).bind(store.businessId).run()).rejects.toThrow(
      /deactivated, never deleted/,
    );
    await env.DB.prepare(`UPDATE memberships SET active = 0 WHERE business_id = ?`).bind(store.businessId).run();
    const h = harness();
    await say(h, store.phoneNumberId, phone, "Hola");
    expect(h.sentTo(phone)).toEqual([UNKNOWN_SENDER_NOTICE]);
    expect(await rows(`SELECT id FROM inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([]);
  });

  it("treats a member deactivated between the lookup and the write as unknown, storing no message or job (G6)", async () => {
    const { store, phone } = await storeWithOwner();
    // The membership lookup says "active"; the membership is deactivated before the intake batch runs.
    const db = hookDb(env.DB, /FROM memberships m JOIN users u/, async () => {
      await env.DB.prepare(`UPDATE memberships SET active = 0 WHERE business_id = ?`).bind(store.businessId).run();
    });
    const h = harness({ db });
    expect((await say(h, store.phoneNumberId, phone, "Hola")).status).toBe(200);

    expect(await rows(`SELECT id FROM inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([]);
    expect(await rows(`SELECT id FROM conversations WHERE business_id = ?`, store.businessId)).toEqual([]);
    expect(h.doorbell.rings).toEqual([]);
    expect(h.sentTo(phone)).toEqual([UNKNOWN_SENDER_NOTICE]);
    expect(await rows(`SELECT 1 FROM unknown_inbound_messages WHERE business_id = ?`, store.businessId)).toHaveLength(1);
    expect(h.log.fields("member_intake_not_member")).toEqual([
      { level: "warn", event: "member_intake_not_member", businessId: store.businessId, outcome: "not_member" },
    ]);
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

describe("the unknown-sender notice (F10)", () => {
  it("is retried inline and sent once", async () => {
    const h = harness();
    const { store } = await storeWithOwner();
    const stranger = newPhone();
    h.channel.nextResults.push({ ok: false, disposition: "retry", errorCode: "http_429" });
    await say(h, store.phoneNumberId, stranger, "Hola");
    expect(h.sentTo(stranger)).toEqual([UNKNOWN_SENDER_NOTICE]);
    expect(h.sleeps).toEqual([250]);
  });

  it("frees the 24-hour slot when every inline attempt fails, so the next message retries it", async () => {
    const h = harness();
    const { store } = await storeWithOwner();
    const stranger = newPhone();
    for (let n = 0; n < 3; n++) h.channel.nextResults.push({ ok: false, disposition: "retry", errorCode: "http_429" });
    await say(h, store.phoneNumberId, stranger, "Hola");
    expect(h.sentTo(stranger)).toEqual([]);
    expect(await rows(`SELECT status FROM outbound_messages WHERE business_id = ?`, store.businessId)).toEqual([{ status: "failed" }]);

    h.clock.advance(60_000);
    await say(h, store.phoneNumberId, stranger, "¿Hola?");
    expect(h.sentTo(stranger)).toEqual([UNKNOWN_SENDER_NOTICE]);
    expect(await rows(`SELECT status FROM outbound_messages WHERE business_id = ?`, store.businessId)).toEqual([{ status: "sent" }]);
  });

  it("measures the 24-hour slot from the successful send", async () => {
    const h = harness();
    const { store } = await storeWithOwner();
    const stranger = newPhone();
    for (let n = 0; n < 3; n++) h.channel.nextResults.push({ ok: false, disposition: "retry", errorCode: "http_429" });
    await say(h, store.phoneNumberId, stranger, "1"); // T: not sent
    h.clock.advance(20 * HOUR);
    await say(h, store.phoneNumberId, stranger, "2"); // T+20h: sent
    h.clock.advance(5 * HOUR);
    await say(h, store.phoneNumberId, stranger, "3"); // T+25h, 5 h after the send: nothing
    expect(h.sentTo(stranger)).toHaveLength(1);
    h.clock.advance(19 * HOUR + 1);
    await say(h, store.phoneNumberId, stranger, "4"); // 24 h after the send: a new notice
    expect(h.sentTo(stranger)).toHaveLength(2);
  });

  it("is pruned by its latest activity: one re-opened and sent near day 7 still holds its 24 hours (G10)", async () => {
    const h = harness();
    const { store } = await storeWithOwner();
    const stranger = newPhone();
    for (let n = 0; n < 3; n++) h.channel.nextResults.push({ ok: false, disposition: "retry", errorCode: "http_429" });
    await say(h, store.phoneNumberId, stranger, "1"); // day 0: the notice is created, but not sent
    h.clock.advance(7 * DAY - HOUR);
    await say(h, store.phoneNumberId, stranger, "2"); // an hour before day 7: re-opened and sent
    expect(h.sentTo(stranger)).toEqual([UNKNOWN_SENDER_NOTICE]);

    h.clock.advance(2 * HOUR); // created over 7 days ago, sent an hour ago
    await h.runCron();
    await say(h, store.phoneNumberId, stranger, "3");
    expect(h.sentTo(stranger)).toEqual([UNKNOWN_SENDER_NOTICE]); // still inside its 24 hours
    expect(await rows(`SELECT status FROM outbound_messages WHERE business_id = ?`, store.businessId)).toEqual([{ status: "sent" }]);
  });
});

describe("spam bounds (F11)", () => {
  it(`stores at most ${UNKNOWN_SENDER_MESSAGES_PER_DAY} messages per unknown sender per day, and prunes them after 7 days`, async () => {
    const h = harness();
    const { store } = await storeWithOwner();
    const stranger = newPhone();
    for (let n = 0; n < UNKNOWN_SENDER_MESSAGES_PER_DAY + 3; n++) {
      expect((await say(h, store.phoneNumberId, stranger, `spam ${n}`)).status).toBe(200);
    }
    expect(await rows(`SELECT 1 FROM unknown_inbound_messages WHERE business_id = ?`, store.businessId)).toHaveLength(
      UNKNOWN_SENDER_MESSAGES_PER_DAY,
    );
    expect(h.log.fields("unknown_sender_recorded").filter((line) => line.outcome === "capped")).toHaveLength(3);
    expect(h.sentTo(stranger)).toEqual([UNKNOWN_SENDER_NOTICE]);

    h.clock.advance(7 * 24 * HOUR + 1);
    await h.runCron();
    expect(await rows(`SELECT 1 FROM unknown_inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([]);
    expect(await rows(`SELECT 1 FROM outbound_messages WHERE business_id = ?`, store.businessId)).toEqual([]);
  });

  it(`caps a member conversation at ${MEMBER_MESSAGES_PER_HOUR} messages an hour, logged`, async () => {
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
    expect(h.log.fields("member_intake_capped")).toHaveLength(1);
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
    expect(h.log.fields("member_intake_capped")).toHaveLength(3);
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
