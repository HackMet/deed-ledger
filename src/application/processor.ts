import { COULD_NOT_OPEN_MEDIA, couldNotDownload, couldNotProcess, HANDED_TO_STORE } from "../domain/copy";
import { FAILURE_REPLY_TTL_MS, OUTBOX_BODY_MAX_CHARS } from "../domain/outbox";
import {
  attemptsExhausted,
  BUSY_RECHECK_DELAY_S,
  expectsMedia,
  JOBS_PER_ROUND,
  LEASE_TTL_MS,
  MAX_JOB_ATTEMPTS,
  retryAfterMs,
  SETTLE_MS,
  secondsUntil,
  settleDelaySeconds,
} from "../domain/processing";
import { splitText } from "../domain/text";
import { describeError, LeaseLostError, PermanentWriteError, StaleSnapshotError, StaleWriteError } from "./errors";
import type { ConversationRef, Deps, Job, JobOutcome, Lease, OutboxDraft, ReplyDraft } from "./ports";

export type ProcessOutcome =
  | "idle" // nothing to do
  | "processed" // the eligible jobs finished or failed for good
  | "settling" // messages are still arriving; rang again for later
  | "deferred" // the oldest job waits for its retry time; rang again for then
  | "busy" // another consumer holds the lease; rang again for later
  | "stale" // the lease or a job moved on mid-way; this consumer's writes were refused
  | "not_found"; // no such conversation in that store

type JobResult =
  | { readonly status: "done" | "failed" | "stale_snapshot" }
  | { readonly status: "deferred"; readonly retryAfterMs: number };

const MAX_ROUNDS = 5;

/**
 * Handles one doorbell: lease the conversation, then work through its settled jobs oldest first.
 * D1 is the truth; a doorbell only says "look at this conversation".
 */
export async function processConversation(deps: Deps, conversation: ConversationRef): Promise<ProcessOutcome> {
  const lease: Lease = { ...conversation, leaseId: deps.ids.newId() };
  const claim = await deps.jobs.claimLease(conversation, lease.leaseId, LEASE_TTL_MS);
  if (claim === "missing") {
    deps.log.warn("doorbell_for_missing_conversation", { businessId: conversation.businessId });
    return "not_found";
  }
  if (claim === "busy") {
    // The holder may be about to release; check again shortly so a new message isn't stranded.
    await deps.doorbell.ring(conversation, BUSY_RECHECK_DELAY_S);
    return "busy";
  }

  try {
    return await runRounds(deps, lease);
  } catch (error) {
    if (error instanceof StaleWriteError) {
      deps.log.warn("stale_write_refused", { ...ids(lease), reason: error.reason });
      return "stale";
    }
    throw error;
  } finally {
    await deps.jobs.releaseLease(lease);
  }
}

async function runRounds(deps: Deps, lease: Lease): Promise<ProcessOutcome> {
  let processedAny = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const now = deps.clock.now();
    // One statement decides "settled?" and lists the jobs, so nothing can slip in between.
    const snapshot = await deps.jobs.snapshot(lease, now - SETTLE_MS, JOBS_PER_ROUND);
    if (snapshot.openCount === 0) return processedAny ? "processed" : "idle";
    if (snapshot.jobs.length === 0) {
      return handOff(deps, lease, settleDelaySeconds(now, snapshot.newestReceivedAtMs ?? now), "settling");
    }
    // The burst's newest message is the round's last job only when the round took every open job.
    const newestOfBurst = snapshot.openCount === snapshot.jobs.length ? snapshot.jobs.length - 1 : -1;

    for (const [index, job] of snapshot.jobs.entries()) {
      const at = deps.clock.now();
      if (job.retryAfterMs !== null && job.retryAfterMs > at) {
        // Messages are handled in order: everything after a deferred job waits for it.
        return handOff(deps, lease, secondsUntil(at, job.retryAfterMs), "deferred");
      }
      if (await deps.jobs.hasArrivalsAfter(lease, snapshot.seq)) {
        // A message arrived after the snapshot, even before the round's first job: let it settle,
        // then continue in order with it included.
        return handOff(deps, lease, settleDelaySeconds(at, at), "settling");
      }
      const result = await runJob(deps, lease, job, index === newestOfBurst);
      if (result.status === "deferred") {
        return handOff(deps, lease, secondsUntil(deps.clock.now(), result.retryAfterMs), "deferred");
      }
      if (result.status === "stale_snapshot") {
        // A message that sorts before this job arrived after the check above, and the start batch
        // refused the job. Once that message has settled, a new snapshot takes them in order.
        const later = deps.clock.now();
        return handOff(deps, lease, settleDelaySeconds(later, later), "settling");
      }
      processedAny = true;
    }
  }
  // Still busy after several rounds: hand over to a fresh doorbell instead of holding on.
  return handOff(deps, lease, 0, "processed");
}

async function handOff(deps: Deps, lease: Lease, delaySeconds: number, outcome: ProcessOutcome): Promise<ProcessOutcome> {
  await deps.jobs.releaseLease(lease);
  await deps.doorbell.ring(lease, delaySeconds);
  deps.log.info("conversation_handed_off", { ...ids(lease), outcome, delaySeconds });
  return outcome;
}

/** Runs one job. `newestOfBurst`: it was the conversation's last open job when the round began. */
async function runJob(deps: Deps, lease: Lease, job: Job, newestOfBurst: boolean): Promise<JobResult> {
  const fields = { ...ids(lease), inboundId: job.id, attempts: job.attempts };

  if (attemptsExhausted(job.attempts)) {
    // Its last attempt died with its consumer.
    await handOverIfPromised(deps, lease, job, couldNotProcess(job.kind));
    await deps.jobs.abandonJob(lease, job.id, "attempts_exhausted", deps.clock.now(), failureReply(deps, job, couldNotProcess(job.kind)));
    deps.log.warn("job_failed", { ...fields, reason: "attempts_exhausted" });
    return { status: "failed" };
  }

  if (!(await deps.jobs.extendLease(lease, LEASE_TTL_MS))) throw new LeaseLostError();
  try {
    await deps.jobs.startJob(lease, job.id, deps.clock.now());
  } catch (error) {
    if (!(error instanceof StaleSnapshotError)) throw error;
    deps.log.info("job_start_refused", { ...fields, reason: "stale_snapshot" });
    return { status: "stale_snapshot" };
  }
  const attempt = job.attempts + 1;

  if (expectsMedia(job.kind) && job.mediaAssetId === null) {
    // A photo or voice note that came without a usable media ID: there is nothing to open, and no
    // retry can change that. Say so, instead of acknowledging it as received.
    await deps.jobs.failJob(lease, job.id, "media_missing", deps.clock.now(), failureReply(deps, job, COULD_NOT_OPEN_MEDIA));
    deps.log.warn("job_failed", { ...fields, attempts: attempt, reason: "media_missing" });
    return { status: "failed" };
  }

  if (job.mediaAssetId !== null && !(await storeMedia(deps, lease, job, job.mediaAssetId))) {
    // Never "done" with media we couldn't fetch: retry with backoff, then fail visibly.
    return failOrDefer(deps, lease, job, attempt, "media_unavailable", couldNotDownload(job.kind));
  }

  let outcome: JobOutcome;
  try {
    outcome = await deps.jobHandler.handle({ lease, job, isNewestOfBurst: newestOfBurst });
  } catch (error) {
    if (error instanceof StaleWriteError) throw error;
    deps.log.warn("job_attempt_failed", { ...fields, reason: describeError(error) });
    return failOrDefer(deps, lease, job, attempt, "attempt_failed", couldNotProcess(job.kind));
  }
  const drafts = toOutbox(deps, job, outcome.replies);
  // Closing the burst is decided for the job, not per reply: its replies are written together or not at all.
  const closesBurst = outcome.replies.some((reply) => reply.closesBurst === true);
  let written: number;
  try {
    written = await deps.jobs.completeJob(lease, job.id, deps.clock.now(), drafts, closesBurst, outcome.commits);
  } catch (error) {
    if (error instanceof StaleWriteError) throw error;
    // Nothing was saved. A refused commit guard (the records moved on) is worth another attempt,
    // which reads them again; a constraint violation fails the same way every time.
    deps.log.warn("job_commit_refused", { ...fields, reason: describeError(error) });
    if (error instanceof PermanentWriteError) {
      await handOverIfPromised(deps, lease, job, couldNotProcess(job.kind));
      await deps.jobs.failJob(lease, job.id, "commit_rejected", deps.clock.now(), failureReply(deps, job, couldNotProcess(job.kind)));
      deps.log.warn("job_failed", { ...fields, attempts: attempt, reason: "commit_rejected" });
      return { status: "failed" };
    }
    return failOrDefer(deps, lease, job, attempt, "commit_refused", couldNotProcess(job.kind));
  }
  if (written < drafts.length) {
    // Another job of the conversation is open (one arrived while this one ran): the burst isn't
    // over, so its closing replies are left to its last job.
    deps.log.info("burst_reply_withheld", { ...fields, count: drafts.length - written });
  }
  deps.log.info("job_done", fields);
  return { status: "done" };
}

async function failOrDefer(
  deps: Deps,
  lease: Lease,
  job: Job,
  attempt: number,
  errorCode: string,
  failureCopy: string,
): Promise<JobResult> {
  const now = deps.clock.now();
  if (attempt >= MAX_JOB_ATTEMPTS) {
    await handOverIfPromised(deps, lease, job, failureCopy);
    await deps.jobs.failJob(lease, job.id, errorCode, now, failureReply(deps, job, failureCopy));
    deps.log.warn("job_failed", { ...ids(lease), inboundId: job.id, attempts: attempt, reason: errorCode });
    return { status: "failed" };
  }
  const retryAt = retryAfterMs(now, attempt);
  await deps.jobs.deferJob(lease, job.id, errorCode, retryAt);
  deps.log.info("job_deferred", { ...ids(lease), inboundId: job.id, attempts: attempt, reason: errorCode });
  return { status: "deferred", retryAfterMs: retryAt };
}

/**
 * Downloads a message's media into an immutable key under the store's prefix and publishes it
 * through a fenced write. False when the media can't be fetched or stored now.
 */
async function storeMedia(deps: Deps, lease: Lease, job: Job, assetId: string): Promise<boolean> {
  const asset = await deps.jobs.getMediaAsset(lease, assetId);
  if (asset === null) return false;
  if (asset.state === "stored") return true;
  const fields = { ...ids(lease), inboundId: job.id, assetId };
  try {
    const media = await deps.mediaSource.fetch({ providerMediaId: asset.providerMediaId, phoneNumberId: asset.phoneNumberId });
    if (media === null) {
      deps.log.info("media_not_downloaded", { ...fields, reason: "source_unavailable" });
      return false;
    }
    const stored = await deps.mediaStore.putImmutable(lease, asset.prefix, media);
    await deps.jobs.publishMedia(lease, job.id, asset.id, stored, deps.clock.now());
    return true;
  } catch (error) {
    if (error instanceof StaleWriteError) throw error;
    deps.log.warn("media_not_downloaded", { ...fields, reason: describeError(error) });
    return false;
  }
}

/**
 * Validates and splits replies against the channel's limit before they reach the batch. Each part
 * keeps its reply's index and its own, so the outbox sends them in order.
 */
function toOutbox(deps: Deps, job: Job, replies: readonly ReplyDraft[]): OutboxDraft[] {
  const now = deps.clock.now();
  const maxChars = Math.min(deps.channel.maxTextChars, OUTBOX_BODY_MAX_CHARS);
  return replies.flatMap((reply, n) => {
    const parts = splitText(reply.body, maxChars);
    // Every part carries the reply's claims; only the last carries its buttons.
    return parts.map((body, part) => ({
      id: deps.ids.newId(),
      kind: reply.kind ?? "reply",
      body,
      dedupeKey: `reply:${job.id}:${n}:${part}`,
      replyIndex: n,
      partIndex: part,
      expiresAtMs: now + reply.ttlMs,
      ...(reply.claims === undefined ? {} : { claims: reply.claims }),
      ...(reply.buttons === undefined || part !== parts.length - 1 ? {} : { buttons: reply.buttons }),
    }));
  });
}

/**
 * "Se lo pasé a la tienda" is only true if someone sees it: the failure that says it raises a
 * Pendientes item first (a retry may raise it twice, never zero times; the item is keyed by the
 * message). IDs only.
 */
async function handOverIfPromised(deps: Deps, lease: Lease, job: Job, body: string): Promise<void> {
  if (body !== HANDED_TO_STORE) return;
  const customer = await deps.customers.ofConversation(lease);
  if (customer === null) return;
  await deps.pendientes.raise(lease, {
    kind: "customer_handoff",
    conversationId: lease.conversationId,
    customerId: customer.id,
    inboundId: job.id,
  });
}

function failureReply(deps: Deps, job: Job, body: string): OutboxDraft[] {
  return [
    {
      id: deps.ids.newId(),
      kind: "job_failed",
      body,
      dedupeKey: `job_failed:${job.id}`,
      replyIndex: 0,
      partIndex: 0,
      expiresAtMs: deps.clock.now() + FAILURE_REPLY_TTL_MS,
    },
  ];
}

function ids(lease: Lease) {
  return { businessId: lease.businessId, conversationId: lease.conversationId, leaseId: lease.leaseId };
}
