import { dispatchOutbox } from "../application/dispatch";
import { describeError } from "../application/errors";
import type { ConversationRef, Deps } from "../application/ports";
import { processConversation } from "../application/processor";
import { STRANDED_AFTER_MS } from "../domain/processing";
import { parseDoorbellMessage } from "../infrastructure/queue-doorbell";
import { type DemoHistoryRunner, parseDemoHistoryMessage } from "../application/demo-history";

const RETRY_DELAY_S = 10;

/**
 * Queue consumer. Each message is handled on its own, so one failure doesn't retry the batch. A
 * demo store's history piece takes up to about 600 D1 queries, and one Worker invocation may make
 * 1,000: a batch runs at most one piece, and sends any other back as a fresh message for a moment
 * later (a retry would count against the queue's attempts and drop it in the end).
 */
export async function handleQueueBatch(batch: MessageBatch<unknown>, deps: Deps, history: DemoHistoryRunner | null = null): Promise<void> {
  let seeded = false;
  for (const message of batch.messages) {
    const piece = parseDemoHistoryMessage(message.body);
    if (piece !== null) {
      if (history === null) {
        message.ack();
        continue;
      }
      if (seeded) {
        try {
          await history.later(piece);
          message.ack();
        } catch {
          message.retry();
        }
        continue;
      }
      seeded = true;
      try {
        await history.run(piece);
      } catch (error) {
        deps.log.error("demo_history_failed", { businessId: piece.businessId, reason: describeError(error) });
      }
      // Never retried: a piece that failed is left out, not seeded twice.
      message.ack();
      continue;
    }
    const conversation = parseDoorbellMessage(message.body);
    if (conversation === null) {
      deps.log.warn("doorbell_malformed");
      message.ack();
      continue;
    }
    logReceived(deps, conversation, message);
    try {
      const outcome = await processConversation(deps, conversation);
      deps.log.info("doorbell_handled", { ...conversation, outcome });
      message.ack();
    } catch (error) {
      deps.log.error("doorbell_failed", { ...conversation, reason: describeError(error) });
      message.retry({ delaySeconds: RETRY_DELAY_S });
      continue;
    }
    try {
      await dispatchOutbox(deps, { limit: 10, conversation });
    } catch (error) {
      // The cron sweep retries the outbox.
      deps.log.error("outbox_dispatch_failed", { ...conversation, reason: describeError(error) });
    }
  }
}

/**
 * When a doorbell reaches the consumer: its delivery attempt and how long since it was sent (any
 * delay it asked for included). No ring asks for more than ten seconds, so a first attempt older
 * than the sweep's threshold was held by the queue: a warning, to tell a slow queue from a lost
 * ring. IDs and numbers only.
 */
function logReceived(deps: Deps, conversation: ConversationRef, message: Message<unknown>): void {
  const latencyMs = Math.max(0, deps.clock.now() - message.timestamp.getTime());
  const fields = { ...conversation, attempts: message.attempts, latencyMs };
  if (latencyMs > STRANDED_AFTER_MS) deps.log.warn("doorbell_received", { ...fields, reason: "late" });
  else deps.log.info("doorbell_received", fields);
}
