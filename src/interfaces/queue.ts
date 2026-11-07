import { dispatchOutbox } from "../application/dispatch";
import { describeError } from "../application/errors";
import type { ConversationRef, Deps } from "../application/ports";
import { processConversation } from "../application/processor";
import { STRANDED_AFTER_MS } from "../domain/processing";
import { parseDoorbellMessage } from "../infrastructure/queue-doorbell";
import {
  DEMO_HISTORY_ITEMS,
  type DemoHistoryMessage,
  type DemoHistoryRunner,
  demoHistoryMessage,
  parseDemoHistoryMessage,
} from "../application/demo-history";

const RETRY_DELAY_S = 10;

/** The demo-seed queue's name (wrangler.jsonc): its batches are history pieces, never doorbells. */
export const DEMO_SEED_QUEUE = "store-assistant-demo-seed";
/**
 * The attempt at which a piece that can't be put back is given up, logged: under each queue's
 * max_retries (wrangler.jsonc), so the queue never drops one silently. No dead-letter queue: a lost
 * piece is one order missing from a made-up history, and the log says which.
 */
const SEED_LAST_ATTEMPT = 3;
const JOBS_LAST_ATTEMPT = 5;

/**
 * The demo-seed queue's consumer. A history piece takes up to about 600 D1 queries, and one Worker
 * invocation may make 1,000, so a batch runs at most one piece: the queue delivers one per batch,
 * and any other is put back as a fresh message for a moment later. A piece is never retried (a
 * retry could seed half an order twice): one that fails is logged and left out.
 */
export async function handleSeedBatch(batch: MessageBatch<unknown>, deps: Deps, history: DemoHistoryRunner | null): Promise<void> {
  let seeded = false;
  for (const message of batch.messages) {
    const piece = parseDemoHistoryMessage(message.body);
    if (piece === null) {
      deps.log.warn("demo_history_malformed");
      message.ack();
      continue;
    }
    if (history === null) {
      message.ack();
      continue;
    }
    if (seeded) {
      await putBack(deps, history, piece, message, SEED_LAST_ATTEMPT);
      continue;
    }
    seeded = true;
    try {
      await history.run(piece);
    } catch (error) {
      deps.log.error("demo_history_failed", { businessId: piece.businessId, reason: describeError(error) });
    }
    message.ack();
  }
}

/** A piece on the wrong queue, or one more than a batch runs, goes to the demo-seed queue as a fresh message. */
async function putBack(deps: Deps, history: DemoHistoryRunner, piece: DemoHistoryMessage, message: Message<unknown>, lastAttempt: number): Promise<void> {
  try {
    await history.later(piece);
    message.ack();
  } catch (error) {
    if (message.attempts >= lastAttempt) {
      deps.log.error("demo_history_dropped", { businessId: piece.businessId, attempts: message.attempts, reason: `item ${piece.item}: ${describeError(error)}` });
      message.ack();
    } else {
      message.retry({ delaySeconds: RETRY_DELAY_S });
    }
  }
}

/**
 * A piece on the jobs queue was queued by the version that chained pieces: each one queued the next.
 * This version doesn't, so the piece moves with every piece after it. A piece seeded twice is a
 * duplicate intake drops (fixed message IDs), so moving one that was already queued costs nothing.
 */
async function moveLegacyChain(deps: Deps, history: DemoHistoryRunner, piece: DemoHistoryMessage, message: Message<unknown>): Promise<void> {
  try {
    for (let item = piece.item + 1; item < DEMO_HISTORY_ITEMS; item += 1) await history.later(demoHistoryMessage(piece.businessId, item));
  } catch (error) {
    deps.log.error("demo_history_dropped", { businessId: piece.businessId, attempts: message.attempts, reason: `after item ${piece.item}: ${describeError(error)}` });
  }
  await putBack(deps, history, piece, message, JOBS_LAST_ATTEMPT);
}

/**
 * The jobs queue's consumer: doorbells. Each message is handled on its own, so one failure doesn't
 * retry the batch. A history piece is never run here, so a doorbell never shares an invocation's D1
 * queries with one: a piece found here (queued by an earlier version) moves to the demo-seed queue.
 */
export async function handleQueueBatch(batch: MessageBatch<unknown>, deps: Deps, history: DemoHistoryRunner | null = null): Promise<void> {
  for (const message of batch.messages) {
    const piece = parseDemoHistoryMessage(message.body);
    if (piece !== null) {
      if (history === null) message.ack();
      else await moveLegacyChain(deps, history, piece, message);
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
