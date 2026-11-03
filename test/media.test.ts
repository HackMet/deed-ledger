import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processConversation } from "../src/application/processor";
import { COULD_NOT_OPEN_MEDIA, couldNotDownload, RECEIVED_PLACEHOLDER } from "../src/domain/copy";
import { bytes, FakeMediaSource } from "./helpers/fakes";
import { conversationOf, expireLease, type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedIntroducedCustomer, seedStore } from "./helpers/seed";
import { imageMessage, wamid, webhook } from "./helpers/whatsapp";

const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

async function storeWithOwner() {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  return { store, phone };
}

async function assetOf(businessId: string) {
  const [asset] = await rows<{ state: string; object_key: string; stored_key: string | null }>(
    `SELECT state, object_key, stored_key FROM media_assets WHERE business_id = ?`,
    businessId,
  );
  return asset!;
}

describe("media downloads", () => {
  it("can't be overwritten by a stale consumer after a takeover during the download (F3)", async () => {
    const { store, phone } = await storeWithOwner();
    // A returning customer, already introduced (#30): this test counts replies.
    await seedIntroducedCustomer(store, phone);
    const media = new FakeMediaSource();
    let competitor: Promise<string> | undefined;
    let h!: Harness;
    media.respond = async (_id, call) => {
      if (call === 1) {
        // Consumer A is mid-download: its lease expires and consumer B takes over and finishes.
        const conversation = await conversationOf(store.businessId);
        await expireLease(conversation.conversationId);
        competitor = processConversation(h.deps, conversation);
        await competitor;
        return bytes("bytes downloaded by A, late");
      }
      return bytes("bytes downloaded by B");
    };
    h = harness({ mediaSource: media });
    await h.post(webhook(store.phoneNumberId, { messages: [imageMessage({ from: phone, id: wamid(), timestampS: nowS(h), mediaId: "m-race" })] }));
    h.clock.advance(4_000);
    await h.deliver();

    expect(await competitor).toBe("processed");
    expect(h.log.fields("stale_write_refused").map((line) => line.reason)).toEqual(["lease_lost"]);
    const asset = await assetOf(store.businessId);
    expect(asset.state).toBe("stored");
    // What B published is still B's bytes; A's late write went to a different, unpublished key.
    expect(await (await env.MEDIA.get(asset.stored_key!))?.text()).toBe("bytes downloaded by B");
    const keys = (await env.MEDIA.list({ prefix: `${asset.object_key}/` })).objects.map((o) => o.key);
    expect(keys).toContain(asset.stored_key);
    expect(h.sentTo(phone)).toEqual([RECEIVED_PLACEHOLDER]);
  });

  it("keeps the job open with backoff when the download fails, then fails it visibly (F6)", async () => {
    const media = new FakeMediaSource();
    media.respond = async () => null; // nothing to download
    const h = harness({ mediaSource: media });
    const { store, phone } = await storeWithOwner();
    await h.post(webhook(store.phoneNumberId, { messages: [imageMessage({ from: phone, id: wamid(), timestampS: nowS(h), mediaId: "m-gone" })] }));
    h.clock.advance(4_000);

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.deliver(h.takeRingsFor(store.businessId).slice(0, 1));
      const [job] = await rows<{ job_state: string; attempts: number }>(
        `SELECT job_state, attempts FROM inbound_messages WHERE business_id = ?`,
        store.businessId,
      );
      expect(job?.attempts).toBe(attempt);
      expect(job?.job_state).toBe(attempt < 3 ? "pending" : "failed"); // never "done" with no media
      delays.push(...h.ringsFor(store.businessId).map((ring) => ring.delaySeconds));
      h.clock.advance(60_000);
    }
    expect(delays).toEqual([5, 10]);
    expect(media.fetched).toEqual(["m-gone", "m-gone", "m-gone"]);
    expect((await assetOf(store.businessId)).state).toBe("pending");
    expect(h.sentTo(phone)).toEqual([couldNotDownload("image")]);
    expect(couldNotDownload("image")).toBe("No pude descargar la foto. ¿Me la mandás otra vez o me escribís lo que necesitás?");
  });

  it("treats a download that throws the same way", async () => {
    const media = new FakeMediaSource();
    media.respond = async (_id, call) => {
      if (call === 1) throw new Error("connection reset");
      return bytes("ok");
    };
    const h = harness({ mediaSource: media });
    const { store, phone } = await storeWithOwner();
    await h.post(webhook(store.phoneNumberId, { messages: [imageMessage({ from: phone, id: wamid(), timestampS: nowS(h), mediaId: "m-y" })] }));
    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
    expect(await rows(`SELECT job_state, attempts FROM inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([
      { job_state: "pending", attempts: 1 },
    ]);
    h.clock.advance(5_000);
    await h.deliver(h.takeRingsFor(store.businessId).slice(0, 1));
    expect(await rows(`SELECT job_state, attempts FROM inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([
      { job_state: "done", attempts: 2 },
    ]);
    expect((await assetOf(store.businessId)).state).toBe("stored");
  });

  it("ends a photo without a usable media ID with an honest reply, never the received placeholder (G7)", async () => {
    const media = new FakeMediaSource();
    const h = harness({ mediaSource: media });
    const { store, phone } = await storeWithOwner();
    const { id: _missing, ...image } = imageMessage({ from: phone, id: wamid(), timestampS: nowS(h), mediaId: "unused" }).image;
    const photo = { from: phone, id: wamid(), timestamp: String(nowS(h)), type: "image", image };
    await h.post(webhook(store.phoneNumberId, { messages: [photo] }));

    // Stored without an asset.
    expect(await rows(`SELECT kind, media_asset_id FROM inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([
      { kind: "image", media_asset_id: null },
    ]);
    expect(await rows(`SELECT 1 FROM media_assets WHERE business_id = ?`, store.businessId)).toEqual([]);

    h.clock.advance(4_000);
    await h.deliver(h.takeRingsFor(store.businessId));
    expect(await rows(`SELECT job_state, attempts, last_error FROM inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([
      { job_state: "failed", attempts: 1, last_error: "media_missing" },
    ]);
    expect(media.fetched).toEqual([]);
    expect(h.sentTo(phone)).toEqual([COULD_NOT_OPEN_MEDIA]);
    expect(COULD_NOT_OPEN_MEDIA).toBe("No pude abrir ese archivo. ¿Me lo mandás otra vez o me escribís lo que necesitás?");
  });
});
