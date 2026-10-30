/** Rules for logging in to the console. */

/** An invite opens one session, within this long of being created. */
export const INVITE_TTL_MS = 15 * 60 * 1000;

/** A phone stays logged in this long, unless the person is removed sooner. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "consola";

/** A token is 32 random bytes in base64url: exactly 43 characters. */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
