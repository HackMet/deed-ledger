/**
 * Downloads a message's media from the WhatsApp Cloud API, as Meta documents it (checked October
 * 30, 2026): https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
 *
 * 1. GET /<version>/<MEDIA_ID>?phone_number_id=<id> with `Authorization: Bearer <token>` returns
 *    JSON with `url`, `mime_type`, `sha256`, `file_size` and `id`. The URL is valid for 5 minutes.
 * 2. GET that URL with the same Authorization header returns the bytes, with the MIME type in
 *    Content-Type. A failed download answers 404; the fix is a new URL from step 1.
 *
 * Every call does both steps, so a retry never reuses an expired URL. Webhook media IDs expire
 * after 7 days. Errors carry a short code only: never the URL (it is a credential while it lasts)
 * or response text.
 *
 * The bytes must match the `file_size` and `sha256` the lookup declares, or the download is
 * `incomplete` and retried like a timeout. This is what keeps a cut-off voice note from being
 * transcribed: WhatsApp voice notes don't end with an Ogg end-of-stream page (#27), so the audio
 * reader can't tell a note cut on a page boundary from a whole one.
 *
 * Never called by the default test run: tests pass a fake fetch or a fake MediaSource.
 */
import type { MediaBytes, MediaSource } from "../../application/ports";

/** Each of the two requests is abandoned after this. */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;
/**
 * The largest download accepted. Meta's limits for media are 16 MB for audio and 5 MB for images;
 * anything bigger is refused before its bytes are read.
 */
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export interface WhatsAppMediaOptions {
  readonly token: string;
  readonly apiVersion: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
}

export class MediaDownloadError extends Error {
  override name = "MediaDownloadError";

  constructor(readonly code: string) {
    super(`media download failed: ${code}`);
  }
}

export class WhatsAppMediaSource implements MediaSource {
  constructor(private readonly options: WhatsAppMediaOptions) {}

  async fetch(ref: { readonly providerMediaId: string; readonly phoneNumberId: string }): Promise<MediaBytes | null> {
    // Without a token nothing can be fetched now: the job retries, then fails visibly.
    if (this.options.token === "") return null;
    const maxBytes = this.options.maxBytes ?? MAX_MEDIA_BYTES;

    const lookupUrl =
      `https://graph.facebook.com/${encodeURIComponent(this.options.apiVersion)}/${encodeURIComponent(ref.providerMediaId)}` +
      `?phone_number_id=${encodeURIComponent(ref.phoneNumberId)}`;
    const lookup = await this.get(lookupUrl, "lookup");
    const info = readMediaInfo(await lookup.json().catch(() => null));
    if (info.fileSize !== null && info.fileSize > maxBytes) throw new MediaDownloadError("too_large");

    const download = await this.get(info.url, "download");
    const declared = Number(download.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await download.body?.cancel();
      throw new MediaDownloadError("too_large");
    }
    const bytes = await readCapped(download, maxBytes);
    await verifyComplete(bytes, info);
    const contentType = download.headers.get("content-type") ?? info.mimeType ?? "application/octet-stream";
    return { bytes, contentType };
  }

  private async get(url: string, step: "lookup" | "download"): Promise<Response> {
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.options.token}` },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new MediaDownloadError(`${step}_${timedOut ? "timeout" : "network_error"}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaDownloadError(`${step}_http_${response.status}`);
    }
    return response;
  }
}

interface MediaInfo {
  readonly url: string;
  readonly mimeType: string | null;
  readonly fileSize: number | null;
  /** The declared SHA-256 of the file, as 32 bytes. */
  readonly sha256: Uint8Array | null;
}

function readMediaInfo(body: unknown): MediaInfo {
  if (typeof body !== "object" || body === null) throw new MediaDownloadError("lookup_unexpected_response");
  const { url, mime_type: mimeType, file_size: fileSize, sha256 } = body as Record<string, unknown>;
  // The token goes with the download, so only an https URL is followed.
  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new MediaDownloadError("lookup_unexpected_response");
  }
  return {
    url,
    mimeType: typeof mimeType === "string" && mimeType !== "" ? mimeType : null,
    fileSize: toSize(fileSize),
    sha256: toDigest(sha256),
  };
}

/** Refuses bytes that differ from the declared size or hash; without either, there is nothing to check. */
async function verifyComplete(bytes: ArrayBuffer, info: MediaInfo): Promise<void> {
  if (info.fileSize !== null && bytes.byteLength !== info.fileSize) throw new MediaDownloadError("incomplete");
  if (info.sha256 === null) return;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (!digest.every((byte, i) => byte === info.sha256![i])) throw new MediaDownloadError("incomplete");
}

/**
 * Meta's docs don't say how `sha256` is encoded, so a SHA-256 in hex (any case) or base64 is read.
 * Anything else isn't checked: refusing every download over a format we can't read would break all
 * media, and the size check still catches a cut-off body.
 */
function toDigest(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Uint8Array.from(value.match(/../g)!, (hex) => parseInt(hex, 16));
  if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) return Uint8Array.from(atob(value.padEnd(44, "=")), (char) => char.charCodeAt(0));
  return null;
}

function toSize(value: unknown): number | null {
  // Number("") is 0, which the completeness check would hold every download to.
  const size = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : null;
}

/** Reads the body, refusing it as soon as it grows past the limit (Content-Length can be absent). */
async function readCapped(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (response.body === null) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new MediaDownloadError("too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}
