import { describe, expect, it } from "vitest";
import { dispatchOutbox } from "../src/application/dispatch";
import type { JobHandler } from "../src/application/ports";
import { buildRuntime } from "../src/composition";
import { MAX_SEND_ATTEMPTS } from "../src/domain/outbox";
import { WhatsAppCloudChannel } from "../src/integrations/whatsapp/client";
import { conversationOf, type Harness, harness, OUTLIVES_TEST_MS, rows, testEnv } from "./helpers/harness";
import { newPhone, seedIntroducedCustomer, seedStore } from "./helpers/seed";
import { textMessage, wamid, webhook } from "./helpers/whatsapp";

const DAY_MS = 24 * 60 * 60 * 1000;
const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

/** Replies that outlive these tests, so they are only about the window and retries. */
const lastingReply: JobHandler = {
  async handle({ isNewestOfBurst }) {
    return { replies: isNewestOfBurst ? [{ body: "Respuesta sin vencimiento", ttlMs: OUTLIVES_TEST_MS }] : [] };
  },
};

async function storeWithOwner() {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  return { store, phone };
}

async function outbox(businessId: string) {
  return rows<{ status: string; attempts: number; last_error: string | null }>(
    `SELECT status, attempts, last_error FROM outbound_messages WHERE business_id = ? ORDER BY seq`,
    businessId,
  );
}

async function say(h: Harness, phoneNumberId: string, from: string, body: string) {
  expect(
    (await h.post(webhook(phoneNumberId, { messages: [textMessage({ from, id: wamid(), timestampS: nowS(h), body })] }))).status,
  ).toBe(200);
}

describe("outbox dispatch", () => {
  it("holds a message whose 24-hour window closed between enqueue and send, and sends it when it reopens", async () => {
    const h = harness({ jobHandler: lastingReply });
    const { store, phone } = await storeWithOwner();
    await say(h, store.phoneNumberId, phone, "Hola");
    h.clock.advance(4_000);
    h.channel.nextResults.push({ ok: false, disposition: "retry", errorCode: "http_429" });
    await h.deliver(); // processed and queued; the first send attempt fails
    expect(await outbox(store.businessId)).toEqual([{ status: "pending", attempts: 1, last_error: "http_429" }]);

    h.clock.advance(DAY_MS); // the window closes before the retry
    await h.runCron();
    await h.runCron(); // re-checking the window doesn't use up attempts
    expect(h.sentTo(phone)).toEqual([]);
    expect(await outbox(store.businessId)).toEqual([{ status: "waiting_window", attempts: 1, last_error: "http_429" }]);

    await say(h, store.phoneNumberId, phone, "¿Seguís ahí?"); // the member writes again: window open
    h.clock.advance(4_000);
    await h.deliver();
    expect(h.sentTo(phone)).toEqual(["Respuesta sin vencimiento", "Respuesta sin vencimiento"]);
    expect((await outbox(store.businessId)).map((row) => row.status)).toEqual(["sent", "sent"]);
  });

  it("sends nothing without credentials and keeps the message pending", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    // A returning customer, already introduced (#30): this test counts replies.
    await seedIntroducedCustomer(store, phone);
    await say(h, store.phoneNumberId, phone, "Hola");
    h.channel.configured = false;
    h.clock.advance(4_000);
    await h.deliver();
    await h.runCron();
    expect(h.sentTo(phone)).toEqual([]);
    expect(await outbox(store.businessId)).toEqual([{ status: "pending", attempts: 0, last_error: null }]);
    expect(h.log.events()).toContain("outbox_dispatch_skipped");

    // The real WhatsApp client built from the test env is unconfigured too.
    const { deps } = buildRuntime(testEnv());
    expect(deps.channel.configured).toBe(false);
    expect(await dispatchOutbox(deps, { limit: 10 })).toEqual([]);
  });

  it("fails a message on a permanent error, and after the last retry on temporary ones", async () => {
    const h = harness({ jobHandler: lastingReply });
    const a = await storeWithOwner();
    await say(h, a.store.phoneNumberId, a.phone, "Hola");
    h.clock.advance(4_000);
    h.channel.nextResults.push({ ok: false, disposition: "permanent", errorCode: "http_400" });
    await h.deliver();
    expect(await outbox(a.store.businessId)).toEqual([{ status: "failed", attempts: 1, last_error: "http_400" }]);

    const b = await storeWithOwner();
    await say(h, b.store.phoneNumberId, b.phone, "Hola");
    h.clock.advance(4_000);
    for (let n = 0; n < MAX_SEND_ATTEMPTS; n++) h.channel.nextResults.push({ ok: false, disposition: "retry", errorCode: "http_429" });
    await h.deliver();
    const conversation = await conversationOf(b.store.businessId);
    for (let n = 1; n < MAX_SEND_ATTEMPTS; n++) await dispatchOutbox(h.deps, { limit: 10, conversation });
    expect(await outbox(b.store.businessId)).toEqual([{ status: "failed", attempts: MAX_SEND_ATTEMPTS, last_error: "http_429" }]);
    expect(h.sentTo(a.phone)).toEqual([]);
    expect(h.sentTo(b.phone)).toEqual([]);
  });
});

describe("WhatsApp Cloud API client", () => {
  function client(token: string, respond: (init: RequestInit) => Response | Promise<Response>, timeoutMs = 10_000) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const channel = new WhatsAppCloudChannel({
      token,
      apiVersion: "v26.0",
      timeoutMs,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return respond(init);
      },
    });
    return { channel, calls };
  }
  const hola = { fromPhoneNumberId: "100000000000001", toPhone: "50400000001", body: "Hola" };

  it("posts the documented text-message request and returns the message ID", async () => {
    const { channel, calls } = client("fake-token", () =>
      Response.json({ messaging_product: "whatsapp", contacts: [], messages: [{ id: "wamid.TEST-RESP" }] }),
    );
    expect(await channel.sendText(hola)).toEqual({ ok: true, providerMessageId: "wamid.TEST-RESP" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v26.0/100000000000001/messages");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({ authorization: "Bearer fake-token", "content-type": "application/json" });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+50400000001",
      type: "text",
      text: { preview_url: false, body: "Hola" },
    });
  });

  it("never calls the API without a token, or with a body over 4096 characters", async () => {
    const blank = client("", () => Response.json({}));
    expect(await blank.channel.sendText(hola)).toMatchObject({ ok: false, errorCode: "channel_not_configured" });
    const long = client("fake-token", () => Response.json({}));
    expect(await long.channel.sendText({ ...hola, body: "x".repeat(4097) })).toMatchObject({ ok: false, errorCode: "body_too_long" });
    expect([...blank.calls, ...long.calls]).toEqual([]);
  });

  it("retries rate limits, gives up on other client errors, and never resends a server error or an unknown outcome", async () => {
    const send = (status: number) => client("fake-token", () => new Response("{}", { status })).channel.sendText(hola);
    expect(await send(429)).toEqual({ ok: false, disposition: "retry", errorCode: "http_429" });
    // Meta may have accepted the message before a server error (G1): never resent.
    expect(await send(500)).toEqual({ ok: false, disposition: "unknown", errorCode: "http_500" });
    expect(await send(503)).toEqual({ ok: false, disposition: "unknown", errorCode: "http_503" });
    expect(await send(400)).toEqual({ ok: false, disposition: "permanent", errorCode: "http_400" });
    expect(await send(401)).toEqual({ ok: false, disposition: "permanent", errorCode: "http_401" });
    expect(await send(200)).toEqual({ ok: false, disposition: "unknown", errorCode: "unexpected_response" });

    const dropped = client("fake-token", () => Promise.reject(new TypeError("connection reset")));
    expect(await dropped.channel.sendText(hola)).toEqual({ ok: false, disposition: "unknown", errorCode: "network_error" });

    // A request that hangs is abandoned at the timeout; it may have reached Meta.
    const hanging = client(
      "fake-token",
      (init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      50,
    );
    expect(await hanging.channel.sendText(hola)).toEqual({ ok: false, disposition: "unknown", errorCode: "timeout" });
  });
});
