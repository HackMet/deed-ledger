// OGG/Opus voice note -> mono 16-bit PCM WAV at 16 or 24 kHz, for Muse Voice Transcribe.
//
// libopus decodes straight to the target rate (it supports 8, 12, 16, 24 and 48 kHz output), so
// there is no separate resampler. The Wasm binary comes from opus-decoder (MIT; libopus is
// BSD-3-Clause) and must be passed in as a precompiled WebAssembly.Module: Workers refuse to compile
// Wasm from bytes at runtime, which is what the package would otherwise do.

import { OpusDecoder } from "opus-decoder";

import { opusPacketSamples48k, readOggOpus } from "./ogg.ts";
import { allocateWav, finishWav } from "./wav.ts";

export type OutputSampleRate = 8000 | 12000 | 16000 | 24000 | 48000;

export interface DecodeOptions {
  sampleRate: OutputSampleRate;
  /** Reject longer audio before decoding anything. The transcriber takes at most 10 minutes. */
  maxDurationMs: number;
}

export interface DecodedWav {
  wav: Uint8Array;
  sampleRate: number;
  sampleCount: number;
  durationMs: number;
  channelsIn: number;
  packets: number;
}

export class AudioTooLongError extends Error {
  override name = "AudioTooLongError";
}

export class AudioDecodeError extends Error {
  override name = "AudioDecodeError";
}

// opus-decoder reads this static when it builds an instance; when set, it skips its runtime compile.
type OpusDecoderStatics = { module?: WebAssembly.Module };

const PACKETS_PER_BATCH = 50; // about one second of 20 ms packets per call into Wasm

export async function decodeOggOpusToWav(
  ogg: Uint8Array,
  opusModule: WebAssembly.Module,
  options: DecodeOptions,
): Promise<DecodedWav> {
  const { head, packets, finalGranule } = readOggOpus(ogg);
  const rate = options.sampleRate;

  // Size the output from the packets' own frame counts; the final granule trims encoder padding.
  let samples48k = -head.preSkip;
  for (const packet of packets) samples48k += opusPacketSamples48k(packet);
  if (finalGranule !== null) samples48k = Math.min(samples48k, finalGranule - head.preSkip);
  samples48k = Math.max(0, samples48k);

  const durationMs = samples48k / 48;
  if (durationMs > options.maxDurationMs) {
    throw new AudioTooLongError(`audio is ${Math.round(durationMs)} ms long`);
  }

  const capacity = Math.round((samples48k * rate) / 48000);
  const wav = allocateWav(capacity, rate);
  const gain = head.outputGainQ8 === 0 ? 1 : 10 ** (head.outputGainQ8 / (256 * 20));

  (OpusDecoder as unknown as OpusDecoderStatics).module = opusModule;
  const decoder = new OpusDecoder({
    sampleRate: rate,
    channels: head.channels,
    preSkip: Math.round((head.preSkip * rate) / 48000),
  });
  await decoder.ready;

  let written = 0;
  try {
    for (let i = 0; i < packets.length && written < capacity; i += PACKETS_PER_BATCH) {
      const decoded = decoder.decodeFrames(packets.slice(i, i + PACKETS_PER_BATCH));
      if (decoded.errors.length > 0) {
        throw new AudioDecodeError(`libopus rejected ${decoded.errors.length} packet(s)`);
      }
      const count = Math.min(decoded.samplesDecoded, capacity - written);
      writePcm16(decoded.channelData, count, gain, wav.samples, written);
      written += count;
    }
  } finally {
    decoder.free();
  }

  return {
    wav: finishWav(wav, written),
    sampleRate: rate,
    sampleCount: written,
    durationMs: (written / rate) * 1000,
    channelsIn: head.channels,
    packets: packets.length,
  };
}

/** Mixes to mono, applies the header gain and converts float samples to 16-bit integers. */
function writePcm16(
  channels: Float32Array[],
  count: number,
  gain: number,
  out: Int16Array,
  offset: number,
): void {
  const left = channels[0];
  if (!left) return;
  const right = channels[1];
  const scale = right ? gain * 0.5 : gain;
  for (let i = 0; i < count; i++) {
    const sample = (right ? left[i]! + right[i]! : left[i]!) * scale;
    out[offset + i] = sample >= 1 ? 32767 : sample <= -1 ? -32768 : Math.round(sample * 32767);
  }
}
