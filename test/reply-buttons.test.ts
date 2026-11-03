import { describe, expect, it } from "vitest";
import type { OutgoingButtons } from "../src/application/ports";
import { renderOutcome } from "../src/domain/replies";
import { parseWebhookPayload } from "../src/integrations/whatsapp/payload";
import { fitsReplyButtons, WhatsAppCloudChannel } from "../src/integrations/whatsapp/client";
import { readback } from "./fixtures/contract";
import { newPhoneNumberId } from "./helpers/seed";
import { wamid, webhook } from "./helpers/whatsapp";

function channel() {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const whatsapp = new WhatsAppCloudChannel({
    token: "fake-token",
    apiVersion: "v26.0",
    timeoutMs: 10_000,
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Response.json({ messages: [{ id: "wamid.TEST-OUT" }] });
    },
  });
  return { whatsapp, requests };
}

const rendered = renderOutcome(readback, { customerId: "c" })!;
const message: OutgoingButtons = { fromPhoneNumberId: "100", toPhone: "50400000000", body: rendered.body, buttons: rendered.buttons };

describe("the WhatsApp client's reply buttons", () => {
  it("sends Meta's interactive reply-button shape", async () => {
    const { whatsapp, requests } = channel();
    expect(await whatsapp.sendButtons(message)).toEqual({ ok: true, providerMessageId: "wamid.TEST-OUT" });
    expect(requests).toEqual([
      {
        url: "https://graph.facebook.com/v26.0/100/messages",
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: "+50400000000",
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: rendered.body },
            action: {
              buttons: [
                { type: "reply", reply: { id: "confirm:order-0001:v1", title: "Confirmar" } },
                { type: "reply", reply: { id: "correct:order-0001:v1", title: "Corregir" } },
                { type: "reply", reply: { id: "cancel:order-0001:v1", title: "Cancelar" } },
              ],
            },
          },
        },
      },
    ]);
  });

  it("falls back to plain text, typed choices included, when the buttons don't fit Meta's limits", async () => {
    const cases: OutgoingButtons[] = [
      { ...message, buttons: [...message.buttons, { id: "x", title: "Otro" }] },
      { ...message, buttons: [{ id: "a", title: "Un título de más de veinte" }] },
      { ...message, buttons: [{ id: "a", title: "Sí" }, { id: "b", title: "Sí" }] },
      { ...message, buttons: [{ id: "a".repeat(257), title: "Sí" }] },
      { ...message, body: "x".repeat(1025) },
      { ...message, buttons: [] },
    ];
    for (const outgoing of cases) {
      const { whatsapp, requests } = channel();
      expect((await whatsapp.sendButtons(outgoing)).ok).toBe(true);
      expect(requests[0]!.body.type).toBe("text");
      expect(requests[0]!.body.text).toEqual({ preview_url: false, body: outgoing.body });
    }
    expect(fitsReplyButtons(message.body, message.buttons)).toBe(true);
  });

  it("sends nothing without credentials", async () => {
    const whatsapp = new WhatsAppCloudChannel({
      token: "",
      apiVersion: "v26.0",
      timeoutMs: 10_000,
      fetch: async () => {
        throw new Error("must not be called");
      },
    });
    expect(await whatsapp.sendButtons(message)).toEqual({ ok: false, disposition: "permanent", errorCode: "channel_not_configured" });
  });

  it("reads a tap back as the button's ID", () => {
    const phoneNumberId = newPhoneNumberId();
    const tap = {
      from: "50400000000",
      id: wamid(),
      timestamp: "1793000000",
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "confirm:order-0001:v1", title: "Confirmar" } },
    };
    const { events } = parseWebhookPayload(webhook(phoneNumberId, { messages: [tap] }))!;
    expect(events).toEqual([expect.objectContaining({ kind: "interactive", replyId: "confirm:order-0001:v1", textBody: "Confirmar" })]);
  });
});
