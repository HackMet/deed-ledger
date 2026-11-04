/**
 * Turns a verified WhatsApp webhook body into channel-neutral events. Shapes follow Meta's
 * webhook references (checked October 28, 2026):
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text
 * .../messages/image, .../messages/audio, .../messages/interactive, .../messages/status
 * Location (#29): `location: { latitude, longitude, name?, address?, url? }`, from a third-party
 * schema of the same webhook (context7, Oct 31), not yet Meta's page or a captured payload (#25).
 *
 * Anything unexpected is skipped, not guessed. Content stays untrusted data.
 */
import type { ChannelEvent, InboundMedia, InboundMessageEvent, StatusEvent } from "../../application/ports";
import { isProviderStatus } from "../../domain/outbox";
import { type Pin, parsePin } from "../../domain/place";
import { normalizePhone } from "../../domain/phone";
import type { MessageKind } from "../../domain/processing";

export interface ParsedWebhook {
  readonly events: ChannelEvent[];
  /** Entries, changes, messages or statuses that weren't usable. */
  readonly skipped: number;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Null when the body isn't a WhatsApp Business Account webhook at all. */
export function parseWebhookPayload(body: unknown): ParsedWebhook | null {
  if (!isRecord(body) || body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return null;

  const events: ChannelEvent[] = [];
  let skipped = 0;
  for (const entry of body.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) {
      skipped++;
      continue;
    }
    for (const change of entry.changes) {
      if (!isRecord(change) || change.field !== "messages" || !isRecord(change.value)) {
        skipped++;
        continue;
      }
      const value = change.value;
      const phoneNumberId = isRecord(value.metadata) ? text(value.metadata.phone_number_id) : null;
      if (phoneNumberId === null) {
        skipped++;
        continue;
      }
      const displayPhoneNumber = isRecord(value.metadata) ? shownNumber(value.metadata.display_phone_number) : null;
      for (const raw of list(value.messages)) {
        const event = parseMessage(phoneNumberId, raw, displayPhoneNumber);
        if (event === null) skipped++;
        else events.push(event);
      }
      for (const raw of list(value.statuses)) {
        const event = parseStatus(phoneNumberId, raw);
        if (event === null) skipped++;
        else events.push(event);
      }
    }
  }
  return { events, skipped };
}

/** Meta's `display_phone_number` ("15550783881" in its reference), digits only; null if not a number. */
function shownNumber(value: unknown): string | null {
  const digits = (text(value) ?? "").replace(/[\s()+.-]/gu, "");
  return /^\d{8,15}$/u.test(digits) ? digits : null;
}

function parseMessage(phoneNumberId: string, raw: unknown, displayPhoneNumber: string | null): InboundMessageEvent | null {
  if (!isRecord(raw)) return null;
  const sender = text(raw.from);
  const senderPhone = sender === null ? null : normalizePhone(sender);
  const providerMessageId = text(raw.id);
  const providerTimestampS = parseTimestamp(raw.timestamp);
  const type = text(raw.type);
  if (senderPhone === null || providerMessageId === null || providerTimestampS === null || type === null) {
    return null;
  }

  let kind: MessageKind = "other";
  let textBody: string | null = null;
  let replyId: string | null = null;
  let media: InboundMedia | null = null;
  let location: Pin | null = null;

  // A photo or voice note without a usable media ID keeps its kind with media null: it is stored
  // without an asset, and its job ends with an honest reply instead of "received".
  if (type === "text" && isRecord(raw.text)) {
    kind = "text";
    textBody = text(raw.text.body);
  } else if (type === "image") {
    kind = "image";
    if (isRecord(raw.image)) {
      textBody = text(raw.image.caption);
      media = parseMedia(raw.image);
    }
  } else if (type === "audio") {
    kind = "audio";
    if (isRecord(raw.audio)) media = parseMedia(raw.audio);
  } else if (type === "location" && isRecord(raw.location)) {
    // Kind stays "other" (the column's CHECK rule); only the coordinates are kept. The pin's name
    // and address are the map's words, not the customer's, and aren't stored.
    location = parsePin(raw.location.latitude, raw.location.longitude);
  } else if (type === "interactive" && isRecord(raw.interactive)) {
    const reply = raw.interactive.button_reply ?? raw.interactive.list_reply;
    if (isRecord(reply)) {
      kind = "interactive";
      replyId = text(reply.id);
      textBody = text(reply.title);
    }
  }

  return {
    type: "message",
    phoneNumberId,
    senderPhone,
    providerMessageId,
    providerTimestampS,
    kind,
    textBody,
    replyId,
    contextMessageId: isRecord(raw.context) ? text(raw.context.id) : null,
    media,
    location,
    displayPhoneNumber,
  };
}

function parseMedia(raw: Json): InboundMedia | null {
  const providerMediaId = text(raw.id);
  if (providerMediaId === null) return null;
  return { providerMediaId, mimeType: text(raw.mime_type), sha256: text(raw.sha256) };
}

function parseStatus(phoneNumberId: string, raw: unknown): StatusEvent | null {
  if (!isRecord(raw)) return null;
  const providerMessageId = text(raw.id);
  const providerTimestampS = parseTimestamp(raw.timestamp);
  if (providerMessageId === null || providerTimestampS === null || !isProviderStatus(raw.status)) return null;
  return { type: "status", phoneNumberId, providerMessageId, status: raw.status, providerTimestampS };
}

/** Meta sends Unix seconds as a string of digits. */
function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^[0-9]{1,12}$/.test(value)) return null;
  return Number.parseInt(value, 10);
}
