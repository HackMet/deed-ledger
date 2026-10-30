import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDoorbellMessage, QueueDoorbell } from "../src/infrastructure/queue-doorbell";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("queue doorbell", () => {
  it("sends only the conversation reference, with an optional per-message delay", async () => {
    const send = vi.spyOn(env.JOBS, "send").mockImplementation(async () => ({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: new Date(0) } },
    }));
    const doorbell = new QueueDoorbell(env.JOBS);
    const conversation = { businessId: "b1", conversationId: "c1" };

    await doorbell.ring(conversation);
    await doorbell.ring(conversation, 3);
    await doorbell.ring(conversation, 1_000_000);

    const body = { v: 1, businessId: "b1", conversationId: "c1" };
    expect(send.mock.calls).toEqual([
      [body, { contentType: "json" }],
      [body, { delaySeconds: 3, contentType: "json" }],
      [body, { delaySeconds: 86_400, contentType: "json" }],
    ]);
  });

  it("accepts only well-formed doorbell messages", () => {
    expect(parseDoorbellMessage({ v: 1, businessId: "b", conversationId: "c" })).toEqual({ businessId: "b", conversationId: "c" });
    for (const bad of [null, "x", {}, { v: 2, businessId: "b", conversationId: "c" }, { v: 1, businessId: "", conversationId: "c" }]) {
      expect(parseDoorbellMessage(bad)).toBeNull();
    }
  });
});
