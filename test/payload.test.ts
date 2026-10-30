import { describe, expect, it } from "vitest";
import { parseWebhookPayload } from "../src/integrations/whatsapp/payload";
import { audioMessage, imageMessage, statusUpdate, textMessage, webhook } from "./helpers/whatsapp";

const PNID = "100000000000001";
const base = { from: "+50400000001", id: "wamid.TEST-1", timestampS: 1_793_196_000 };

describe("WhatsApp webhook payloads", () => {
  it("reads text, image, audio and interactive replies into channel-neutral events", () => {
    const parsed = parseWebhookPayload(
      webhook(PNID, {
        messages: [
          textMessage({ ...base, body: "Hola" }),
          imageMessage({ ...base, id: "wamid.TEST-2", mediaId: "m-1", caption: "Factura" }),
          audioMessage({ ...base, id: "wamid.TEST-3", mediaId: "m-2" }),
          {
            ...base,
            timestamp: String(base.timestampS),
            id: "wamid.TEST-4",
            type: "interactive",
            context: { from: "15550000000", id: "wamid.TEST-CARD" },
            interactive: { type: "button_reply", button_reply: { id: "confirm:rev-2", title: "Confirmar" } },
          },
          {
            ...base,
            timestamp: String(base.timestampS),
            id: "wamid.TEST-5",
            type: "interactive",
            interactive: { type: "list_reply", list_reply: { id: "row-1", title: "Coca 2 litros", description: "x" } },
          },
          { ...base, timestamp: String(base.timestampS), id: "wamid.TEST-6", type: "sticker", sticker: { id: "s" } },
        ],
      }),
    );
    expect(parsed?.skipped).toBe(0);
    expect(parsed?.events).toEqual([
      expect.objectContaining({ kind: "text", textBody: "Hola", senderPhone: "50400000001", phoneNumberId: PNID, media: null }),
      expect.objectContaining({
        kind: "image",
        textBody: "Factura",
        media: { providerMediaId: "m-1", mimeType: "image/jpeg", sha256: "c3ludGhldGljLXNoYTI1Ng==" },
      }),
      expect.objectContaining({ kind: "audio", textBody: null, media: expect.objectContaining({ mimeType: "audio/ogg; codecs=opus" }) }),
      expect.objectContaining({ kind: "interactive", replyId: "confirm:rev-2", textBody: "Confirmar", contextMessageId: "wamid.TEST-CARD" }),
      expect.objectContaining({ kind: "interactive", replyId: "row-1", textBody: "Coca 2 litros" }),
      expect.objectContaining({ kind: "other", textBody: null, media: null }),
    ]);
  });

  it("reads delivery statuses and skips unknown ones", () => {
    const parsed = parseWebhookPayload(
      webhook(PNID, {
        statuses: [
          statusUpdate({ id: "wamid.TEST-OUT", status: "delivered", timestampS: 1 }),
          statusUpdate({ id: "wamid.TEST-OUT", status: "deleted", timestampS: 2 }),
        ],
      }),
    );
    expect(parsed?.events).toEqual([
      { type: "status", phoneNumberId: PNID, providerMessageId: "wamid.TEST-OUT", status: "delivered", providerTimestampS: 1 },
    ]);
    expect(parsed?.skipped).toBe(1);
  });

  it("skips what it can't trust instead of guessing", () => {
    const broken = [
      { ...textMessage({ ...base, body: "x" }), from: "not-a-phone" },
      { ...textMessage({ ...base, body: "x" }), id: "" },
      { ...textMessage({ ...base, body: "x" }), timestamp: "1.5" },
      { ...textMessage({ ...base, body: "x" }), timestamp: 1_793_196_000 },
      "not an object",
    ];
    const parsed = parseWebhookPayload(webhook(PNID, { messages: broken }));
    expect(parsed).toEqual({ events: [], skipped: broken.length });
  });

  it("keeps a photo or voice note without a usable media ID as what it is, with no media (G7)", () => {
    const parsed = parseWebhookPayload(
      webhook(PNID, {
        messages: [
          { ...base, timestamp: String(base.timestampS), id: "wamid.TEST-7", type: "image", image: { mime_type: "image/jpeg" } },
          { ...base, timestamp: String(base.timestampS), id: "wamid.TEST-8", type: "audio", audio: { id: "" } },
          { ...base, timestamp: String(base.timestampS), id: "wamid.TEST-9", type: "image" },
        ],
      }),
    );
    expect(parsed?.events.map((event) => (event.type === "message" ? [event.kind, event.media] : null))).toEqual([
      ["image", null],
      ["audio", null],
      ["image", null],
    ]);
  });

  it("rejects bodies that aren't WhatsApp Business Account webhooks, and skips other fields", () => {
    expect(parseWebhookPayload({ object: "page", entry: [] })).toBeNull();
    expect(parseWebhookPayload([])).toBeNull();
    expect(parseWebhookPayload(null)).toBeNull();
    const other = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "account_update", value: {} }] }] };
    expect(parseWebhookPayload(other)).toEqual({ events: [], skipped: 1 });
    const noMetadata = webhook(PNID, { messages: [textMessage({ ...base, body: "x" })] });
    delete (noMetadata.entry[0]!.changes[0]!.value as { metadata?: unknown }).metadata;
    expect(parseWebhookPayload(noMetadata)).toEqual({ events: [], skipped: 1 });
  });
});
