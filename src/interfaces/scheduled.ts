import type { Deps } from "../application/ports";
import { purgeRequestedDeletions } from "../application/customer-deletion";
import { describeError } from "../application/errors";
import { runSweep } from "../application/sweep";

/** Cron trigger (every minute): recover stranded jobs and retry the outbox. */
export async function handleScheduled(deps: Deps): Promise<void> {
  try {
    await runSweep(deps);
  } finally {
    // After the sweep's dispatch, so a deletion's confirmation goes out before the phone is erased;
    // and even when the sweep fails, so a deletion request is never held up by it.
    try {
      await purgeRequestedDeletions(deps);
    } catch (error) {
      deps.log.error("customer_purge_sweep_failed", { reason: describeError(error) });
    }
  }
}
