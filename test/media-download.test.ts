import { describe, expect, it } from "vitest";
import { UnreadableMediaError } from "../src/application/errors";
import { MAX_MEDIA_BYTES, MediaDownloadError, MEDIA_DOWNLOAD_TIMEOUT_MS, WhatsAppMediaSource } from "../src/integrations/whatsapp/media";

const TOKEN = "test-whatsapp-token-not-real";
const SIGNED_URL = "https://lookaside.example.test/whatsapp_business/attachments/?mid=synthetic&hash=secret-ish";
const REF = { providerMediaId: "1234567890", phoneNumberId: "555000111" };
const BODY = "voice bytes";
/** SHA-256 of BODY, hex and base64. */
const BODY_SHA256_HEX = "488a250f46f73a5447579e25f7ecf6b64b60f7d31fa716a922ae325a4c38fb95";
const BODY_SHA256_BASE64 = "SIolD0b3OlRHV54l9+z2tktg99MfpxapIq4yWkw4+5U=";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** Recorded-style responses shaped as Meta documents them; every value is synthetic. */
function lookupResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({
    messaging_product: "whatsapp",
    url: SIGNED_URL,
    mime_type: "audio/ogg",
    sha256: BODY_SHA256_HEX,
    file_size: BODY.length,
    id: REF.providerMediaId,
    ...overrides,
  });
}

function source(respond: (call: Call, n: number) => Response | Promise<Response>, options: { token?: string; maxBytes?: number } = {}) {
  const calls: Call[] = [];
  const media = new WhatsAppMediaSource({
    token: options.token ?? TOKEN,
    apiVersion: "v26.0",
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return respond(call, calls.length);
    },
  });
  return { media, calls };
}

const auth = (call: Call) => (call.init.headers as Record<string, string>).authorization;

describe("WhatsApp media download", () => {
  it("looks the media up, then downloads the bytes from the URL it got, both with the token", async () => {
    const { media, calls } = source((_call, n) =>
      n === 1 ? lookupResponse() : new Response(BODY, { headers: { "content-type": "audio/ogg" } }),
    );
    const result = await media.fetch(REF);
    expect(new TextDecoder().decode(result!.bytes)).toBe(BODY);
    expect(result!.contentType).toBe("audio/ogg");

    expect(calls.map((call) => call.url)).toEqual([
      "https://graph.facebook.com/v26.0/1234567890?phone_number_id=555000111",
      SIGNED_URL,
    ]);
    for (const call of calls) {
      expect(call.init.method).toBe("GET");
      expect(auth(call)).toBe(`Bearer ${TOKEN}`);
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(MEDIA_DOWNLOAD_TIMEOUT_MS).toBe(15_000);
  });

  it("asks for a fresh URL on every call, since one lasts only 5 minutes", async () => {
    const { media, calls } = source((call) => (call.url.startsWith("https://graph.facebook.com/") ? lookupResponse() : new Response(BODY)));
    await media.fetch(REF);
    await media.fetch(REF);
    expect(calls.map((call) => call.url.startsWith("https://graph.facebook.com/"))).toEqual([true, false, true, false]);
  });

  it("uses the lookup's MIME type when the download has none", async () => {
    const { media } = source((_call, n) => {
      if (n === 1) return lookupResponse({ mime_type: "image/jpeg" });
      const response = new Response(new TextEncoder().encode(BODY));
      response.headers.delete("content-type");
      return response;
    });
    expect((await media.fetch(REF))!.contentType).toBe("image/jpeg");
  });

  it("returns nothing, and calls nobody, without a token", async () => {
    const { media, calls } = source(() => lookupResponse(), { token: "" });
    expect(await media.fetch(REF)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("refuses a file the lookup says is too big, before downloading it", async () => {
    const { media, calls } = source(() => lookupResponse({ file_size: MAX_MEDIA_BYTES + 1 }));
    await expect(media.fetch(REF)).rejects.toMatchObject({ code: "too_large" });
    expect(calls).toHaveLength(1);
  });

  it("stops reading a download that grows past the limit, with or without Content-Length", async () => {
    const big = new Uint8Array(64);
    const declared = source((_call, n) => (n === 1 ? lookupResponse({ file_size: null }) : new Response(big)), { maxBytes: 32 });
    await expect(declared.media.fetch(REF)).rejects.toMatchObject({ code: "too_large" });

    const streamed = source(
      (_call, n) => {
        if (n === 1) return lookupResponse({ file_size: undefined });
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(16)); // never ends on its own
          },
        });
        return new Response(body);
      },
      { maxBytes: 32 },
    );
    await expect(streamed.media.fetch(REF)).rejects.toMatchObject({ code: "too_large" });
  });

  it.each([
    ["the lookup fails", (n: number) => (n === 1 ? new Response("{}", { status: 401 }) : new Response("x")), "lookup_http_401"],
    ["the URL expired", (n: number) => (n === 1 ? lookupResponse() : new Response("", { status: 404 })), "download_http_404"],
    ["the lookup isn't JSON", (n: number) => (n === 1 ? new Response("<html>") : new Response("x")), "lookup_unexpected_response"],
    ["the URL isn't https", (n: number) => (n === 1 ? lookupResponse({ url: "http://plain.example.test/x" }) : new Response("x")), "lookup_unexpected_response"],
  ])("throws a content-free error when %s", async (_label, respond, code) => {
    const { media, calls } = source((_call, n) => respond(n));
    const failure = media.fetch(REF);
    await expect(failure).rejects.toBeInstanceOf(MediaDownloadError);
    await expect(failure).rejects.toMatchObject({ code, message: `media download failed: ${code}` });
    // Never sends the token anywhere but https.
    expect(calls.every((call) => call.url.startsWith("https://"))).toBe(true);
  });

  it("reports timeouts per step, never with the URL or the token in the error", async () => {
    const { media } = source((_call, n) => {
      if (n === 1) return lookupResponse();
      throw new DOMException("timed out", "TimeoutError");
    });
    const error = await media.fetch(REF).catch((e: unknown) => e as MediaDownloadError);
    expect(error).toMatchObject({ name: "MediaDownloadError", code: "download_timeout" });
    expect(String(error)).not.toContain("lookaside");
    expect(String(error)).not.toContain(TOKEN);
  });
});

describe("WhatsApp media download completeness (#27)", () => {
  // WhatsApp voice notes don't end with an Ogg end-of-stream page, so the audio reader can't tell a
  // cut-off note from a whole one: the download checks the bytes against what Meta declared.
  const download = (lookup: Record<string, unknown>, body: string) =>
    source((_call, n) => (n === 1 ? lookupResponse(lookup) : new Response(body))).media.fetch(REF);

  it.each([
    ["hex", BODY_SHA256_HEX],
    ["upper-case hex", BODY_SHA256_HEX.toUpperCase()],
    ["base64", BODY_SHA256_BASE64],
  ])("accepts bytes whose SHA-256 and size match the lookup's (%s hash)", async (_label, sha256) => {
    const result = await download({ sha256, file_size: String(BODY.length) }, BODY);
    expect(new TextDecoder().decode(result!.bytes)).toBe(BODY);
  });

  it.each([
    ["the hash doesn't match", { sha256: BODY_SHA256_HEX.replace(/^4/, "5") }, BODY],
    ["the base64 hash doesn't match", { sha256: BODY_SHA256_BASE64.replace(/^S/, "T") }, BODY],
    ["the body is shorter than file_size", { sha256: undefined, file_size: BODY.length }, BODY.slice(0, -3)],
    ["the body is longer than file_size", { sha256: undefined, file_size: BODY.length }, `${BODY}!`],
    ["the hash matches but file_size doesn't", { file_size: BODY.length + 5 }, BODY],
  ])("refuses the download as incomplete, retryable, when %s", async (_label, lookup, body) => {
    const error = await download(lookup, body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaDownloadError);
    expect(error).toMatchObject({ code: "incomplete", message: "media download failed: incomplete" });
    // Not an UnreadableMediaError: the processor retries it with backoff, like a timeout.
    expect(error).not.toBeInstanceOf(UnreadableMediaError);
  });

  it("accepts the bytes as before when Meta declares neither a hash nor a size", async () => {
    const blanks = [{ sha256: undefined, file_size: undefined }, { sha256: null, file_size: null }, { sha256: "", file_size: "" }];
    for (const lookup of blanks) {
      const result = await download(lookup, "any length at all");
      expect(new TextDecoder().decode(result!.bytes)).toBe("any length at all");
    }
  });

  it("ignores a hash it can't read as SHA-256 (hex or base64) but still checks the size", async () => {
    expect(await download({ sha256: "c3ludGhldGlj" }, BODY)).not.toBeNull();
    await expect(download({ sha256: "c3ludGhldGlj" }, BODY.slice(1))).rejects.toMatchObject({ code: "incomplete" });
  });
});
