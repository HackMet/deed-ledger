/**
 * Store hours as customers hear them (#47, contract gap f, proposed). The hours come from store
 * settings through the engine; nothing here supplies a default. A schedule that doesn't parse is
 * treated as unset, so the customer hears "te confirmo" instead of a wrong time.
 */
import type { StoreHours, StoreHoursEntry } from "./contract/outcomes";

const DAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"] as const;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(time: string): number | null {
  const match = CLOCK.exec(time);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

function validEntry(entry: StoreHoursEntry): boolean {
  if (entry.days.length === 0) return false;
  if (!entry.days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) return false;
  if (new Set(entry.days).size !== entry.days.length) return false;
  const opens = minutesOf(entry.opens);
  const closes = minutesOf(entry.closes);
  // Hours past midnight aren't expressible yet; such a schedule reads as unset.
  return opens !== null && closes !== null && opens < closes;
}

/** A schedule we can say out loud: at least one entry, each valid, no day in two entries. */
export function isUsableStoreHours(hours: StoreHours | null): hours is StoreHours {
  if (hours === null || hours.length === 0) return false;
  if (!hours.every(validEntry)) return false;
  const days = hours.flatMap((entry) => entry.days);
  return new Set(days).size === days.length;
}

/** "7 a. m.", "7:30 p. m.", "12 del mediodía". */
export function formatClock(time: string): string {
  const minutes = minutesOf(time);
  if (minutes === null) throw new Error("not a clock time");
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  if (hour === 12 && minute === 0) return "12 del mediodía";
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? "a. m." : "p. m.";
  return minute === 0 ? `${shown} ${suffix}` : `${shown}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** "de lunes a sábado", "el domingo", "lunes y miércoles", "de lunes a miércoles y el viernes". */
export function formatDays(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const day of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && last.at(-1) === day - 1) last.push(day);
    else runs.push([day]);
  }
  const name = (day: number) => DAY_NAMES[day - 1]!;
  if (runs.length === 1 && runs[0]!.length === 1) return `el ${name(runs[0]![0]!)}`;
  const parts = runs.flatMap((run) =>
    run.length >= 3 ? [`de ${name(run[0]!)} a ${name(run.at(-1)!)}`] : run.map(name),
  );
  return joinSpanish(parts);
}

/** "Abrimos de lunes a sábado de 7 a. m. a 7 p. m., y el domingo de 8 a. m. a 12 del mediodía." */
export function formatStoreHours(hours: StoreHours): string {
  const entries = [...hours]
    .sort((a, b) => Math.min(...a.days) - Math.min(...b.days))
    .map((entry) => `${formatDays(entry.days)} de ${formatClock(entry.opens)} a ${formatClock(entry.closes)}`);
  const body = entries.length === 1 ? entries[0]! : `${entries.slice(0, -1).join(", ")}, y ${entries.at(-1)!}`;
  // "p. m." already ends in a period.
  return body.endsWith(".") ? `Abrimos ${body}` : `Abrimos ${body}.`;
}

/** A stable key for comparing two schedules exactly (the claim check). */
export function storeHoursKey(hours: StoreHours): string {
  return JSON.stringify(hours.map((entry) => [entry.days, entry.opens, entry.closes]));
}

function joinSpanish(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)!}`;
}
