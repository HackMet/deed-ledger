/**
 * Sends text messages through the WhatsApp Cloud API. Request shape from Meta's docs (October 28,
 * 2026): https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages
 *
 * Reply buttons, checked against Meta's docs on October 30, 2026:
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages
 * type "interactive", interactive.type "button", body.text up to 1024 characters, action.buttons of
 * up to 3 `{ type: "reply", reply: { id, title } }`, IDs up to 256 characters, titles up to 20 and
 * unique, and an optional `footer: { text }` of up to 60 characters (limits.ts, checked October 28).
 * A tap comes back as an interactive message with `button_reply.id`.
 *
 * Read receipt with typing indicator, checked against Meta's docs on November 3, 2026:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
 * The same messages endpoint with `status: "read"`, the inbound `message_id` and
 * `typing_indicator: { type: "text" }`; the answer is `{ success: true }`. It marks the message (and
 * earlier ones) read and shows "typing…" until the reply, or 25 seconds. Meta asks to show it only
 * when a reply follows.
 *
 * Never called by the default test run: tests use a fake MessagingChannel.
 */
import type {
  MessagingChannel,
  OutgoingButtons,
  OutgoingText,
  SendResult,
  TypingIndicator,
  TypingResult,
} from "../../application/ports";
import { plainTextBody, type ReplyButton } from "../../domain/replies";
import { WHATSAPP_LIMITS } from "./limits";

/** The indicator is awaited before the work starts, so a slow one gives up instead of holding it. */
const TYPING_TIMEOUT_MS = 3_000;

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
    return this.post(message, { type: "text", text: { preview_url: false, body: message.body } });
  }

  /**
   * Buttons (or a footer) that break Meta's limits are dropped: the body goes as plain text, with
   * its typed fallback under it.
   */
  async sendButtons(message: OutgoingButtons): Promise<SendResult> {
    if (!fitsReplyButtons(message.body, message.buttons, message.footer)) {
      return this.sendText({ fromPhoneNumberId: message.fromPhoneNumberId, toPhone: message.toPhone, body: plainTextBody(message.body, message.textFallback) });
    }
    return this.post(message, {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: message.body },
        ...(message.footer === undefined ? {} : { footer: { text: message.footer } }),
        action: { buttons: message.buttons.map(({ id, title }) => ({ type: "reply", reply: { id, title } })) },
      },
    });
  }

  async showTyping(indicator: TypingIndicator): Promise<TypingResult> {
    if (!this.configured) return { ok: false, errorCode: "channel_not_configured" };
    let response: Response;
    try {
      response = await this.request(
        indicator.fromPhoneNumberId,
        {
          messaging_product: "whatsapp",
          status: "read",
          message_id: indicator.providerMessageId,
          typing_indicator: { type: "text" },
        },
        Math.min(this.options.timeoutMs, TYPING_TIMEOUT_MS),
      );
    } catch (error) {
      return { ok: false, errorCode: networkErrorCode(error) };
    }
    if (!response.ok) return { ok: false, errorCode: `http_${response.status}` };
    const body: unknown = await response.json().catch(() => null);
    const success = typeof body === "object" && body !== null && (body as { success?: unknown }).success === true;
    return success ? { ok: true } : { ok: false, errorCode: "unexpected_response" };
  }

  private async post(message: OutgoingText, content: Record<string, unknown>): Promise<SendResult> {
    if (!this.configured) return { ok: false, disposition: "permanent", errorCode: "channel_not_configured" };

    let response: Response;
    try {
      response = await this.request(
        message.fromPhoneNumberId,
        { messaging_product: "whatsapp", recipient_type: "individual", to: `+${message.toPhone}`, ...content },
        this.options.timeoutMs,
      );
    } catch (error) {
      // A timeout or a dropped connection: the request may have reached Meta. Never resend.
      return { ok: false, disposition: "unknown", errorCode: networkErrorCode(error) };
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

  /** POSTs to the messages endpoint of the store's number. Throws on a timeout or a dropped connection. */
  private request(fromPhoneNumberId: string, body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    const url = `https://graph.facebook.com/${this.options.apiVersion}/${encodeURIComponent(fromPhoneNumberId)}/messages`;
    return this.options.fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}

function networkErrorCode(error: unknown): "timeout" | "network_error" {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return timedOut ? "timeout" : "network_error";
}

/** Whether Meta accepts these as reply buttons with this body, and this footer when there is one. */
export function fitsReplyButtons(body: string, buttons: readonly ReplyButton[], footer?: string): boolean {
  const limits = WHATSAPP_LIMITS.replyButtons;
  const titles = new Set(buttons.map((b) => b.title));
  return (
    (footer === undefined || fitsFooter(footer)) &&
    buttons.length >= 1 &&
    buttons.length <= limits.maxButtons &&
    titles.size === buttons.length &&
    body.trim() !== "" &&
    body.length <= limits.bodyChars &&
    buttons.every(
      (b) =>
        b.id !== "" && b.id.length <= limits.buttonIdChars && b.title.trim() !== "" && b.title.length <= limits.buttonTitleChars,
    )
  );
}

/** A footer is one line of plain text: no line breaks or control characters, at most 60 characters. */
export function fitsFooter(footer: string): boolean {
  return footer.trim() !== "" && footer.length <= WHATSAPP_LIMITS.replyButtons.footerChars && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(footer);
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
