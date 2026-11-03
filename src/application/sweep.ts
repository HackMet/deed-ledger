import { STRANDED_AFTER_MS } from "../domain/processing";
import {
  SLOW_NOTICE_AFTER_MS,
  SLOW_NOTICE_BODY,
  SLOW_NOTICE_CLAIMS,
  SLOW_NOTICE_KIND,
  SLOW_NOTICE_LOOKBACK_MS,
  SLOW_NOTICE_TTL_MS,
  slowNoticeDedupeKey,
} from "../domain/slow-notice";
import { dispatchOutbox } from "./dispatch";
import { describeError } from "./errors";
import type { Deps, OutboxMaintenance, SlowBurst } from "./ports";

const STRANDED_PER_SWEEP = 100;
const OUTBOX_PER_SWEEP = 50;
const SLOW_PER_SWEEP = 100;

export interface SweepSummary extends OutboxMaintenance {
  readonly rung: number;
  /** Slow notices this sweep queued. */
  readonly slowNotices: number;
  readonly dispatched: number;
}

/**
 * Runs every minute. Re-rings conversations with due jobs nobody picked up (a lost doorbell, a
 * consumer that died, an expired lease); tells customers whose answer is slow that we got their
 * message (once per burst, between 2 and 3 minutes in); expires stale replies, settles sends whose
 * outcome is unknown, stops the rest of a reply group that ended unsent, marks closed windows,
 * prunes old records; then retries the outbox. The processor decides what to do with each job, under its
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
      // Which conversation the safety net picked up, so a slow reply can be traced to it (IDs only).
      deps.log.warn("stranded_rung", { ...conversation });
    } catch (error) {
      deps.log.error("sweep_ring_failed", { businessId: conversation.businessId, reason: describeError(error) });
    }
  }

  // Before the outbox pass, so the notice goes out in this same sweep.
  const slowNotices = await queueSlowNotices(deps, now);

  const maintenance = await deps.outbox.maintain(now);
  const dispatched = (await dispatchOutbox(deps, { limit: OUTBOX_PER_SWEEP })).length;

  deps.log.info("sweep_done", {
    count: rung,
    outcome: `slow:${slowNotices},expired:${maintenance.expired},unknown:${maintenance.unknownDelivery},stopped:${maintenance.predecessorNotSent},waiting:${maintenance.waitingWindow},pruned:${maintenance.pruned},dispatched:${dispatched}`,
  });
  return { ...maintenance, rung, slowNotices, dispatched };
}

/**
 * The two-minute message. Each burst still waiting for its answer, leased or not, gets the fixed
 * notice once and an urgent Pendientes item. The write itself decides: of two overlapping sweeps,
 * or a sweep racing the real answer, only a write that finds the burst still unanswered lands, and
 * only that sweep raises the item.
 */
async function queueSlowNotices(deps: Deps, now: number): Promise<number> {
  let bursts: SlowBurst[];
  try {
    bursts = await deps.jobs.findSlowBursts(now - SLOW_NOTICE_AFTER_MS, now - SLOW_NOTICE_LOOKBACK_MS, SLOW_PER_SWEEP);
  } catch (error) {
    deps.log.error("slow_notice_scan_failed", { reason: describeError(error) });
    return 0;
  }
  let queued = 0;
  for (const burst of bursts) {
    const fields = { businessId: burst.businessId, conversationId: burst.conversationId, inboundId: burst.inboundId };
    try {
      const outboxId = deps.ids.newId();
      const written = await deps.jobs.queueSlowNotice(
        burst,
        {
          id: outboxId,
          kind: SLOW_NOTICE_KIND,
          body: SLOW_NOTICE_BODY,
          dedupeKey: slowNoticeDedupeKey(burst.inboundId),
          expiresAtMs: now + SLOW_NOTICE_TTL_MS,
          claims: SLOW_NOTICE_CLAIMS,
        },
        now,
      );
      if (!written) continue;
      queued++;
      deps.log.warn("slow_notice_queued", { ...fields, outboxId });
      await deps.pendientes.raise(
        { businessId: burst.businessId },
        {
          kind: "slow_reply",
          urgency: "urgent",
          conversationId: burst.conversationId,
          inboundId: burst.inboundId,
          outboxId,
        },
      );
    } catch (error) {
      deps.log.error("slow_notice_failed", { ...fields, reason: describeError(error) });
    }
  }
  return queued;
}
