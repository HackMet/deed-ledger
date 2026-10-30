// Spike Worker: POST an OGG/Opus body to /decode and get back mono 16-bit PCM WAV.
// The /probe routes record what workerd does when code compiles Wasm from bytes at runtime.

import { OpusDecoder } from "opus-decoder";

import opusModule from "../dist/opus-decoder.wasm";
import { AudioTooLongError, decodeOggOpusToWav } from "./decode.ts";
import { OggOpusError } from "./ogg.ts";

const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const TEN_MINUTES_MS = 10 * 60 * 1000;

// The Workers types leave out compiling from bytes on purpose; the probes try it anyway.
const wasmFromBytes = WebAssembly as unknown as {
  Module: new (bytes: Uint8Array) => object;
  compile(bytes: Uint8Array): Promise<object>;
  instantiate(bytes: Uint8Array): Promise<object>;
};

const startupCompile = attempt(() => new wasmFromBytes.Module(EMPTY_WASM));
let decodedOnce = false;
let lastUnhandledRejection: string | null = null;

addEventListener("unhandledrejection", (event) => {
  lastUnhandledRejection = String((event as PromiseRejectionEvent).reason);
});

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/decode") {
      const sampleRate = url.searchParams.get("rate") === "24000" ? 24000 : 16000;
      const ogg = new Uint8Array(await request.arrayBuffer());
      const clockBefore = Date.now();
      try {
        const result = await decodeOggOpusToWav(ogg, opusModule, {
          sampleRate,
          maxDurationMs: TEN_MINUTES_MS,
        });
        decodedOnce = true;
        return new Response(result.wav, {
          headers: {
            "content-type": "audio/wav",
            "x-sample-rate": String(result.sampleRate),
            "x-sample-count": String(result.sampleCount),
            "x-packets": String(result.packets),
            // Expected to read 0: Date.now() only moves on I/O inside workerd.
            "x-clock-delta-ms": String(Date.now() - clockBefore),
          },
        });
      } catch (error) {
        if (error instanceof OggOpusError || error instanceof AudioTooLongError) {
          return Response.json({ error: error.name }, { status: 422 });
        }
        throw error;
      }
    }

    if (url.pathname === "/probe/compile") {
      return Response.json({
        startupNewModule: startupCompile,
        requestNewModule: attempt(() => new wasmFromBytes.Module(EMPTY_WASM)),
        requestCompile: await attemptAsync(() => wasmFromBytes.compile(EMPTY_WASM)),
        requestInstantiateBytes: await attemptAsync(() => wasmFromBytes.instantiate(EMPTY_WASM)),
        requestInstantiateImportedModule: await attemptAsync(() =>
          WebAssembly.instantiate(opusModule, { a: stubImports() }),
        ),
        importedValueIsModule: opusModule instanceof WebAssembly.Module,
      });
    }

    // Pure synchronous work with no await: do Date.now() and performance.now() move during it?
    if (url.pathname === "/probe/clock") {
      const dateBefore = Date.now();
      const perfBefore = performance.now();
      let spin = 0;
      for (let i = 0; i < 300_000_000; i++) spin = (spin + i) | 0;
      return Response.json({
        dateDeltaMs: Date.now() - dateBefore,
        perfDeltaMs: performance.now() - perfBefore,
        spin,
      });
    }

    // The library's own path (no injected module) compiles from bytes. Only meaningful as the first
    // request in a fresh isolate: after a decode, the library has the injected module cached.
    if (url.pathname === "/probe/library-default") {
      const statics = OpusDecoder as unknown as { module?: WebAssembly.Module };
      const saved = statics.module;
      statics.module = undefined;
      try {
        const decoder = new OpusDecoder({ sampleRate: 16000, channels: 1 });
        const outcome = await Promise.race([
          decoder.ready.then(() => "ready"),
          new Promise<string>((resolve) => setTimeout(() => resolve("not ready after 3 s"), 3000)),
        ]);
        return Response.json({ decodedBefore: decodedOnce, outcome, lastUnhandledRejection });
      } catch (error) {
        return Response.json({ decodedBefore: decodedOnce, threw: String(error) });
      } finally {
        statics.module = saved;
      }
    }

    return new Response("POST /decode, GET /probe/compile, GET /probe/library-default\n", {
      status: 404,
    });
  },
};

function attempt(run: () => unknown): string {
  try {
    run();
    return "allowed";
  } catch (error) {
    return `refused: ${String(error)}`;
  }
}

async function attemptAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "allowed";
  } catch (error) {
    return `refused: ${String(error)}`;
  }
}

function stubImports(): Record<string, () => number> {
  const fail = () => {
    throw new Error("stub import called");
  };
  return { a: fail, b: fail, c: fail, d: fail, e: fail, f: fail };
}
