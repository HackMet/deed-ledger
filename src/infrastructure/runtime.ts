import type { Clock, IdSource, LogFields, Logger } from "../application/ports";

export const systemClock: Clock = { now: () => Date.now() };

export const randomIds: IdSource = { newId: () => crypto.randomUUID() };

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One JSON line per event. The field names are fixed by LogFields: IDs and codes only. */
export const consoleLogger: Logger = {
  info: (event: string, fields?: LogFields) => console.log(JSON.stringify({ level: "info", event, ...fields })),
  warn: (event: string, fields?: LogFields) => console.warn(JSON.stringify({ level: "warn", event, ...fields })),
  error: (event: string, fields?: LogFields) => console.error(JSON.stringify({ level: "error", event, ...fields })),
};
