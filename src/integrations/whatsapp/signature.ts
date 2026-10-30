/**
 * Webhook authenticity checks.
 *
 * Meta signs every webhook POST with `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the
 * raw body keyed with the app secret:
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
 * The comparison uses Workers' constant-time crypto.subtle.timingSafeEqual:
 * https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/
 */

const encoder = new TextEncoder();
const SIGNATURE_HEADER = /^sha256=([0-9a-fA-F]{64})$/;

/** True only when the header carries a valid HMAC of exactly these bytes. A blank secret never passes. */
export async function verifyWebhookSignature(
  appSecret: string,
  rawBody: ArrayBuffer,
  header: string | undefined | null,
): Promise<boolean> {
  if (appSecret === "" || header === undefined || header === null) return false;
  const match = SIGNATURE_HEADER.exec(header.trim());
  if (match?.[1] === undefined) return false;

  const key = await crypto.subtle.importKey("raw", encoder.encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const provided = hexToBytes(match[1]);
  // Both are 32 bytes here (the regex fixes the length), as timingSafeEqual requires.
  return crypto.subtle.timingSafeEqual(expected, provided);
}

/**
 * Constant-time comparison for the GET verify token. Both sides are hashed first, so the compared
 * values always have the same length and nothing branches on the input's length. A blank expected
 * value never matches.
 */
export async function verifyTokenMatches(expected: string, provided: string | undefined): Promise<boolean> {
  if (expected === "" || provided === undefined) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
