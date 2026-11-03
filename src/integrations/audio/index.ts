// WhatsApp voice notes (OGG/Opus) to mono 16-bit PCM WAV at 16 kHz for Muse Voice Transcribe,
// decoded inside the queue consumer (A1, accepted Oct 28).
import { UnreadableMediaError } from "../../application/errors";
import type { AudioDecoder, MediaBytes, TranscriberAudio } from "../../application/ports";
// Written by scripts/extract-opus-wasm.mjs (wrangler's build command; vitest.config.ts for tests).
import opusModule from "../../../dist/opus-decoder.wasm";
import { decodeOggOpusToWav } from "./decode";

export { AudioDecodeError, AudioTooLongError } from "./decode";
export { OggOpusError } from "./ogg";

/** Muse Voice Transcribe takes at most 10 minutes (https://dev.meta.ai/docs/speech-to-text). */
export const MAX_VOICE_NOTE_MS = 10 * 60 * 1000;
/** WhatsApp's own cap for audio is 16 MB; a 10-minute voice note is far smaller. */
export const MAX_VOICE_NOTE_BYTES = 16 * 1024 * 1024;

export class AudioTooLargeError extends UnreadableMediaError {
  override name = "AudioTooLargeError";
}

export class OpusAudioDecoder implements AudioDecoder {
  constructor(private readonly module: WebAssembly.Module = opusModule) {}

  async toTranscriberWav(audio: MediaBytes): Promise<TranscriberAudio> {
    if (audio.bytes.byteLength > MAX_VOICE_NOTE_BYTES) {
      throw new AudioTooLargeError(`audio is ${audio.bytes.byteLength} bytes`);
    }
    const decoded = await decodeOggOpusToWav(new Uint8Array(audio.bytes), this.module, {
      sampleRate: 16000,
      maxDurationMs: MAX_VOICE_NOTE_MS,
    });
    return { wav: decoded.wav, durationMs: decoded.durationMs };
  }
}
