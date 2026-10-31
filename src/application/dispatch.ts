import {
  CLAIM_CONFIRM_MAX_MS,
  isExpired,
  isWindowOpen,
  MAX_SEND_ATTEMPTS,
  SEND_CLAIM_MS,
  UNKNOWN_NOTICE_INLINE_RETRY_DELAYS_MS,
} from "../domain/outbox";
import { COPY, flattenClaims, secondCheckHolds } from "../domain/replies";
import { describeError } from "./errors";
import type { ConversationRef, Deps, OutboxMessage, SendResult, Tenant } from "./ports";

export type SendOutcome =
  | "sent"
  | "waiting_window"
  | "expired"
  | "retry_later"
  | "failed"
  | "unknown_delivery"
  | "claim_lost"
  | "skipped";

/** Outcomes that settle a row, so the next row of its conversation may go out. */
const SETTLES_ROW: ReadonlySet<SendOutcome> = new Set(["sent", "expired", "failed", "unknown_delivery"]);

/**
 * Sends what the outbox holds for members. A conversation's replies go out one at a time, in the
 * order they were written: each pass sends the oldest unsettled reply of every conversation, and
 * the next pass the reply after it. Safe to run from several places at once.
 */
export async function dispatchOutbox(
  deps: Deps,
  options: { readonly limit: number; readonly conversation?: ConversationRef },
): Promise<SendOutcome[]> {
  if (!deps.channel.configured) {
    deps.log.info("outbox_dispatch_skipped", { reason: "channel_not_configured" });
    return [];
  }
  const outcomes: SendOutcome[] = [];
  while (outcomes.length < options.limit) {
    const messages = await deps.outbox.listDispatchable(
      deps.clock.now(),
      options.limit - outcomes.length,
      options.conversation,
    );
    let settledAny = false;
    for (const message of messages) {
      let outcome: SendOutcome;
      try {
        outcome = await sendOne(deps, message, null, false);
      } catch (error) {
        // One bad row must not hold up the rest.
        deps.log.error("outbox_send_error", { businessId: message.businessId, outboxId: message.id, reason: describeError(error) });
        outcome = "retry_later";
      }
      outcomes.push(outcome);
      settledAny ||= SETTLES_ROW.has(outcome);
    }
    if (!settledAny) break;
  }
  return outcomes;
}

/**
 * Sends the fixed notice to a number that isn't a member. Its phone number exists only in this
 * request's memory, so the send is retried here a few times. If every attempt fails, the notice is
 * marked failed: the 24-hour slot is held only by a successful send, and a later message retries.
 */
export async function dispatchUnknownNotice(
  deps: Deps,
  notice: { readonly businessId: string; readonly outboxId: string; readonly toPhone: string },
): Promise<SendOutcome> {
  if (!deps.channel.configured) {
    deps.log.info("outbox_dispatch_skipped", { reason: "channel_not_configured" });
    return "skipped";
  }
  let outcome: SendOutcome = "skipped";
  for (const [n, delay] of UNKNOWN_NOTICE_INLINE_RETRY_DELAYS_MS.entries()) {
    if (delay > 0) await deps.sleep(delay);
    const message = await deps.outbox.get({ businessId: notice.businessId }, notice.outboxId);
    if (message === null || message.recipientHash === null) return "skipped";
    outcome = await sendOne(deps, message, notice.toPhone, n === UNKNOWN_NOTICE_INLINE_RETRY_DELAYS_MS.length - 1);
    if (outcome !== "retry_later") break;
  }
  return outcome;
}

async function sendOne(
  deps: Deps,
  candidate: OutboxMessage,
  inlinePhone: string | null,
  lastChance: boolean,
): Promise<SendOutcome> {
  const tenant = { businessId: candidate.businessId };
  const claimId = deps.ids.newId();
  // The claim reserves this attempt (if anything after it dies, the row is never sent twice) and
  // holds back the conversation's later rows until this one settles.
  const message = await deps.outbox.claim(tenant, candidate.id, claimId, SEND_CLAIM_MS, deps.clock.now());
  if (message === null) return "skipped";
  const fields = { businessId: tenant.businessId, outboxId: message.id };

  // Every read first.
  const lastInboundAtMs = await deps.outbox.lastInboundAtMs(message);
  const toPhone =
    inlinePhone ??
    (message.conversationId === null ? null : await deps.outbox.customerPhone(tenant, message.conversationId));
  const channel = await deps.tenancy.findChannelAccountOf(tenant, message.channelAccountId);

  // Then confirm the claim is still ours and extend it past the send's timeout, by the database's
  // clock. If maintenance settled the row meanwhile, it must not go out.
  const confirmFrom = deps.clock.now();
  if (!(await deps.outbox.confirmClaim(tenant, message.id, claimId, SEND_CLAIM_MS))) {
    return claimLost(deps, fields, "not_sent");
  }
  // A fresh time, taken after the confirmation, right before the send: the expiry and the 24-hour
  // window are judged from it, never from a time the confirmation may have outlasted.
  const now = deps.clock.now();

  if (isExpired(now, message.expiresAtMs)) {
    if (!(await deps.outbox.markExpired(tenant, message.id, claimId, now))) return claimLost(deps, fields, "not_sent");
    deps.log.info("outbox_expired", fields);
    return "expired";
  }
  if (!isWindowOpen(now, lastInboundAtMs)) {
    if (!(await deps.outbox.markWaitingWindow(tenant, message.id, claimId, now))) return claimLost(deps, fields, "not_sent");
    deps.log.info("outbox_waiting_window", fields);
    return "waiting_window";
  }
  if (toPhone === null || channel === null) {
    const reason = toPhone === null ? "recipient_unavailable" : "channel_account_missing";
    if (!(await deps.outbox.release(tenant, message.id, claimId, reason, true, now))) return claimLost(deps, fields, "not_sent");
    deps.log.warn("outbox_failed", { ...fields, reason });
    return "failed";
  }
  if (now - confirmFrom > CLAIM_CONFIRM_MAX_MS) {
    // The confirmation came back so late that the claim it extended may not outlast the send.
    // Don't send: the row goes back to pending for a later pass (a notice's last chance ends it).
    if (!(await deps.outbox.release(tenant, message.id, claimId, "claim_confirm_slow", lastChance, now))) {
      return claimLost(deps, fields, "not_sent");
    }
    deps.log.warn(lastChance ? "outbox_failed" : "outbox_send_retry", { ...fields, reason: "claim_confirm_slow" });
    return lastChance ? "failed" : "retry_later";
  }

  // The claim check's second pass, the last read before the send: against the records, after the
  // claim is confirmed and the row is otherwise ready, so a cancel has the least time to slip in.
  const check = await secondCheck(deps, tenant, message);
  const checkedAt = deps.clock.now();
  const checkProblem =
    check === "unavailable"
      ? "claim_check_unavailable"
      : check !== "none" && checkedAt - confirmFrom > CLAIM_CONFIRM_MAX_MS
        ? "claim_check_slow"
        : null;
  if (checkProblem !== null) {
    // Unknown is not "holds", and a check that ate into the claim may not leave time for the send:
    // try again later, never sending the claims unchecked.
    const final = lastChance || message.attempts >= MAX_SEND_ATTEMPTS;
    if (!(await deps.outbox.release(tenant, message.id, claimId, checkProblem, final, checkedAt))) {
      return claimLost(deps, fields, "not_sent");
    }
    deps.log.warn(final ? "outbox_failed" : "outbox_send_retry", { ...fields, reason: checkProblem });
    return final ? "failed" : "retry_later";
  }
  let body = message.body;
  let buttons = message.buttons ?? [];
  if (check === "blocked") {
    if (!(await deps.outbox.markClaimsBlocked(tenant, message.id, claimId, checkedAt))) {
      return claimLost(deps, fields, "not_sent");
    }
    deps.log.warn("reply_claim_blocked", fields);
    await deps.pendientes.raise(tenant, {
      kind: "claim_blocked",
      stage: "before_send",
      conversationId: message.conversationId,
      outboxId: message.id,
      template: null,
    });
    body = COPY.safeReply;
    buttons = [];
  }

  let result: SendResult;
  try {
    const outgoing = { fromPhoneNumberId: channel.phoneNumberId, toPhone, body };
    result =
      buttons.length > 0 && deps.channel.sendButtons !== undefined
        ? await deps.channel.sendButtons({ ...outgoing, buttons })
        : await deps.channel.sendText(outgoing);
  } catch (error) {
    // The channel failed in an unknown way; the message may have gone out.
    result = { ok: false, disposition: "unknown", errorCode: describeError(error) };
  }

  const at = deps.clock.now();
  if (result.ok) {
    // An outgoing message ID embeds the recipient's phone number: keep it only for members.
    const keepId = message.recipientHash === null;
    const statusHash = keepId ? await hashOrNull(deps, result.providerMessageId) : null;
    if (!(await deps.outbox.markSent(tenant, message.id, claimId, keepId ? result.providerMessageId : null, statusHash, at))) {
      return claimLost(deps, fields, "sent");
    }
    deps.log.info("outbox_sent", fields);
    return "sent";
  }
  if (result.disposition === "unknown") {
    if (!(await deps.outbox.markUnknownDelivery(tenant, message.id, claimId, result.errorCode, at))) {
      return claimLost(deps, fields, "unknown");
    }
    deps.log.warn("outbox_unknown_delivery", { ...fields, reason: result.errorCode });
    return "unknown_delivery";
  }
  const final = result.disposition === "permanent" || lastChance || message.attempts >= MAX_SEND_ATTEMPTS;
  if (!(await deps.outbox.release(tenant, message.id, claimId, result.errorCode, final, at))) {
    return claimLost(deps, fields, "not_sent");
  }
  deps.log.warn(final ? "outbox_failed" : "outbox_send_retry", { ...fields, reason: result.errorCode });
  return final ? "failed" : "retry_later";
}

/**
 * none: the row claims nothing. holds: every claim still holds. blocked: one doesn't, or no engine
 * can say (then the safe reply goes instead). unavailable: the engine failed to answer.
 */
async function secondCheck(
  deps: Deps,
  tenant: Tenant,
  message: OutboxMessage,
): Promise<"none" | "holds" | "blocked" | "unavailable"> {
  const claims = message.claims ?? [];
  if (claims.length === 0) return "none";
  if (deps.claimVerifier === null) return "blocked";
  const flat = flattenClaims(claims);
  if (flat.length === 0) return "blocked";
  try {
    const verified = await deps.claimVerifier.verifyClaims(tenant, flat);
    return secondCheckHolds(claims, verified) ? "holds" : "blocked";
  } catch (error) {
    deps.log.warn("claim_check_failed", { businessId: tenant.businessId, outboxId: message.id, reason: describeError(error) });
    return "unavailable";
  }
}

/**
 * The claim ran out and maintenance settled the row (as unknown_delivery) before this dispatcher
 * could: nothing more is written. `outcome` says what happened to the send itself.
 */
function claimLost(
  deps: Deps,
  fields: { readonly businessId: string; readonly outboxId: string },
  outcome: "sent" | "unknown" | "not_sent",
): SendOutcome {
  deps.log.warn("outbox_claim_lost", { ...fields, outcome });
  return "claim_lost";
}

/** The status hash only links early delivery statuses; losing it must not lose the send result. */
async function hashOrNull(deps: Deps, providerMessageId: string): Promise<string | null> {
  try {
    return await deps.hasher.hash("status", providerMessageId);
  } catch {
    return null;
  }
}
