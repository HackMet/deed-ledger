/**
 * Sends text messages through the WhatsApp Cloud API. Request shape from Meta's docs (October 28,
 * 2026): https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages
 *
 * Never called by the default test run: tests use a fake MessagingChannel.
 */
import type { MessagingChannel, OutgoingText, SendResult } from "../../application/ports";
import { WHATSAPP_LIMITS } from "./limits";

export interface WhatsAppCloudOptions {
  readonly token: string;
  readonly apiVersion: string;
  /** The request is abandoned after this; its outcome is then unknown. */
  readonly timeoutMs: number;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
}

export class WhatsAppCloudChannel implements MessagingChannel {
  readonly maxTextChars = WHATSAPP_LIMITS.textBodyChars;

  constructor(private readonly options: WhatsAppCloudOptions) {}

  get configured(): boolean {
    return this.options.token !== "";
  }

  async sendText(message: OutgoingText): Promise<SendResult> {
    if (!this.configured) return { ok: false, disposition: "permanent", errorCode: "channel_not_configured" };
    if (message.body.length > this.maxTextChars) {
      return { ok: false, disposition: "permanent", errorCode: "body_too_long" };
    }
    const url = `https://graph.facebook.com/${this.options.apiVersion}/${encodeURIComponent(message.fromPhoneNumberId)}/messages`;

    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: `+${message.toPhone}`,
          type: "text",
          text: { preview_url: false, body: message.body },
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      // A timeout or a dropped connection: the request may have reached Meta. Never resend.
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return { ok: false, disposition: "unknown", errorCode: timedOut ? "timeout" : "network_error" };
    }

    if (!response.ok) {
      const errorCode = `http_${response.status}`;
      // A rate limit means not sent. A server error may come after Meta accepted the message
      // (unknown whether it can), so it is never resent: at most once wins.
      if (response.status === 429) return { ok: false, disposition: "retry", errorCode };
      if (response.status >= 500) return { ok: false, disposition: "unknown", errorCode };
      return { ok: false, disposition: "permanent", errorCode };
    }
    const body: unknown = await response.json().catch(() => null);
    const id = readMessageId(body);
    // Accepted, but without a readable ID: it was probably sent, so it must not be sent again.
    return id === null
      ? { ok: false, disposition: "unknown", errorCode: "unexpected_response" }
      : { ok: true, providerMessageId: id };
  }
}

function readMessageId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  const first: unknown = messages[0];
  if (typeof first !== "object" || first === null) return null;
  const id = (first as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
}
