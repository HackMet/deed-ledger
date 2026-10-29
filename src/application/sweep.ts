import { STRANDED_AFTER_MS } from "../domain/processing";
import { dispatchOutbox } from "./dispatch";
import { describeError } from "./errors";
import type { Deps, OutboxMaintenance } from "./ports";

const STRANDED_PER_SWEEP = 100;
const OUTBOX_PER_SWEEP = 50;

export interface SweepSummary extends OutboxMaintenance {
  readonly rung: number;
  readonly dispatched: number;
}

/**
 * Runs every minute. Re-rings conversations with due jobs nobody picked up (a lost doorbell, a
 * consumer that died, an expired lease); expires stale replies, settles sends whose outcome is
 * unknown, stops the rest of a reply group that ended unsent, marks closed windows, prunes old
 * records; then retries the outbox. The processor decides what to do with each job, under its
 * lease.
 */
export async function runSweep(deps: Deps): Promise<SweepSummary> {
  const now = deps.clock.now();
  const stranded = await deps.jobs.findStrandedConversations(now - STRANDED_AFTER_MS, now, STRANDED_PER_SWEEP);
  let rung = 0;
  for (const conversation of stranded) {
    try {
      await deps.doorbell.ring(conversation);
      rung++;
    } catch (error) {
      deps.log.error("sweep_ring_failed", { businessId: conversation.businessId, reason: describeError(error) });
    }
  }

  const maintenance = await deps.outbox.maintain(now);
  const dispatched = (await dispatchOutbox(deps, { limit: OUTBOX_PER_SWEEP })).length;

  deps.log.info("sweep_done", {
    count: rung,
    outcome: `expired:${maintenance.expired},unknown:${maintenance.unknownDelivery},stopped:${maintenance.predecessorNotSent},waiting:${maintenance.waitingWindow},pruned:${maintenance.pruned},dispatched:${dispatched}`,
  });
  return { ...maintenance, rung, dispatched };
}
