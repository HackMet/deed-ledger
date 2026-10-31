import type { Deps } from "../application/ports";
import { purgeRequestedDeletions } from "../application/customer-deletion";
import { describeError } from "../application/errors";
import { runSweep } from "../application/sweep";

/** Cron trigger (every minute): recover stranded jobs and retry the outbox. */
export async function handleScheduled(deps: Deps): Promise<void> {
  await runSweep(deps);
  // After the sweep's dispatch, so a deletion's confirmation goes out before the phone is erased.
  try {
    await purgeRequestedDeletions(deps);
  } catch (error) {
    deps.log.error("customer_purge_sweep_failed", { reason: describeError(error) });
  }
}
