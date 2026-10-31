/**
 * Muse Voice Transcribe, the file endpoint. Request and response shapes from Meta's docs, checked
 * October 30, 2026: https://dev.meta.ai/docs/speech-to-text
 *
 * POST https://api.meta.ai/v1/asr/transcribe, `Authorization: Bearer <key>`, multipart/form-data
 * with a `request` part (application/json settings) and an `audio` part (WAV: mono, 16-bit PCM,
 * 16 or 24 kHz, at most 32 MB and 10 minutes). The JSON response carries `transcript` and
 * `audioDurationMs`. Same request as the E4 experiment (spikes/voice/transcriber.js).
 *
 * One attempt per call: a failure throws, and the job's own retry decides what happens next.
 * Never called by the default test run: tests pass a fake fetch or a fake Transcriber.
 */
import type { Transcriber, TranscriberAudio, Transcript } from "../../application/ports";

export const TRANSCRIBE_URL = "https://api.meta.ai/v1/asr/transcribe";
export const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";
/** As in the E4 experiment. */
export const TRANSCRIBE_TIMEOUT_MS = 90_000;
/** The endpoint's body limit. */
const MAX_BODY_BYTES = 32 * 1000 * 1000;

export interface MuseTranscriberOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
}

/** Carries a short code only (`not_configured`, `timeout`, `http_429`…), never response text. */
export class TranscriptionError extends Error {
  override name = "TranscriptionError";

  constructor(readonly code: string) {
    super(`transcription failed: ${code}`);
  }
}

export class MuseVoiceTranscriber implements Transcriber {
  private readonly model: string;

  constructor(private readonly options: MuseTranscriberOptions) {
    this.model = options.model ?? TRANSCRIBE_MODEL;
    // Standard model IDs only (AGENTS.md, non-negotiable 7).
    if (this.model.includes("contributor")) throw new Error("refusing a *-contributor model ID");
  }

  async transcribe(audio: TranscriberAudio): Promise<Transcript> {
    if (this.options.apiKey === "") throw new TranscriptionError("not_configured");
    if (audio.wav.byteLength > MAX_BODY_BYTES) throw new TranscriptionError("audio_too_large");

    const settings = { mode: "PUSH_TO_TALK", model: this.model, audioEncoding: "WAV", languageBias: ["Spanish"] };
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify(settings)], { type: "application/json" }));
    form.append("audio", new Blob([audio.wav], { type: "audio/wav" }), "voice-note.wav");

    let response: Response;
    try {
      response = await this.options.fetch(TRANSCRIBE_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, accept: "application/json" },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new TranscriptionError(timedOut ? "timeout" : "network_error");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TranscriptionError(`http_${response.status}`);
    }
    const body: unknown = await response.json().catch(() => null);
    return readTranscript(body);
  }
}

function readTranscript(body: unknown): Transcript {
  if (typeof body !== "object" || body === null) throw new TranscriptionError("unexpected_response");
  const { transcript, audioDurationMs } = body as { transcript?: unknown; audioDurationMs?: unknown };
  if (typeof transcript !== "string") throw new TranscriptionError("unexpected_response");
  return {
    text: transcript,
    audioDurationMs: typeof audioDurationMs === "number" && Number.isFinite(audioDurationMs) ? audioDurationMs : null,
  };
}
