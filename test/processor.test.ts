import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { placeholderHandler } from "../src/application/placeholder-handler";
import type { JobHandler, JobInput } from "../src/application/ports";
import { processConversation } from "../src/application/processor";
import { RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { bytes } from "./helpers/fakes";
import { expireLease, type Harness, harness, OUTLIVES_TEST_MS, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { imageMessage, textMessage, wamid, webhook } from "./helpers/whatsapp";

const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

/** Wraps the placeholder handler and records the order and lease of every call. */
function recordingHandler(onCall?: (input: JobInput, call: number) => Promise<void>) {
  const calls: Array<{ text: string | null; leaseId: string; kind: string }> = [];
  const handler: JobHandler = {
    async handle(input) {
      calls.push({ text: input.job.textBody, leaseId: input.lease.leaseId, kind: input.job.kind });
      await onCall?.(input, calls.length);
      return placeholderHandler.handle(input);
    },
  };
  return { handler, calls };
}

async function storeWithOwner() {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  return { store, phone };
}

async function outboxBodies(businessId: string): Promise<string[]> {
  return (
    await rows<{ body_text: string }>(
      `SELECT body_text FROM outbound_messages WHERE business_id = ? ORDER BY created_at_ms, body_text`,
      businessId,
    )
  ).map((row) => row.body_text);
}

describe("a burst in one conversation", () => {
  it("settles, then is processed in provider-timestamp order under one lease, with one reply", async () => {
    const recorder = recordingHandler();
    const h = harness({ jobHandler: recorder.handler });
    const { store, phone } = await storeWithOwner();
    const t = nowS(h);

    // Three photos and a correction within five seconds, delivered out of order by the provider.
    const send = async (message: unknown) => {
      expect((await h.post(webhook(store.phoneNumberId, { messages: [message] }))).status).toBe(200);
      h.clock.advance(1_000);
    };
    await send(imageMessage({ from: phone, id: wamid(), timestampS: t + 1, mediaId: "m-2", caption: "foto 2" }));
    await send(imageMessage({ from: phone, id: wamid(), timestampS: t, mediaId: "m-1", caption: "foto 1" }));
    await send(textMessage({ from: phone, id: wamid(), timestampS: t + 4, body: "la leche son 10, no 12" }));
    await send(imageMessage({ from: phone, id: wamid(), timestampS: t + 2, mediaId: "m-3", caption: "foto 3" }));

    // The newest message is 1 s old: too soon. The consumer re-rings with a delay and writes nothing.
    const early = h.doorbell.take();
    expect(early).toHaveLength(4);
    await h.deliver(early.slice(0, 1));
    const [settle] = h.doorbell.take();
    expect(settle?.delaySeconds).toBe(2);
    expect(recorder.calls).toEqual([]);

    // Once settled, one consumer processes everything in provider order, under one lease.
    h.clock.advance(2_000);
    await h.deliver([settle!, ...early.slice(1)]);
    expect(recorder.calls.map((call) => call.text)).toEqual(["foto 1", "foto 2", "foto 3", "la leche son 10, no 12"]);
    expect(new Set(recorder.calls.map((call) => call.leaseId)).size).toBe(1);

    const jobs = await rows<{ job_state: string; attempts: number; job_lease_id: string }>(
      `SELECT job_state, attempts, job_lease_id FROM inbound_messages WHERE business_id = ?`,
      store.businessId,
    );
    expect(jobs.map((job) => [job.job_state, job.attempts])).toEqual(Array(4).fill(["done", 1]));
    expect(new Set(jobs.map((job) => job.job_lease_id))).toEqual(new Set([recorder.calls[0]!.leaseId]));

    // One placeholder reply for the burst, sent once.
    expect(await outboxBodies(store.businessId)).toEqual([RECEIVED_PLACEHOLDER]);
    expect(h.channel.sent.map((sent) => [sent.toPhone, sent.body])).toEqual([[phone, RECEIVED_PLACEHOLDER]]);

    // The lease is released.
    const [conversation] = await rows<{ lease_id: string | null }>(
      `SELECT lease_id FROM conversations WHERE business_id = ?`,
      store.businessId,
    );
    expect(conversation?.lease_id).toBeNull();
  });

  it("stores each photo in R2 under the store's prefix, at an immutable content key", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    await h.post(webhook(store.phoneNumberId, { messages: [imageMessage({ from: phone, id: wamid(), timestampS: nowS(h), mediaId: "m-r2" })] }));
    h.clock.advance(4_000);
    await h.deliver();

    const [asset] = await rows<{ id: string; object_key: string; stored_key: string; content_sha256: string; state: string; byte_size: number }>(
      `SELECT id, object_key, stored_key, content_sha256, state, byte_size FROM media_assets WHERE business_id = ?`,
      store.businessId,
    );
    expect(asset?.state).toBe("stored");
    expect(asset?.object_key).toBe(`stores/${store.businessId}/media/${asset?.id}`);
    expect(asset?.stored_key).toBe(`${asset?.object_key}/${asset?.content_sha256}`);
    const object = await env.MEDIA.get(asset!.stored_key);
    expect(object?.size).toBe(asset?.byte_size);
    const listed = await env.MEDIA.list({ prefix: `stores/${store.businessId}/` });
    expect(listed.objects.map((o) => o.key)).toEqual([asset!.stored_key]);
  });

  it("refuses a media prefix outside the store's prefix", async () => {
    const h = harness();
    await expect(h.deps.mediaStore.putImmutable({ businessId: "store-a" }, "stores/store-b/media/x", bytes("x"))).rejects.toThrow(
      "outside the store's prefix",
    );
  });
});

describe("leases", () => {
  it("a second consumer finds the lease busy, re-rings and writes nothing", async () => {
    let second: Promise<string> | undefined;
    const h: Harness = harness({
      jobHandler: {
        async handle(input) {
          second ??= processConversation(h.deps, input.lease);
          await second;
          return placeholderHandler.handle(input);
        },
      },
    });
    const { store, phone } = await storeWithOwner();
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
    h.clock.advance(4_000);
    await h.deliver();
    expect(await second).toBe("busy");
    expect(h.doorbell.take().map((ring) => ring.delaySeconds)).toEqual([3]);
    expect(await outboxBodies(store.businessId)).toEqual([RECEIVED_PLACEHOLDER]);
  });

  it("fences writes: a consumer whose lease was taken over can't complete the job or reply", async () => {
    let competitor: Promise<string> | undefined;
    const recorder = recordingHandler(async (input, call) => {
      if (call !== 1) return;
      // Consumer A stalls past its lease; consumer B takes the conversation over and finishes it.
      await expireLease(input.lease.conversationId);
      competitor = processConversation(h.deps, input.lease);
      await competitor;
    });
    const h: Harness = harness({
      jobHandler: {
        async handle(input) {
          const outcome = await recorder.handler.handle(input);
          // A, back from its stall, tries to write a second reply that only the fence can stop.
          return recorder.calls.length === 2 && input.lease.leaseId === recorder.calls[0]!.leaseId
            ? { replies: [...outcome.replies, { body: "respuesta tardía", ttlMs: OUTLIVES_TEST_MS }] }
            : outcome;
        },
      },
    });
    const { store, phone } = await storeWithOwner();
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
    h.clock.advance(4_000);
    const result = await h.deliver();

    expect(await competitor).toBe("processed");
    expect(result?.explicitAcks).toHaveLength(1);
    expect(h.log.fields("stale_write_refused").map((line) => line.reason)).toEqual(["lease_lost"]);
    const [leaseA, leaseB] = recorder.calls.map((call) => call.leaseId);
    expect(leaseA).not.toBe(leaseB);

    // Exactly one completion and one reply: B's. A's writes were refused.
    const [job] = await rows<{ job_state: string; attempts: number; job_lease_id: string }>(
      `SELECT job_state, attempts, job_lease_id FROM inbound_messages WHERE business_id = ?`,
      store.businessId,
    );
    expect(job).toEqual({ job_state: "done", attempts: 2, job_lease_id: leaseB });
    expect(await outboxBodies(store.businessId)).toEqual([RECEIVED_PLACEHOLDER]);
    expect(await rows(`SELECT guard_id FROM batch_guards`)).toEqual([]);
  });

  it("fences writes after expiry even when nobody took the lease over", async () => {
    const h: Harness = harness({
      jobHandler: {
        async handle(input) {
          await expireLease(input.lease.conversationId);
          return placeholderHandler.handle(input);
        },
      },
    });
    const { store, phone } = await storeWithOwner();
    await h.post(webhook(store.phoneNumberId, { messages: [textMessage({ from: phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
    h.clock.advance(4_000);
    await h.deliver();

    expect(h.log.fields("stale_write_refused").map((line) => line.reason)).toEqual(["lease_lost"]);
    const [job] = await rows<{ job_state: string; attempts: number }>(
      `SELECT job_state, attempts FROM inbound_messages WHERE business_id = ?`,
      store.businessId,
    );
    expect(job).toEqual({ job_state: "processing", attempts: 1 }); // left for the sweep to retry
    expect(await outboxBodies(store.businessId)).toEqual([]);
  });

  it("ignores a doorbell that pairs one store with another store's conversation", async () => {
    const h = harness();
    const a = await storeWithOwner();
    const b = await storeWithOwner();
    await h.post(webhook(b.store.phoneNumberId, { messages: [textMessage({ from: b.phone, id: wamid(), timestampS: nowS(h), body: "Hola" })] }));
    const [ring] = h.doorbell.take();
    h.clock.advance(4_000);

    await h.deliver([{ conversation: { businessId: a.store.businessId, conversationId: ring!.conversation.conversationId }, delaySeconds: 0 }]);
    expect(h.log.events()).toContain("doorbell_for_missing_conversation");
    const [job] = await rows<{ job_state: string }>(`SELECT job_state FROM inbound_messages WHERE business_id = ?`, b.store.businessId);
    expect(job?.job_state).toBe("pending");
    expect(h.channel.sent).toEqual([]);
  });
});
