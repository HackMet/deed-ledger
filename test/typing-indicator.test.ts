import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { placeholderHandler } from "../src/application/placeholder-handler";
import type { JobHandler, TypingResult } from "../src/application/ports";
import { RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { WhatsAppCloudChannel } from "../src/integrations/whatsapp/client";
import { bytes, FakeMediaSource } from "./helpers/fakes";
import { conversationOf, type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedCustomer, seedStore } from "./helpers/seed";
import { imageMessage, textMessage, wamid, webhook } from "./helpers/whatsapp";

const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

/** A customer's text burst, settled and processed: returns the store, the phone and the message IDs. */
async function textBurst(h: Harness, bodies: readonly string[]) {
  const store = await seedStore({ members: [] });
  const phone = newPhone();
  const ids = bodies.map(() => wamid());
  const t = nowS(h);
  const messages = bodies.map((body, n) => textMessage({ from: phone, id: ids[n]!, timestampS: t + n, body }));
  expect((await h.post(webhook(store.phoneNumberId, { messages }))).status).toBe(200);
  h.clock.advance(4_000);
  await h.deliver();
  return { store, phone, ids };
}

async function jobStates(businessId: string): Promise<Array<[string, number]>> {
  const jobs = await rows<{ job_state: string; attempts: number }>(
    `SELECT job_state, attempts FROM inbound_messages WHERE business_id = ?`,
    businessId,
  );
  return jobs.map((job) => [job.job_state, job.attempts]);
}

describe("the typing indicator while a burst is worked on", () => {
  it("marks the burst's newest message read and shows typing once, on the store's number, before the download and the handler", async () => {
    const seen: string[] = [];
    const mediaSource = new FakeMediaSource();
    const handler: JobHandler = {
      async handle(input) {
        seen.push(`handler:${h.channel.typing.length}`);
        return placeholderHandler.handle(input);
      },
    };
    const h = harness({ jobHandler: handler, mediaSource });
    mediaSource.respond = async (id) => {
      seen.push(`download:${h.channel.typing.length}`);
      return bytes(`synthetic ${id}`);
    };
    const store = await seedStore({ members: [] });
    const phone = newPhone();
    const [photo, first, newest] = [wamid(), wamid(), wamid()];
    const t = nowS(h);
    // A photo of a list and two texts; the newest by provider time arrives second.
    const messages = [
      imageMessage({ from: phone, id: photo, timestampS: t, mediaId: "m-list" }),
      textMessage({ from: phone, id: newest, timestampS: t + 2, body: "y 2 libras de arroz" }),
      textMessage({ from: phone, id: first, timestampS: t + 1, body: "lo de la foto" }),
    ];
    await h.post(webhook(store.phoneNumberId, { messages }));
    h.clock.advance(4_000);
    await h.deliver();

    expect(h.channel.typing).toEqual([{ fromPhoneNumberId: store.phoneNumberId, providerMessageId: newest }]);
    expect(seen).toEqual(["download:1", "handler:1", "handler:1", "handler:1"]);
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
  });

  it("shows it again for the next burst, for that burst's message", async () => {
    const h = harness({ jobHandler: placeholderHandler });
    const { store, phone, ids } = await textBurst(h, ["una coca"]);
    const later = wamid();
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: later, timestampS: nowS(h), body: "y un pan" })] }));
    h.clock.advance(4_000);
    await h.deliver();
    expect(h.channel.typing.map((t) => t.providerMessageId)).toEqual([ids[0], later]);
  });

  const failures: ReadonlyArray<[string, () => Promise<TypingResult>, string]> = [
    ["refused", async () => ({ ok: false, errorCode: "http_400" }), "http_400"],
    [
      "throwing",
      async () => {
        throw new Error("socket closed while sending to 50400000000");
      },
      "Error",
    ],
  ];
  for (const [label, respond, reason] of failures) {
    it(`a ${label} indicator doesn't fail the job or change its replies, and logs IDs only`, async () => {
      const h = harness({ jobHandler: placeholderHandler });
      h.channel.respondTyping = respond;
      const { store, phone, ids } = await textBurst(h, ["una coca", "y un pan"]);

      expect(h.channel.typing).toHaveLength(1);
      expect(await jobStates(store.businessId)).toEqual([
        ["done", 1],
        ["done", 1],
      ]);
      expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
      expect(h.log.fields("typing_indicator_failed")).toEqual([
        expect.objectContaining({ businessId: store.businessId, inboundId: expect.any(String), reason }),
      ]);
      const logs = h.log.lines.join("\n");
      for (const secret of [phone, "50400000000", ...ids]) expect(logs).not.toContain(secret);
    });
  }

  it("shows nothing to a customer who typed ALTO (no automated answer follows)", async () => {
    const h = harness();
    const store = await seedStore({ members: [] });
    const phone = newPhone();
    const customerId = await seedCustomer(store, phone);
    await env.DB.prepare(`UPDATE customers SET introduced_at_ms = 1, stopped_at_ms = 1 WHERE id = ?1`).bind(customerId).run();
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "hola" })] }));
    h.clock.advance(4_000);
    await h.deliver();
    expect(h.channel.typing).toEqual([]);
    expect(await jobStates(store.businessId)).toEqual([["done", 1]]);
  });

  it("shows nothing when the channel isn't configured", async () => {
    const h = harness({ jobHandler: placeholderHandler });
    h.channel.configured = false;
    const { store } = await textBurst(h, ["una coca"]);
    expect(h.channel.typing).toEqual([]);
    expect(await jobStates(store.businessId)).toEqual([["done", 1]]);
  });

  it("reads the target only for an open job of that store's conversation", async () => {
    const h = harness({ jobHandler: placeholderHandler });
    h.channel.configured = false;
    const store = await seedStore({ members: [] });
    const other = await seedStore({ members: [] });
    const id = wamid();
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: newPhone(), id, timestampS: nowS(h), body: "una coca" })] }));
    const conversation = await conversationOf(store.businessId);
    const [job] = await rows<{ id: string }>(`SELECT id FROM inbound_messages WHERE business_id = ?`, store.businessId);

    expect(await h.deps.jobs.typingTarget(conversation, job!.id)).toEqual({ fromPhoneNumberId: store.phoneNumberId, providerMessageId: id });
    expect(await h.deps.jobs.typingTarget({ ...conversation, businessId: other.businessId }, job!.id)).toBeNull();
    h.clock.advance(4_000);
    await h.deliver();
    // Done: nothing left to show typing for.
    expect(await h.deps.jobs.typingTarget(conversation, job!.id)).toBeNull();
  });
});

describe("the WhatsApp client's typing indicator", () => {
  const indicator = { fromPhoneNumberId: "100", providerMessageId: "wamid.TEST-IN-1" };

  function client(respond: () => Promise<Response>, token = "fake-token") {
    const requests: Array<{ url: string; method: string | undefined; headers: unknown; body: unknown }> = [];
    const whatsapp = new WhatsAppCloudChannel({
      token,
      apiVersion: "v26.0",
      timeoutMs: 10_000,
      fetch: async (url, init) => {
        requests.push({ url, method: init.method, headers: init.headers, body: JSON.parse(String(init.body)) });
        return respond();
      },
    });
    return { whatsapp, requests };
  }

  it("sends Meta's read receipt with a text typing indicator, from the store's number", async () => {
    const { whatsapp, requests } = client(async () => Response.json({ success: true }));
    expect(await whatsapp.showTyping(indicator)).toEqual({ ok: true });
    expect(requests).toEqual([
      {
        url: "https://graph.facebook.com/v26.0/100/messages",
        method: "POST",
        headers: { authorization: "Bearer fake-token", "content-type": "application/json" },
        body: {
          messaging_product: "whatsapp",
          status: "read",
          message_id: "wamid.TEST-IN-1",
          typing_indicator: { type: "text" },
        },
      },
    ]);
  });

  it("reports a refusal, an unreadable answer and a dropped connection as failures", async () => {
    const refused = client(async () => Response.json({ error: { code: 100 } }, { status: 400 }));
    expect(await refused.whatsapp.showTyping(indicator)).toEqual({ ok: false, errorCode: "http_400" });
    const unreadable = client(async () => Response.json({}));
    expect(await unreadable.whatsapp.showTyping(indicator)).toEqual({ ok: false, errorCode: "unexpected_response" });
    const dropped = client(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await dropped.whatsapp.showTyping(indicator)).toEqual({ ok: false, errorCode: "network_error" });
  });

  it("sends nothing without a token", async () => {
    const { whatsapp, requests } = client(async () => Response.json({ success: true }), "");
    expect(await whatsapp.showTyping(indicator)).toEqual({ ok: false, errorCode: "channel_not_configured" });
    expect(requests).toEqual([]);
  });
});
