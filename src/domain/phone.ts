/**
 * A WhatsApp phone number as digits only (E.164 without "+"), or null when it isn't one.
 * Meta's webhooks send `from` with or without a leading "+".
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.startsWith("+") ? raw.slice(1) : raw;
  return /^[0-9]{6,15}$/.test(digits) ? digits : null;
}
