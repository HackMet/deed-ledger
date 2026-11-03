/**
 * The simulator's stand-in for WhatsApp's media download: `npm run chat` and `npm run qa` upload a
 * synthetic photo or voice note (`POST /dev/sim-media`), and the Worker downloads it back by the ID
 * it was given, as it would from Meta. Wired in only when the console runs in dev mode with no
 * WhatsApp token (the simulator), never in a deployed Worker. Uploads live under their own prefix,
 * apart from any store's media.
 */
import type { MediaBytes, MediaSource } from "../application/ports";

const PREFIX = "sim-uploads/";
const SIM_ID = /^sim-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Photos and voice notes only, and no larger than WhatsApp's own media. */
const TYPES = new Set(["image/jpeg", "image/png", "audio/ogg; codecs=opus", "audio/ogg"]);
export const MAX_SIM_MEDIA_BYTES = 16 * 1024 * 1024;

export class SimMediaSource implements MediaSource {
  constructor(private readonly bucket: R2Bucket) {}

  async fetch(ref: { readonly providerMediaId: string }): Promise<MediaBytes | null> {
    if (!SIM_ID.test(ref.providerMediaId)) return null;
    const object = await this.bucket.get(`${PREFIX}${ref.providerMediaId}`);
    if (object === null) return null;
    return { bytes: await object.arrayBuffer(), contentType: object.httpMetadata?.contentType ?? "application/octet-stream" };
  }

  /** Keeps an upload and returns its media ID; null for a type or size the channel wouldn't send. */
  async upload(contentType: string, bytes: ArrayBuffer): Promise<string | null> {
    if (!TYPES.has(contentType) || bytes.byteLength === 0 || bytes.byteLength > MAX_SIM_MEDIA_BYTES) return null;
    const id = `sim-${crypto.randomUUID()}`;
    await this.bucket.put(`${PREFIX}${id}`, bytes, { httpMetadata: { contentType } });
    return id;
  }
}
