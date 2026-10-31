import { describe, expect, it } from "vitest";
import { MAX_MEDIA_BYTES, MediaDownloadError, MEDIA_DOWNLOAD_TIMEOUT_MS, WhatsAppMediaSource } from "../src/integrations/whatsapp/media";

const TOKEN = "test-whatsapp-token-not-real";
const SIGNED_URL = "https://lookaside.example.test/whatsapp_business/attachments/?mid=synthetic&hash=secret-ish";
const REF = { providerMediaId: "1234567890", phoneNumberId: "555000111" };

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
    sha256: "c3ludGhldGlj",
    file_size: 11,
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
      n === 1 ? lookupResponse() : new Response("voice bytes", { headers: { "content-type": "audio/ogg" } }),
    );
    const result = await media.fetch(REF);
    expect(new TextDecoder().decode(result!.bytes)).toBe("voice bytes");
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
    const { media, calls } = source((call) => (call.url.startsWith("https://graph.facebook.com/") ? lookupResponse() : new Response("x")));
    await media.fetch(REF);
    await media.fetch(REF);
    expect(calls.map((call) => call.url.startsWith("https://graph.facebook.com/"))).toEqual([true, false, true, false]);
  });

  it("uses the lookup's MIME type when the download has none", async () => {
    const { media } = source((_call, n) => {
      if (n === 1) return lookupResponse({ mime_type: "image/jpeg" });
      const response = new Response(new Uint8Array([1, 2, 3]));
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
