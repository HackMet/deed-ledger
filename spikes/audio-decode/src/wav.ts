// Mono 16-bit PCM WAV, the format Muse Voice Transcribe's file endpoint accepts.

const HEADER_BYTES = 44;

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
  // Samples are written through an Int16Array, which uses the platform's byte order.
  throw new Error("WAV writer needs a little-endian platform");
}

export interface Pcm16Wav {
  bytes: Uint8Array;
  /** View over the data chunk; write samples here, then call finishWav. */
  samples: Int16Array;
  sampleRate: number;
}

export function allocateWav(sampleCapacity: number, sampleRate: number): Pcm16Wav {
  const buffer = new ArrayBuffer(HEADER_BYTES + sampleCapacity * 2);
  return {
    bytes: new Uint8Array(buffer),
    samples: new Int16Array(buffer, HEADER_BYTES, sampleCapacity),
    sampleRate,
  };
}

/** Writes the header for the first `sampleCount` samples and returns the finished file. */
export function finishWav(wav: Pcm16Wav, sampleCount: number): Uint8Array {
  const dataBytes = sampleCount * 2;
  const view = new DataView(wav.bytes.buffer, 0, HEADER_BYTES);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, wav.sampleRate, true);
  view.setUint32(28, wav.sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  return wav.bytes.subarray(0, HEADER_BYTES + dataBytes);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
