import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { JobHandler, MediaBytes, Transcriber, TranscriberAudio } from "../src/application/ports";
import { transcribeVoiceNote, VoiceNoteError } from "../src/application/voice-note";
import { couldNotProcess } from "../src/domain/copy";
import { R2MediaStore } from "../src/infrastructure/r2-media-store";
import {
  AudioTooLargeError,
  AudioTooLongError,
  MAX_VOICE_NOTE_BYTES,
  MAX_VOICE_NOTE_MS,
  OggOpusError,
  OpusAudioDecoder,
} from "../src/integrations/audio";
import { maxOpusPackets, readOggOpus } from "../src/integrations/audio/ogg";
import { MuseVoiceTranscriber, TRANSCRIBE_URL, TranscriptionError } from "../src/integrations/meta/transcribe";
import { oggOpus, toneOgg } from "./fixtures/audio";
import { FakeMediaSource } from "./helpers/fakes";
import { type Harness, harness, rows } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { audioMessage, wamid, webhook } from "./helpers/whatsapp";

const ogg = (bytes: Uint8Array): MediaBytes => ({ bytes: bytes.slice().buffer as ArrayBuffer, contentType: "audio/ogg; codecs=opus" });

/** Shaped like the documented response (https://dev.meta.ai/docs/speech-to-text); the text is invented. */
const RECORDED_RESPONSE = {
  sessionId: "session-synthetic-1",
  transcript: "Quiero dos libras de azúcar y un aceite.",
  audioDurationMs: 1000,
  turns: [],
};

function readWav(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  return {
    riff: tag(0),
    wave: tag(8),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
    samples: new Int16Array(wav.slice(44).buffer),
  };
}

describe("voice note decoding", () => {
  const decoder = new OpusAudioDecoder();

  it("decodes OGG/Opus to 16 kHz mono 16-bit WAV with the sound intact", async () => {
    const { wav, durationMs } = await decoder.toTranscriberWav(ogg(toneOgg()));
    const parsed = readWav(wav);
    expect(parsed).toMatchObject({ riff: "RIFF", wave: "WAVE", format: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 });
    expect(parsed.dataBytes).toBe(wav.byteLength - 44);
    expect(durationMs).toBeGreaterThan(990);
    expect(durationMs).toBeLessThan(1010);
    // A 440 Hz sine crosses zero about 880 times a second; silence or noise wouldn't.
    let crossings = 0;
    let energy = 0;
    const middle = parsed.samples.subarray(1600, 14400); // 0.1 s to 0.9 s
    for (let i = 1; i < middle.length; i++) {
      if ((middle[i - 1]! < 0) !== (middle[i]! < 0)) crossings++;
      energy += middle[i]! * middle[i]!;
    }
    expect(crossings / 0.8).toBeGreaterThan(860);
    expect(crossings / 0.8).toBeLessThan(900);
    expect(Math.sqrt(energy / middle.length)).toBeGreaterThan(1000);
  });

  it("refuses a file cut off mid-way instead of returning part of it", async () => {
    const full = toneOgg();
    await expect(decoder.toTranscriberWav(ogg(full.subarray(0, Math.floor(full.length / 2))))).rejects.toBeInstanceOf(OggOpusError);
  });

  it("refuses a note cut right after a complete page, before its end-of-stream page", async () => {
    const full = toneOgg();
    const ends = pageEnds(full);
    expect(ends.at(-1)).toBe(full.length);
    // The second-to-last page ends a packet and isn't the last: alone, it looks like a whole file.
    const cut = full.subarray(0, ends.at(-2)!);
    expect(lastLacing(cut)).toBeLessThan(255);
    await expect(decoder.toTranscriberWav(ogg(cut))).rejects.toThrow(
      expect.objectContaining({ name: "OggOpusError", message: "the file ends before the end of the stream" }),
    );
    // The same packets, written without the end-of-stream flag, are refused too.
    const packet = new Uint8Array([16 << 3]); // one 2.5 ms CELT frame
    expect(() => readOggOpus(oggOpus([packet, packet], { endOfStream: false }), 10)).toThrow(OggOpusError);
    expect(readOggOpus(oggOpus([packet, packet]), 10).packets).toHaveLength(2);
  });

  it("refuses more audio packets than a 10-minute note can hold, while reading them", async () => {
    // 2.5 ms is the shortest Opus packet: 10 minutes is at most 240,000 of them.
    const cap = maxOpusPackets(MAX_VOICE_NOTE_MS);
    expect(cap).toBe(240_000);
    const packet = new Uint8Array([16 << 3]); // one 2.5 ms CELT frame, 1 byte: about 0.5 MB in all
    expect(readOggOpus(oggOpus(Array.from({ length: cap }, () => packet)), cap).packets).toHaveLength(cap);
    const over = oggOpus(Array.from({ length: cap + 1 }, () => packet));
    // Refused by the reader (OggOpusError), not later by the duration check (AudioTooLongError).
    await expect(decoder.toTranscriberWav(ogg(over))).rejects.toThrow(
      expect.objectContaining({ name: "OggOpusError", message: "more audio packets than allowed" }),
    );
  });

  it.each([
    ["empty", new Uint8Array(0)],
    ["a code 3 packet without its frame count", new Uint8Array([(16 << 3) | 3])],
    ["a code 3 packet with zero frames", new Uint8Array([(16 << 3) | 3, 0])],
    ["a packet longer than 120 ms", new Uint8Array([(3 << 3) | 3, 3])], // three 60 ms frames
  ])("refuses an invalid audio packet: %s", async (_name, bad) => {
    const good = new Uint8Array([16 << 3]);
    await expect(decoder.toTranscriberWav(ogg(oggOpus([good, bad, good])))).rejects.toThrow(
      expect.objectContaining({ name: "OggOpusError", message: "an invalid Opus packet" }),
    );
  });

  it("refuses bytes that aren't Ogg Opus", async () => {
    await expect(decoder.toTranscriberWav(ogg(new TextEncoder().encode("\xff\xd8 not audio at all")))).rejects.toBeInstanceOf(
      OggOpusError,
    );
  });

  it("refuses audio over 10 minutes before decoding it", async () => {
    // 5,500 packets of two 60 ms SILK frames each: 11 minutes, claimed by the packets' own headers.
    const packet = new Uint8Array([(3 << 3) | 1, 0, 0]);
    const eleven = oggOpus(
      Array.from({ length: 5_500 }, () => packet),
      { samples48kPerPacket: 5_760 },
    );
    await expect(decoder.toTranscriberWav(ogg(eleven))).rejects.toBeInstanceOf(AudioTooLongError);
  });

  it("refuses a file over the size limit without reading it", async () => {
    const huge: MediaBytes = { bytes: new ArrayBuffer(MAX_VOICE_NOTE_BYTES + 1), contentType: "audio/ogg" };
    await expect(decoder.toTranscriberWav(huge)).rejects.toBeInstanceOf(AudioTooLargeError);
  });
});

/** Where each Ogg page ends, walking the page headers. */
function pageEnds(bytes: Uint8Array): number[] {
  const ends: number[] = [];
  for (let at = 0; at < bytes.length; ) {
    const segments = bytes[at + 26]!;
    let body = 0;
    for (let i = 0; i < segments; i++) body += bytes[at + 27 + i]!;
    at += 27 + segments + body;
    ends.push(at);
  }
  return ends;
}

/** The last lacing value of the last page: under 255 means the page ends a packet. */
function lastLacing(bytes: Uint8Array): number {
  const ends = pageEnds(bytes);
  const start = ends.length > 1 ? ends.at(-2)! : 0;
  return bytes[start + 27 + bytes[start + 26]! - 1]!;
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}

const audio = (): TranscriberAudio => ({ wav: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), durationMs: 1000 });

describe("Muse Voice Transcribe adapter", () => {
  it("sends the documented multipart request and reads the transcript", async () => {
    const { calls, fetch } = fakeFetch(() => Response.json(RECORDED_RESPONSE));
    const transcriber = new MuseVoiceTranscriber({ apiKey: "test-model-key-not-real", fetch });
    expect(await transcriber.transcribe(audio())).toEqual({ text: RECORDED_RESPONSE.transcript, audioDurationMs: 1000 });

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [Call];
    expect(url).toBe(TRANSCRIBE_URL);
    expect(url).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-model-key-not-real");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = init.body as FormData;
    const request = form.get("request") as File;
    expect(request.type).toBe("application/json");
    expect(JSON.parse(await request.text())).toEqual({
      mode: "PUSH_TO_TALK",
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      languageBias: ["Spanish"],
    });
    const sent = form.get("audio") as File;
    expect(sent.type).toBe("audio/wav");
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(audio().wav);
  });

  it("fails closed without a key, and never calls out", async () => {
    const { calls, fetch } = fakeFetch(() => Response.json(RECORDED_RESPONSE));
    await expect(new MuseVoiceTranscriber({ apiKey: "", fetch }).transcribe(audio())).rejects.toMatchObject({
      name: "TranscriptionError",
      code: "not_configured",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a *-contributor model ID", () => {
    const { fetch } = fakeFetch(() => Response.json(RECORDED_RESPONSE));
    expect(() => new MuseVoiceTranscriber({ apiKey: "k", model: "muse-voice-transcribe-1.0-contributor", fetch })).toThrow(
      /contributor/,
    );
  });

  it.each([
    ["a rate limit", () => new Response("slow down", { status: 429 }), "http_429"],
    ["a server error", () => new Response("budget", { status: 500 }), "http_500"],
    ["a bad request", () => new Response("not a WAV", { status: 400 }), "http_400"],
    ["a body that isn't JSON", () => new Response("<html>", { status: 200 }), "unexpected_response"],
    ["JSON without a transcript", () => Response.json({ sessionId: "s" }), "unexpected_response"],
  ])("turns %s into a content-free error", async (_label, respond, code) => {
    const { fetch } = fakeFetch(respond);
    const failure = new MuseVoiceTranscriber({ apiKey: "k", fetch }).transcribe(audio());
    await expect(failure).rejects.toBeInstanceOf(TranscriptionError);
    await expect(failure).rejects.toMatchObject({ code, message: `transcription failed: ${code}` });
  });

  it("reports a timeout and a dropped connection", async () => {
    const timeout = fakeFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await expect(new MuseVoiceTranscriber({ apiKey: "k", fetch: timeout.fetch }).transcribe(audio())).rejects.toMatchObject({
      code: "timeout",
    });
    const dropped = fakeFetch(() => {
      throw new TypeError("connection reset");
    });
    await expect(new MuseVoiceTranscriber({ apiKey: "k", fetch: dropped.fetch }).transcribe(audio())).rejects.toMatchObject({
      code: "network_error",
    });
  });

  it("gives up after 90 seconds by default", async () => {
    let signal: AbortSignal | null | undefined;
    const { fetch } = fakeFetch(({ init }) => {
      signal = init.signal;
      return Response.json(RECORDED_RESPONSE);
    });
    await new MuseVoiceTranscriber({ apiKey: "k", fetch }).transcribe(audio());
    expect(signal?.aborted).toBe(false);
    // The timeout itself is AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS); its value is checked here.
    const { TRANSCRIBE_TIMEOUT_MS } = await import("../src/integrations/meta/transcribe");
    expect(TRANSCRIBE_TIMEOUT_MS).toBe(90_000);
  });
});

describe("reading stored media back", () => {
  it("returns what was stored, only inside the store's own prefix", async () => {
    const store = new R2MediaStore(env.MEDIA);
    const tenant = { businessId: `voice-${crypto.randomUUID()}` };
    const stored = await store.putImmutable(tenant, `stores/${tenant.businessId}/media/a1`, ogg(toneOgg()));
    const read = await store.read(tenant, stored.key);
    expect(read?.contentType).toBe("audio/ogg; codecs=opus");
    expect(new Uint8Array(read!.bytes)).toEqual(toneOgg());

    expect(await store.read(tenant, `stores/${tenant.businessId}/media/a1/missing`)).toBeNull();
    await expect(store.read({ businessId: "someone-else" }, stored.key)).rejects.toThrow("outside the store's prefix");
  });
});

class FakeTranscriber implements Transcriber {
  received: TranscriberAudio[] = [];
  respond: () => Promise<string> = async () => RECORDED_RESPONSE.transcript;

  async transcribe(input: TranscriberAudio) {
    this.received.push(input);
    return { text: await this.respond(), audioDurationMs: input.durationMs };
  }
}

describe("transcribeVoiceNote", () => {
  const nowS = (h: Harness) => Math.floor(h.clock.now() / 1000);

  /** A store whose owner sends one voice note; the handler transcribes it with the given transcriber. */
  async function voiceNoteFlow(transcriber: FakeTranscriber, media = new FakeMediaSource()) {
    const phone = newPhone();
    const store = await seedStore({ members: [{ phone, role: "owner" }] });
    media.respond = async () => ogg(toneOgg());
    const heard: string[] = [];
    let h!: Harness;
    const handler: JobHandler = {
      async handle({ lease, job }) {
        const transcript = await transcribeVoiceNote({ ...h.deps, transcriber }, lease, job.mediaAssetId!);
        heard.push(transcript.text);
        return { replies: [] };
      },
    };
    h = harness({ mediaSource: media, jobHandler: handler });
    await h.post(webhook(store.phoneNumberId, { messages: [audioMessage({ from: phone, id: wamid(), timestampS: nowS(h), mediaId: "m-voice" })] }));
    h.clock.advance(4_000);
    return { h, store, phone, heard };
  }

  it("reads the stored note back, decodes it to 16 kHz WAV and transcribes it", async () => {
    const transcriber = new FakeTranscriber();
    const { h, store, heard } = await voiceNoteFlow(transcriber);
    await h.deliver(h.takeRingsFor(store.businessId));

    expect(heard).toEqual([RECORDED_RESPONSE.transcript]);
    expect(transcriber.received).toHaveLength(1);
    expect(readWav(transcriber.received[0]!.wav)).toMatchObject({ channels: 1, sampleRate: 16000, bitsPerSample: 16 });
    expect(await rows(`SELECT job_state FROM inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([{ job_state: "done" }]);
    // Logs carry IDs only: never the transcript.
    expect(h.log.lines.join("\n")).not.toContain("azúcar");
    expect(h.log.events()).toContain("voice_note_transcribed");
  });

  it("retries a failed transcription, then sends the fixed 'no pude escuchar' reply", async () => {
    const transcriber = new FakeTranscriber();
    transcriber.respond = async () => {
      throw new TranscriptionError("http_500");
    };
    const { h, store, phone } = await voiceNoteFlow(transcriber);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.deliver(h.takeRingsFor(store.businessId).slice(0, 1));
      h.clock.advance(60_000);
    }
    expect(transcriber.received).toHaveLength(3);
    expect(await rows(`SELECT job_state, attempts, last_error FROM inbound_messages WHERE business_id = ?`, store.businessId)).toEqual([
      { job_state: "failed", attempts: 3, last_error: "attempt_failed" },
    ]);
    expect(h.sentTo(phone)).toEqual([couldNotProcess("audio")]);
    expect(couldNotProcess("audio")).toBe("Perdón, no pude escuchar tu nota de voz. ¿Me la mandás otra vez?");
  });

  it("treats a note with no words in it as a failure", async () => {
    const transcriber = new FakeTranscriber();
    transcriber.respond = async () => "   ";
    const { h, store } = await voiceNoteFlow(transcriber);
    await h.deliver(h.takeRingsFor(store.businessId));
    expect(h.log.fields("job_attempt_failed").map((line) => line.reason)).toEqual(["VoiceNoteError"]);
  });

  it("refuses an asset that isn't stored yet, without calling the transcriber", async () => {
    const transcriber = new FakeTranscriber();
    const { h, store } = await voiceNoteFlow(transcriber);
    const [asset] = await rows<{ id: string }>(`SELECT id FROM media_assets WHERE business_id = ?`, store.businessId);
    await expect(transcribeVoiceNote({ ...h.deps, transcriber }, store, asset!.id)).rejects.toEqual(
      new VoiceNoteError("media_not_stored"),
    );
    expect(transcriber.received).toEqual([]);
  });
});
