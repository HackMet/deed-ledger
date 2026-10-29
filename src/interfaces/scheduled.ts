import type { Deps } from "../application/ports";
import { runSweep } from "../application/sweep";

/** Cron trigger (every minute): recover stranded jobs and retry the outbox. */
export async function handleScheduled(deps: Deps): Promise<void> {
  await runSweep(deps);
}
