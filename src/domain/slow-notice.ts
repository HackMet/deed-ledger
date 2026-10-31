/**
 * The two-minute message: when a customer's burst has waited this long with no answer queued, the
 * sweep queues one fixed line ("we got your message") and raises an urgent Pendientes item. The
 * real answer still goes when it's ready, after the notice.
 *
 * The line is fixed text that says nothing about orders, prices, stock or payments, so it carries
 * no claims: the claim check has nothing to verify and never swaps it for the safe reply.
 */
import { COPY } from "./replies";

/** A burst whose oldest open message is older than this, with no answer since, gets the notice. */
export const SLOW_NOTICE_AFTER_MS = 2 * 60 * 1000;

/**
 * Bursts older than this are left alone: a message stuck that long is the stranded and failure
 * paths' business, and a notice for it (say, right after a deploy) would only confuse.
 */
export const SLOW_NOTICE_LOOKBACK_MS = 60 * 60 * 1000;

/** "Te respondemos en un momento" is stale soon: unsent by then, it expires. */
export const SLOW_NOTICE_TTL_MS = 10 * 60 * 1000;

export const SLOW_NOTICE_KIND = "slow_notice";

export const SLOW_NOTICE_BODY = COPY.slowNotice;

/** One notice per burst, named by its oldest open message. The outbox's dedupe_key is UNIQUE. */
export function slowNoticeDedupeKey(inboundId: string): string {
  return `slow_notice:${inboundId}`;
}

/** The notice's claims: none, by design (see above). */
export const SLOW_NOTICE_CLAIMS: readonly [] = [];
