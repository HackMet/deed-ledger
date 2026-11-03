/** The pilot store's clock: Honduras is UTC-6 all year (no daylight saving). */
const STORE_UTC_OFFSET_MS = -6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A moment as the store reads it: "8:05 a. m." today, "ayer 8:05 p. m.", or "28/10 8:05 a. m."
 * for anything older.
 */
export function formatStoreTime(atMs: number, nowMs: number): string {
  const local = new Date(atMs + STORE_UTC_OFFSET_MS);
  const hours = local.getUTCHours();
  const clock = `${hours % 12 === 0 ? 12 : hours % 12}:${String(local.getUTCMinutes()).padStart(2, "0")} ${hours < 12 ? "a. m." : "p. m."}`;
  const days = Math.floor((nowMs + STORE_UTC_OFFSET_MS) / DAY_MS) - Math.floor((atMs + STORE_UTC_OFFSET_MS) / DAY_MS);
  if (days <= 0) return clock;
  if (days === 1) return `ayer ${clock}`;
  return `${local.getUTCDate()}/${local.getUTCMonth() + 1} ${clock}`;
}
