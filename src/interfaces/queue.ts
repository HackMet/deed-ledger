import { dispatchOutbox } from "../application/dispatch";
import { describeError } from "../application/errors";
import type { Deps } from "../application/ports";
import { processConversation } from "../application/processor";
import { parseDoorbellMessage } from "../infrastructure/queue-doorbell";

const RETRY_DELAY_S = 10;

/** Queue consumer. Each message is handled on its own, so one failure doesn't retry the batch. */
export async function handleQueueBatch(batch: MessageBatch<unknown>, deps: Deps): Promise<void> {
  for (const message of batch.messages) {
    const conversation = parseDoorbellMessage(message.body);
    if (conversation === null) {
      deps.log.warn("doorbell_malformed");
      message.ack();
      continue;
    }
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
