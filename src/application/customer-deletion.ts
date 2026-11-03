/**
 * Deleting a customer's data on their explicit request (#30). The gate records the request and
 * queues the confirmation; this purge runs from the cron once the confirmation is out (or after a
 * grace period), and is retried every minute until it succeeds:
 *
 * 1. R2: every object under the customer's media prefixes.
 * 2. D1, one batch: phone, name, message text, provider IDs, media references, the bodies we sent
 *    them; unsent rows fail; learned aliases their orders proposed and the store hasn't decided
 *    (decided ones stay, unlinked from the order: they're the store's); a tombstone keyed by the
 *    phone's keyed hash, never the phone.
 * 3. R2 again, on every sweep for MEDIA_RECHECK_AFTER_PURGE_MS: a job that was already downloading
 *    a photo when step 1 ran can still write it afterwards. Once the D1 batch has run, no new job
 *    starts (pending ones are failed) and the media IDs are gone, so only uploads already in flight
 *    can land, and they finish within a lease or two. Erasing is idempotent: an empty prefix costs
 *    one list call.
 *
 * The customer row stays, empty, so sale and fiado amounts that point at it keep their history
 * without the person. A webhook for a message sent before the purge (a late delivery or Meta's
 * retry) is refused inside the intake batch (intake-repository); a message sent after it starts a
 * new customer.
 */
import { describeError } from "./errors";
import type { Deps, Tenant } from "./ports";

/** How long a purge waits for the confirmation to go out before it runs anyway. */
export const DELETION_ACK_GRACE_MS = 2 * 60 * 60 * 1000;
const DELETIONS_PER_SWEEP = 20;
/**
 * How long after a purge its prefixes are erased again: well past the job lease (LEASE_TTL_MS, one
 * minute) and the media download timeout, so an upload that was in flight has landed by then.
 */
export const MEDIA_RECHECK_AFTER_PURGE_MS = 10 * 60 * 1000;

export interface PurgeSummary {
  readonly purged: number;
  readonly failed: number;
}

export async function purgeRequestedDeletions(deps: Deps): Promise<PurgeSummary> {
  const due = await deps.customerControls.deletionsDue(deps.clock.now() - DELETION_ACK_GRACE_MS, DELETIONS_PER_SWEEP);
  let purged = 0;
  let failed = 0;
  for (const customer of due) {
    const tenant: Tenant = { businessId: customer.businessId };
    try {
      const media = await deps.customerControls.deletionMedia(tenant, customer.customerId);
      // Objects first: if this fails, D1 still lists the prefixes and the next sweep tries again.
      for (const prefix of media.mediaPrefixes) await deps.mediaEraser.erasePrefix(tenant, prefix);
      const senderHash = media.phone === null ? null : await deps.hasher.hash("sender", media.phone);
      if (await deps.customerControls.purge(tenant, customer.customerId, senderHash, deps.clock.now())) purged++;
    } catch (error) {
      failed++;
      deps.log.error("customer_purge_failed", { businessId: tenant.businessId, reason: describeError(error) });
    }
  }
  if (due.length > 0) deps.log.info("customer_purge_done", { count: purged, outcome: `failed:${failed}` });
  await eraseLateUploads(deps);
  return { purged, failed };
}

/** Step 3: erases recently purged customers' prefixes again (including the ones purged just now). */
async function eraseLateUploads(deps: Deps): Promise<void> {
  const recent = await deps.customerControls.purgedSince(deps.clock.now() - MEDIA_RECHECK_AFTER_PURGE_MS, DELETIONS_PER_SWEEP);
  for (const customer of recent) {
    const tenant: Tenant = { businessId: customer.businessId };
    try {
      const { mediaPrefixes } = await deps.customerControls.deletionMedia(tenant, customer.customerId);
      let erased = 0;
      for (const prefix of mediaPrefixes) erased += await deps.mediaEraser.erasePrefix(tenant, prefix);
      if (erased > 0) deps.log.warn("customer_late_media_erased", { businessId: tenant.businessId, count: erased });
    } catch (error) {
      // The next sweep tries again while the customer is inside the window.
      deps.log.error("customer_late_media_erase_failed", { businessId: tenant.businessId, reason: describeError(error) });
    }
  }
}
