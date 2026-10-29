import { UNKNOWN_SENDER_NOTICE } from "../domain/copy";
import { UNKNOWN_NOTICE_TTL_MS, UNKNOWN_SENDER_MESSAGES_PER_DAY } from "../domain/outbox";
import { MEMBER_MESSAGES_PER_HOUR, orderingTimestampS } from "../domain/processing";
import { describeError, PermanentWriteError } from "./errors";
import type { ChannelAccount, ChannelEvent, ConversationRef, Deps, InboundMessageEvent, Tenant } from "./ports";

export interface PendingNotice {
  readonly businessId: string;
  readonly outboxId: string;
  /** Held in memory only, to send the notice now. It is never stored. */
  readonly toPhone: string;
}

export interface IntakeOutcome {
  /** Conversations with a new message to ring, one entry per conversation. */
  readonly conversations: readonly ConversationRef[];
  readonly notices: readonly PendingNotice[];
}

/**
 * Saves every event before anything is acknowledged. A transient failure throws, so the webhook
 * answers 500 and Meta retries (duplicates are absorbed by unique keys). A permanent one (a
 * constraint violation) is logged with IDs only and skipped: retrying it for days can't help.
 */
export async function acceptEvents(deps: Deps, events: readonly ChannelEvent[]): Promise<IntakeOutcome> {
  const conversations = new Map<string, ConversationRef>();
  const notices: PendingNotice[] = [];
  const channels = new Map<string, ChannelAccount | null>();

  for (const event of events) {
    let channel = channels.get(event.phoneNumberId);
    if (channel === undefined) {
      channel = await deps.tenancy.findChannelAccount(event.phoneNumberId);
      channels.set(event.phoneNumberId, channel);
    }
    if (channel === null) {
      deps.log.warn("webhook_event_for_unknown_number", { reason: event.type });
      continue;
    }
    const tenant = { businessId: channel.businessId };

    try {
      if (event.type === "status") {
        const statusHash = await deps.hasher.hash("status", event.providerMessageId);
        await deps.intake.recordProviderStatus(tenant, event, statusHash, deps.clock.now());
        continue;
      }
      const member = await deps.tenancy.findActiveMember(tenant, event.senderPhone);
      const recorded = member === null ? null : await recordMemberMessage(deps, tenant, channel, member.userId, event);
      if (recorded === null || recorded === "not_member") {
        // Not a member, or deactivated between the lookup and the write (nothing was stored).
        const notice = await recordUnknownSender(deps, channel, event);
        if (notice !== null) notices.push(notice);
        continue;
      }
      if (recorded.ring !== null) conversations.set(recorded.ring.conversationId, recorded.ring);
    } catch (error) {
      if (!(error instanceof PermanentWriteError)) throw error;
      deps.log.error("intake_rejected_permanently", {
        businessId: tenant.businessId,
        channelAccountId: channel.id,
        reason: describeError(error),
      });
    }
  }

  return { conversations: [...conversations.values()], notices };
}

/**
 * Returns the conversation to ring, only when the message is new (the sweep recovers lost rings),
 * or "not_member" when the membership stopped being active before the write.
 */
async function recordMemberMessage(
  deps: Deps,
  tenant: Tenant,
  channel: ChannelAccount,
  userId: string,
  event: InboundMessageEvent,
): Promise<{ readonly ring: ConversationRef | null } | "not_member"> {
  const receivedAtMs = deps.clock.now();
  const recorded = await deps.intake.recordMemberMessage(tenant, {
    channelAccountId: channel.id,
    userId,
    event,
    receivedAtMs,
    orderTsS: orderingTimestampS(event.providerTimestampS, receivedAtMs),
    newConversationId: deps.ids.newId(),
    newInboundId: deps.ids.newId(),
    newMediaAssetId: deps.ids.newId(),
    hourlyCap: MEMBER_MESSAGES_PER_HOUR,
  });
  const { outcome } = recorded;
  if (outcome === "not_member" || recorded.conversationId === null) {
    deps.log.warn("member_intake_not_member", { businessId: tenant.businessId, outcome });
    return "not_member";
  }
  const fields = { businessId: tenant.businessId, conversationId: recorded.conversationId, outcome };
  if (outcome === "capped") {
    deps.log.warn("member_intake_capped", fields);
    return { ring: null };
  }
  deps.log.info("inbound_recorded", fields);
  return { ring: outcome === "new" ? { businessId: tenant.businessId, conversationId: recorded.conversationId } : null };
}

/** A number that isn't a member: keep only keyed hashes, and a notice to send now if one is due. */
async function recordUnknownSender(
  deps: Deps,
  channel: ChannelAccount,
  event: InboundMessageEvent,
): Promise<PendingNotice | null> {
  const tenant = { businessId: channel.businessId };
  const [senderHash, messageHash] = await Promise.all([
    deps.hasher.hash("sender", event.senderPhone),
    deps.hasher.hash("message", event.providerMessageId),
  ]);
  const receivedAtMs = deps.clock.now();
  const { stored, pendingNoticeId } = await deps.intake.recordUnknownMessage(tenant, {
    channelAccountId: channel.id,
    senderHash,
    messageHash,
    providerTimestampS: event.providerTimestampS,
    receivedAtMs,
    newNoticeId: deps.ids.newId(),
    noticeBody: UNKNOWN_SENDER_NOTICE,
    noticeExpiresAtMs: receivedAtMs + UNKNOWN_NOTICE_TTL_MS,
    dailyCap: UNKNOWN_SENDER_MESSAGES_PER_DAY,
  });
  deps.log.info("unknown_sender_recorded", {
    businessId: tenant.businessId,
    outcome: !stored ? "capped" : pendingNoticeId === null ? "no_notice" : "notice_pending",
  });
  if (pendingNoticeId === null) return null;
  return { businessId: tenant.businessId, outboxId: pendingNoticeId, toPhone: event.senderPhone };
}
