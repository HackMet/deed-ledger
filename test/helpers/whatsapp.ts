/**
 * Synthetic, Meta-shaped webhook payloads (shapes from Meta's webhook references). All numbers and
 * IDs here are invented.
 */

export interface MessageSpec {
  readonly from: string;
  readonly id: string;
  readonly timestampS: number;
}

export function textMessage(spec: MessageSpec & { readonly body: string }) {
  return {
    from: spec.from,
    id: spec.id,
    timestamp: String(spec.timestampS),
    type: "text",
    text: { body: spec.body },
  };
}

export function imageMessage(spec: MessageSpec & { readonly mediaId: string; readonly caption?: string }) {
  return {
    from: spec.from,
    id: spec.id,
    timestamp: String(spec.timestampS),
    type: "image",
    image: {
      ...(spec.caption === undefined ? {} : { caption: spec.caption }),
      mime_type: "image/jpeg",
      sha256: "c3ludGhldGljLXNoYTI1Ng==",
      id: spec.mediaId,
    },
  };
}

export function audioMessage(spec: MessageSpec & { readonly mediaId: string }) {
  return {
    from: spec.from,
    id: spec.id,
    timestamp: String(spec.timestampS),
    type: "audio",
    audio: { mime_type: "audio/ogg; codecs=opus", sha256: "c3ludGhldGlj", id: spec.mediaId, voice: true },
  };
}

/** A tap on a reply button (Meta's interactive button_reply). */
export function buttonReply(spec: MessageSpec & { readonly replyId: string; readonly title: string }) {
  return {
    from: spec.from,
    id: spec.id,
    timestamp: String(spec.timestampS),
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: spec.replyId, title: spec.title } },
  };
}

export function statusUpdate(spec: { readonly id: string; readonly status: string; readonly timestampS: number }) {
  return { id: spec.id, status: spec.status, timestamp: String(spec.timestampS), recipient_id: "50400000999" };
}

export function webhook(
  phoneNumberId: string,
  content: { readonly messages?: readonly unknown[]; readonly statuses?: readonly unknown[] },
) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "900000000000001",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
              ...(content.messages === undefined
                ? {}
                : { contacts: [{ profile: { name: "Cliente de prueba" }, wa_id: "50400000000" }], messages: content.messages }),
              ...(content.statuses === undefined ? {} : { statuses: content.statuses }),
            },
          },
        ],
      },
    ],
  };
}

const encoder = new TextEncoder();

export async function signBody(secret: string, rawBody: string): Promise<string> {
  // workerd refuses a zero-length HMAC key. HMAC pads short keys with zeros to the 64-byte block
  // (RFC 2104), so 64 zero bytes produce exactly the signature an empty secret would.
  const keyBytes = secret === "" ? new Uint8Array(64) : encoder.encode(secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let counter = 0;
/** A fresh synthetic provider message ID. */
export function wamid(label = "IN"): string {
  return `wamid.TEST-${label}-${Date.now().toString(36)}-${++counter}`;
}

/**
 * A shared WhatsApp location, as the Cloud API webhook sends it (`type: "location"`). Synthetic:
 * the shape follows a third-party schema of Meta's webhook; #25 replaces it with a captured payload.
 */
export function locationMessage(
  spec: MessageSpec & { readonly latitude: unknown; readonly longitude: unknown; readonly name?: string; readonly address?: string },
) {
  return {
    from: spec.from,
    id: spec.id,
    timestamp: String(spec.timestampS),
    type: "location",
    location: {
      latitude: spec.latitude,
      longitude: spec.longitude,
      ...(spec.name === undefined ? {} : { name: spec.name }),
      ...(spec.address === undefined ? {} : { address: spec.address }),
    },
  };
}
