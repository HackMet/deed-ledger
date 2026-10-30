import { RECEIVED_PLACEHOLDER } from "../domain/copy";
import { PLACEHOLDER_TTL_MS } from "../domain/outbox";
import type { JobHandler } from "./ports";

/**
 * Stands in for perception and the engine: acknowledges a burst with one reply, sent with the
 * burst's newest message (withheld if another message arrives meanwhile). Useless after an hour,
 * so it expires then.
 */
export const placeholderHandler: JobHandler = {
  async handle({ isNewestOfBurst }) {
    return {
      replies: isNewestOfBurst ? [{ body: RECEIVED_PLACEHOLDER, ttlMs: PLACEHOLDER_TTL_MS, closesBurst: true }] : [],
    };
  },
};
