/** Rules for processing inbound messages. Message (job) states are separate from draft states. */

export type MessageKind = "text" | "image" | "audio" | "interactive" | "other";
export type JobState = "pending" | "processing" | "done" | "failed";

/** How long a consumer's lease on a conversation lasts, by the database's clock. Extended per job. */
export const LEASE_TTL_MS = 60_000;

/** Only messages at least this old are processed, and only when nothing newer is waiting: bursts merge. */
export const SETTLE_MS = 3_000;

/** A job is attempted at most this many times; then it fails with an honest reply. */
export const MAX_JOB_ATTEMPTS = 3;

/** The sweep re-rings conversations whose open jobs are older than this and nobody is leasing. */
export const STRANDED_AFTER_MS = 30_000;

/** When another consumer holds the lease, check back after this many seconds. */
export const BUSY_RECHECK_DELAY_S = 3;

/** After attempt n fails, the job waits n times this long before it may start again. */
export const RETRY_DELAY_PER_ATTEMPT_MS = 5_000;

/** Jobs taken from one conversation per round, oldest first. */
export const JOBS_PER_ROUND = 25;

/** A generous cap on stored messages per member conversation per hour; beyond it they're dropped and logged. */
export const MEMBER_MESSAGES_PER_HOUR = 300;

/** The provider's timestamp orders messages only within this distance of our own receive time. */
const ORDER_PAST_LIMIT_S = 7 * 24 * 60 * 60;
const ORDER_FUTURE_LIMIT_S = 5 * 60;

/** The provider timestamp clamped to [received - 7 days, received + 5 minutes], for ordering only. */
export function orderingTimestampS(providerTimestampS: number, receivedAtMs: number): number {
  const receivedS = Math.floor(receivedAtMs / 1000);
  return Math.min(Math.max(providerTimestampS, receivedS - ORDER_PAST_LIMIT_S), receivedS + ORDER_FUTURE_LIMIT_S);
}

/**
 * Seconds to wait until the conversation has settled: 0 when it has, otherwise at least 1
 * (the Queue's delay is in whole seconds).
 */
export function settleDelaySeconds(nowMs: number, newestReceivedAtMs: number): number {
  return secondsUntil(nowMs, newestReceivedAtMs + SETTLE_MS);
}

/** Whole seconds from now until a time: at least 1 while it is in the future, else 0. */
export function secondsUntil(nowMs: number, atMs: number): number {
  const remainingMs = atMs - nowMs;
  return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 1000);
}

/** A photo or voice note is only something we received if it came with media we can open. */
export function expectsMedia(kind: MessageKind): boolean {
  return kind === "image" || kind === "audio";
}

export function attemptsExhausted(attemptsSoFar: number): boolean {
  return attemptsSoFar >= MAX_JOB_ATTEMPTS;
}

/** When a job whose attempt number `attempt` (1-based) failed may start again. */
export function retryAfterMs(nowMs: number, attempt: number): number {
  return nowMs + RETRY_DELAY_PER_ATTEMPT_MS * attempt;
}
