import type { ConversationRef, Doorbell } from "../application/ports";

/** The whole queue message: which conversation has work. Nothing else travels through the queue. */
export interface DoorbellMessage {
  readonly v: 1;
  readonly businessId: string;
  readonly conversationId: string;
}

/** Cloudflare Queues accepts a per-message delay of 0 to 86,400 seconds (docs, Oct 28, 2026). */
const MAX_DELAY_S = 86_400;

export class QueueDoorbell implements Doorbell {
  constructor(private readonly queue: Queue<DoorbellMessage>) {}

  async ring(conversation: ConversationRef, delaySeconds = 0): Promise<void> {
    const message: DoorbellMessage = {
      v: 1,
      businessId: conversation.businessId,
      conversationId: conversation.conversationId,
    };
    const delay = Math.min(Math.max(Math.trunc(delaySeconds), 0), MAX_DELAY_S);
    await this.queue.send(message, delay > 0 ? { delaySeconds: delay, contentType: "json" } : { contentType: "json" });
  }
}

export function parseDoorbellMessage(body: unknown): ConversationRef | null {
  if (typeof body !== "object" || body === null) return null;
  const { v, businessId, conversationId } = body as Record<string, unknown>;
  if (v !== 1 || typeof businessId !== "string" || typeof conversationId !== "string") return null;
  if (businessId === "" || conversationId === "") return null;
  return { businessId, conversationId };
}
