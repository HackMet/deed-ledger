import { MEMBER_MESSAGES_PER_HOUR, orderingTimestampS } from "../domain/processing";
import { DEMO_MAX_MESSAGES_PER_STORE, isDemoBusiness } from "../domain/demo";
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
  // The unknown-sender notice retired with customers (#14). Always empty until the notice path is removed.
  const notices: PendingNotice[] = [];
  const channels = new Map<string, ChannelAccount | null>();
  // The number customers see, per channel account, when a webhook says a new one: saved after the loop.
  const shownNumbers = new Map<string, { channel: ChannelAccount; shown: string }>();

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
      // Anyone writing to the store's number is its customer: there is no unknown-sender path.
      const ring = await recordCustomerMessage(deps, tenant, channel, event);
      if (ring !== null) conversations.set(ring.conversationId, ring);
      const shown = event.displayPhoneNumber ?? null;
      if (shown !== null && shown !== (channel.displayPhoneNumber ?? null)) shownNumbers.set(channel.id, { channel, shown });
    } catch (error) {
      if (!(error instanceof PermanentWriteError)) throw error;
      deps.log.error("intake_rejected_permanently", {
        businessId: tenant.businessId,
        channelAccountId: channel.id,
        reason: describeError(error),
      });
    }
  }

  // Only once every message is saved: the number is display only and never holds one up.
  for (const { channel, shown } of shownNumbers.values()) await rememberDisplayNumber(deps, channel, shown);

  return { conversations: [...conversations.values()], notices };
}

/**
 * Keeps the number customers see (from the signed webhook) on the channel account, so the console
 * can offer "Probar como cliente" without anyone typing it in. Written only when it changes; best
 * effort: a failure is logged with IDs and never affects the messages, which are already saved.
 */
async function rememberDisplayNumber(deps: Deps, channel: ChannelAccount, shown: string): Promise<void> {
  try {
    await deps.tenancy.rememberDisplayNumber(channel, shown);
  } catch (error) {
    deps.log.warn("display_number_not_saved", { businessId: channel.businessId, channelAccountId: channel.id, reason: describeError(error) });
  }
}

/** Returns the conversation to ring, only when the message is new (the sweep recovers lost rings). */
async function recordCustomerMessage(
  deps: Deps,
  tenant: Tenant,
  channel: ChannelAccount,
  event: InboundMessageEvent,
): Promise<ConversationRef | null> {
  const receivedAtMs = deps.clock.now();
  const recorded = await deps.intake.recordCustomerMessage(tenant, {
    channelAccountId: channel.id,
    event,
    receivedAtMs,
    orderTsS: orderingTimestampS(event.providerTimestampS, receivedAtMs),
    newCustomerId: deps.ids.newId(),
    newConversationId: deps.ids.newId(),
    newInboundId: deps.ids.newId(),
    newMediaAssetId: deps.ids.newId(),
    // A demo store's phone is held to the demo's message limit in the same batch, so parallel sends
    // can't pass it together (the route checks the store's whole life first).
    hourlyCap: isDemoBusiness(tenant.businessId) ? DEMO_MAX_MESSAGES_PER_STORE : MEMBER_MESSAGES_PER_HOUR,
    // A late or retried delivery for a customer deleted since must not create them again (#30).
    // The batch checks the tombstone itself, so a purge that commits meanwhile still wins.
    senderHash: await deps.hasher.hash("sender", event.senderPhone),
  });
  if (recorded.outcome === "refused") {
    deps.log.info("inbound_refused_after_deletion", { businessId: tenant.businessId });
    return null;
  }
  const { outcome } = recorded;
  // IDs only: never the phone number.
  const fields = { businessId: tenant.businessId, conversationId: recorded.conversationId, outcome };
  if (outcome === "capped") {
    deps.log.warn("customer_intake_capped", fields);
    return null;
  }
  deps.log.info("inbound_recorded", fields);
  return outcome === "new" ? { businessId: tenant.businessId, conversationId: recorded.conversationId } : null;
}
