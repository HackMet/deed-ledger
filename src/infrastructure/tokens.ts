/** Random tokens, their stored hashes, and the CSRF value for a session. Web Crypto only. */

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** 32 random bytes in base64url (43 characters). */
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** What the database keeps instead of the token. */
export async function hashToken(token: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

/** The form value that proves a request came from the session's own page. A blank secret fails. */
export async function csrfToken(secret: string, sessionId: string): Promise<string> {
  if (secret === "") throw new Error("LINK_SIGNING_SECRET is not set");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`csrf:${sessionId}`)));
}

/** Compares two tokens in time that doesn't depend on where they differ. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
