import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeholderHandler } from "../src/application/placeholder-handler";
import type { JobHandler } from "../src/application/ports";
import { parseDoorbellMessage, QueueDoorbell } from "../src/infrastructure/queue-doorbell";
import { FakeClock } from "./helpers/fakes";
import { conversationOf, harness, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { audioMessage, buttonReply, wamid, webhook } from "./helpers/whatsapp";

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

/**
 * Live, Nov 3: a Confirmar tap was answered in 4.6 s; a voice note sent 16 s after the tap was
 * answered 68 s after it arrived. The tail showed its doorbell reaching the consumer 53 s after the
 * webhook rang it (1 to 5 s for the 29 other messages that morning), already settled, so it ran
 * at once; every sweep in between rang nothing. These pin down our side of that path.
 */
describe("a voice note right after a button tap's reply", () => {
  function recordingHandler() {
    const calls: Array<{ kind: string; atMs: number }> = [];
    const handler = (clock: { now(): number }): JobHandler => ({
      async handle(input) {
        calls.push({ kind: input.job.kind, atMs: clock.now() });
        return placeholderHandler.handle(input);
      },
    });
    return { calls, handler };
  }

  async function tapThenVoice() {
    const recorder = recordingHandler();
    const clock = new FakeClock();
    const h = harness({ clock, jobHandler: recorder.handler(clock) });
    const store = await seedStore({ members: [{ phone: newPhone(), role: "owner" }] });
    const phone = newPhone();
    const nowS = () => Math.floor(clock.now() / 1000);
    const tapAt = clock.now();
    const tap = buttonReply({ from: phone, id: wamid(), timestampS: nowS(), replyId: "confirm:order-synthetic:v1", title: "Confirmar" });
    expect((await h.post(webhook(store.phoneNumberId, { messages: [tap] }))).status).toBe(200);
    const conversation = await conversationOf(store.businessId);
    expect(h.takeRingsFor(store.businessId)).toEqual([{ conversation, delaySeconds: 0 }]);

    // Its doorbell arrived 3 s later: settled, so the tap ran at once and was answered.
    clock.advance(3_000);
    await h.deliver([{ conversation, delaySeconds: 0 }], tapAt);
    expect(recorder.calls.map((call) => call.kind)).toEqual(["interactive"]);
    expect(h.takeRingsFor(store.businessId)).toEqual([]);
    expect(h.sentTo(phone)).toHaveLength(1);
    const [free] = await rows<{ lease_id: string | null }>(`SELECT lease_id FROM conversations WHERE id = ?`, conversation.conversationId);
    expect(free?.lease_id).toBeNull();

    // 16 s after the tap, the voice note: the webhook rings for it right away, like for text.
    clock.advance(13_000);
    const voiceAt = clock.now();
    const voice = audioMessage({ from: phone, id: wamid(), timestampS: nowS(), mediaId: "media-voice-synthetic" });
    expect((await h.post(webhook(store.phoneNumberId, { messages: [voice] }))).status).toBe(200);
    expect(h.takeRingsFor(store.businessId)).toEqual([{ conversation, delaySeconds: 0 }]);
    expect(h.log.fields("doorbell_rung").filter((line) => line.businessId === store.businessId)).toEqual([
      { level: "info", event: "doorbell_rung", ...conversation, latencyMs: 0 },
      { level: "info", event: "doorbell_rung", ...conversation, latencyMs: 0 },
    ]);
    return { h, clock, store, conversation, recorder, voiceAt };
  }

  it("is rung by the webhook and runs once settled, without waiting for the sweep", async () => {
    const { h, clock, store, conversation, recorder, voiceAt } = await tapThenVoice();

    // Delivered in 2 s as usual: not settled yet, so handed off for 1 s, then run.
    clock.advance(2_000);
    await h.deliver([{ conversation, delaySeconds: 0 }], voiceAt);
    const [settle] = h.takeRingsFor(store.businessId);
    expect(settle).toEqual({ conversation, delaySeconds: 1 });
    clock.advance(1_000);
    await h.deliver([settle!], clock.now() - 1_000);
    expect(recorder.calls.map((call) => call.kind)).toEqual(["interactive", "audio"]);
    expect(recorder.calls[1]!.atMs - voiceAt).toBe(3_000);
    const jobs = await rows<{ kind: string; job_state: string; attempts: number }>(
      `SELECT kind, job_state, attempts FROM inbound_messages WHERE business_id = ? ORDER BY received_at_ms`,
      store.businessId,
    );
    expect(jobs).toEqual([
      { kind: "interactive", job_state: "done", attempts: 1 },
      { kind: "audio", job_state: "done", attempts: 1 },
    ]);

    // The sweep had nothing to pick up, and every doorbell was on time.
    clock.advance(60_000);
    await h.runCron();
    expect(h.takeRingsFor(store.businessId)).toEqual([]);
    const mine = (event: string) => h.log.fields(event).filter((line) => line.businessId === store.businessId);
    expect(mine("stranded_rung")).toEqual([]);
    expect(mine("doorbell_received").map((line) => [line.level, line.attempts, line.latencyMs])).toEqual([
      ["info", 1, 3_000],
      ["info", 1, 2_000],
      ["info", 1, 1_000],
    ]);
  });

  it("held 53 s by the queue, runs at once on arrival and says the doorbell was late (IDs only)", async () => {
    const { h, clock, store, conversation, recorder, voiceAt } = await tapThenVoice();

    clock.advance(53_000);
    await h.deliver([{ conversation, delaySeconds: 0 }], voiceAt);
    // As in the live log: no hand-off, the job runs on that one delivery.
    expect(recorder.calls.map((call) => call.kind)).toEqual(["interactive", "audio"]);
    expect(h.takeRingsFor(store.businessId)).toEqual([]);
    const mine = (event: string) => h.log.fields(event).filter((line) => line.businessId === store.businessId);
    expect(mine("conversation_handed_off")).toEqual([]);
    expect(mine("doorbell_received").at(-1)).toEqual({
      level: "warn",
      event: "doorbell_received",
      ...conversation,
      attempts: 1,
      latencyMs: 53_000,
      reason: "late",
    });
  });
});
