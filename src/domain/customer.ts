/** Rules for customer records. Pure: no I/O. */

export const CUSTOMER_NAME_MAX_CHARS = 120;

/**
 * A name as the customer gave it, tidied for saving: spaces collapsed, cut to the column's limit.
 * Null when nothing is left. Content is untrusted and never logged.
 */
export function normalizeCustomerName(raw: string): string | null {
  const name = raw.replace(/\s+/gu, " ").trim();
  if (name === "") return null;
  // Cut by code points, so a name never ends in half a character.
  return [...name].slice(0, CUSTOMER_NAME_MAX_CHARS).join("").trim();
}
