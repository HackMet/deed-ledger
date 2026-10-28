// Decode cost measured in Node, where clocks advance during synchronous work (inside workerd they
// don't). Same source and same .wasm bytes as the Worker.
// Usage: node --experimental-strip-types bench/node-bench.mjs [--runs 8] [--rate 16000] [--out dir] file.ogg...
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { decodeOggOpusToWav } from "../src/decode.ts";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const runs = Number(option("--runs", "8"));
const sampleRate = Number(option("--rate", "16000"));
const outDir = option("--out", null);
const files = args;

// Process CPU counts every thread, including V8's background JIT and GC. Main-thread CPU (Linux
// schedstat, nanoseconds) is closer to what one request's isolate thread spends.
const cpuMs = (usage) => (usage.user + usage.system) / 1000;
const mainThreadCpuMs = () =>
  Number(readFileSync(`/proc/self/task/${process.pid}/schedstat`, "utf8").split(" ")[0]) / 1e6;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (n) => Math.round(n * 10) / 10;

const wasmBytes = readFileSync(new URL("../dist/opus-decoder.wasm", import.meta.url));
const compileCpu = process.cpuUsage();
const compileStart = performance.now();
const opusModule = await WebAssembly.compile(wasmBytes);
const compile = {
  wallMs: round(performance.now() - compileStart),
  cpuMs: round(cpuMs(process.cpuUsage(compileCpu))),
};

const results = [];
for (const file of files) {
  const ogg = new Uint8Array(readFileSync(file));
  const samples = [];
  let last;
  for (let run = 0; run < runs; run++) {
    const cpu = process.cpuUsage();
    const thread = mainThreadCpuMs();
    const start = performance.now();
    last = await decodeOggOpusToWav(ogg, opusModule, { sampleRate, maxDurationMs: 600_000 });
    samples.push({
      wallMs: performance.now() - start,
      cpuMs: cpuMs(process.cpuUsage(cpu)),
      threadMs: mainThreadCpuMs() - thread,
    });
    if (run === 0 && outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, `${basename(file, ".ogg")}-${sampleRate}.wav`), last.wav);
    }
  }
  const warm = samples.slice(1);
  const warmCpu = warm.length ? median(warm.map((s) => s.cpuMs)) : samples[0].cpuMs;
  results.push({
    file: basename(file),
    oggBytes: ogg.length,
    audioSeconds: round(last.durationMs / 1000),
    packets: last.packets,
    wavBytes: last.wav.length,
    sampleRate: last.sampleRate,
    firstRun: {
      wallMs: round(samples[0].wallMs),
      mainThreadCpuMs: round(samples[0].threadMs),
      processCpuMs: round(samples[0].cpuMs),
    },
    warmMedian: {
      wallMs: round(warm.length ? median(warm.map((s) => s.wallMs)) : samples[0].wallMs),
      mainThreadCpuMs: round(warm.length ? median(warm.map((s) => s.threadMs)) : samples[0].threadMs),
      processCpuMs: round(warmCpu),
    },
    warmMaxProcessCpuMs: round(Math.max(...warm.map((s) => s.cpuMs), 0)),
    realtimeFactorVsProcessCpu: Math.round(last.durationMs / warmCpu),
    rssMiB: round(process.memoryUsage().rss / 2 ** 20),
  });
}

console.log(JSON.stringify({ node: process.version, execArgv: process.execArgv, runs, compile, results }, null, 2));
