/** Rules for the outbox: WhatsApp's 24-hour window, delivery statuses, attempts and expiry. */

/** WhatsApp lets a business reply freely for 24 hours after the person's last message. */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A placeholder acknowledgement is useless after this; it expires instead of being sent late. */
export const PLACEHOLDER_TTL_MS = 60 * 60 * 1000;

/** A failure reply ("No pude …") is just as stale after an hour. */
export const FAILURE_REPLY_TTL_MS = 60 * 60 * 1000;

/** The unknown-sender notice is only ever sent from the request that holds the phone number. */
export const UNKNOWN_NOTICE_TTL_MS = 60 * 60 * 1000;

/**
 * A dispatcher's claim on an outbox row lasts this long, by the database's clock. It is confirmed
 * and extended right before the send. A confirmation slower than CLAIM_CONFIRM_MAX_MS isn't sent on,
 * so the claim outlasts the send's timeout with time left to store the result.
 */
export const SEND_CLAIM_MS = 30_000;

/** A send request is abandoned after this, well under the claim; its outcome is then unknown. */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * The longest a claim's confirmation may take, measured by the Worker from before the call to after
 * it. A slower one may have come back after much of the extended claim ran out, so the row isn't sent
 * then. SEND_CLAIM_MS - CLAIM_CONFIRM_MAX_MS - SEND_TIMEOUT_MS is what is left to store the result.
 */
export const CLAIM_CONFIRM_MAX_MS = 5_000;

export const MAX_SEND_ATTEMPTS = 5;

/** The outbox stores at most this many characters per message (the table's CHECK agrees). */
export const OUTBOX_BODY_MAX_CHARS = 4096;

/** The fixed notice to a number that isn't a member: at most one successful send per 24 hours. */
export const UNKNOWN_SENDER_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The notice's phone number lives only in the request, so the send is retried there, after these waits. */
export const UNKNOWN_NOTICE_INLINE_RETRY_DELAYS_MS: readonly number[] = [0, 250, 1_000];

/** A notice left pending by a request that died can't be sent later (no phone is stored). */
export const UNKNOWN_NOTICE_ABANDON_AFTER_MS = 15 * 60 * 1000;

/** At most this many stored messages per unknown sender, per store, per day; the rest are dropped. */
export const UNKNOWN_SENDER_MESSAGES_PER_DAY = 20;

/** Records about numbers that aren't members are deleted after this. */
export const UNKNOWN_SENDER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A delivery status that arrives before its send result is stored is kept this long. */
export const EARLY_STATUS_TTL_MS = 60 * 60 * 1000;

export type OutboxStatus =
  | "pending"
  | "sending"
  | "sent"
  | "waiting_window"
  | "failed"
  | "unknown_delivery"
  | "expired";

/** Whether a message may be sent now, given our receive time of the person's last message. */
export function isWindowOpen(nowMs: number, lastInboundAtMs: number | null): boolean {
  if (lastInboundAtMs === null) return false;
  return nowMs - lastInboundAtMs < CUSTOMER_SERVICE_WINDOW_MS;
}

export function isExpired(nowMs: number, expiresAtMs: number): boolean {
  return expiresAtMs <= nowMs;
}

export type ProviderStatus = "sent" | "delivered" | "read" | "played" | "failed";

const PROVIDER_STATUS_RANK: Readonly<Record<ProviderStatus, number>> = {
  sent: 1,
  delivered: 2,
  read: 3,
  played: 4,
  failed: 5,
};

/** Statuses only move forward: a status is applied only when its rank is higher. */
export function providerStatusRank(status: ProviderStatus): number {
  return PROVIDER_STATUS_RANK[status];
}

export function isProviderStatus(value: unknown): value is ProviderStatus {
  return typeof value === "string" && Object.hasOwn(PROVIDER_STATUS_RANK, value);
}
