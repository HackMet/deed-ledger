// Independent check of a decoded WAV against a reference WAV (for example, ffmpeg's decode of the
// same OGG). Parses RIFF chunks itself, then reports the best alignment and the signal-to-noise
// ratio of the difference. Usage: node bench/compare-wav.mjs test.wav reference.wav
import { readFileSync } from "node:fs";

function readWav(path) {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at) => bytes.toString("latin1", at, at + 4);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error(`${path}: not RIFF/WAVE`);
  let format;
  let samples;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      format = {
        audioFormat: view.getUint16(at + 8, true),
        channels: view.getUint16(at + 10, true),
        sampleRate: view.getUint32(at + 12, true),
        bitsPerSample: view.getUint16(at + 22, true),
      };
    } else if (id === "data") {
      samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset + at + 8, bytes.byteOffset + at + 8 + size));
    }
    at += 8 + size + (size % 2);
  }
  return { format, samples };
}

const [testPath, refPath] = process.argv.slice(2);
const test = readWav(testPath);
const ref = readWav(refPath);

let best = { lag: 0, error: Infinity };
for (let lag = -64; lag <= 64; lag++) {
  let error = 0;
  const n = Math.min(test.samples.length, ref.samples.length) - 64;
  for (let i = 64; i < n; i++) {
    const d = test.samples[i + lag] - ref.samples[i];
    error += d * d;
  }
  if (error < best.error) best = { lag, error };
}

let signal = 0;
let maxAbsDiff = 0;
let identical = 0;
const n = Math.min(test.samples.length, ref.samples.length) - 64;
for (let i = 64; i < n; i++) {
  const d = test.samples[i + best.lag] - ref.samples[i];
  signal += ref.samples[i] * ref.samples[i];
  maxAbsDiff = Math.max(maxAbsDiff, Math.abs(d));
  if (d === 0) identical++;
}

console.log(
  JSON.stringify({
    test: { ...test.format, sampleCount: test.samples.length },
    reference: { ...ref.format, sampleCount: ref.samples.length },
    bestLagSamples: best.lag,
    snrDb: best.error === 0 ? Infinity : Math.round(100 * 10 * Math.log10(signal / best.error)) / 100,
    maxAbsDiff,
    identicalFraction: Math.round((identical / (n - 64)) * 10000) / 10000,
  }),
);
