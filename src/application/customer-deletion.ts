/**
 * Deleting a customer's data on their explicit request (#30). The gate records the request and
 * queues the confirmation; this purge runs from the cron once the confirmation is out (or after a
 * grace period), and is retried every minute until it succeeds:
 *
 * 1. R2: every object under the customer's media prefixes.
 * 2. D1, one batch: phone, name, message text, provider IDs, media references, the bodies we sent
 *    them; unsent rows fail; a tombstone keyed by the phone's keyed hash, never the phone.
 *
 * The customer row stays, empty, so sale and fiado amounts that point at it keep their history
 * without the person. A webhook for a message sent before the purge (a late delivery or Meta's
 * retry) is dropped by `refusedAfterDeletion`; a message sent after it starts a new customer.
 */
import { describeError } from "./errors";
import type { Deps, InboundMessageEvent, Tenant } from "./ports";

/** How long a purge waits for the confirmation to go out before it runs anyway. */
export const DELETION_ACK_GRACE_MS = 2 * 60 * 60 * 1000;
const DELETIONS_PER_SWEEP = 20;

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
  return { purged, failed };
}

/**
 * Intake: true when this sender's customer in this store was deleted after the message was sent.
 * Uses the provider's timestamp, which the webhook signature covers: the only clock that says when
 * a late or retried delivery was really sent.
 */
export async function refusedAfterDeletion(deps: Deps, tenant: Tenant, event: InboundMessageEvent): Promise<boolean> {
  const senderHash = await deps.hasher.hash("sender", event.senderPhone);
  const refused = await deps.customerControls.isTombstoned(tenant, senderHash, event.providerTimestampS * 1000);
  if (refused) deps.log.info("inbound_refused_after_deletion", { businessId: tenant.businessId });
  return refused;
}
