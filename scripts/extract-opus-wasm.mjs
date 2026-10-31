// Build step, Node only. opus-decoder ships libopus as a compressed string inside its JavaScript and
// compiles it at runtime, which Workers forbid. This writes the same binary to dist/opus-decoder.wasm,
// which Wrangler bundles as a precompiled WebAssembly.Module (src/integrations/audio/index.ts).
// Runs from wrangler.jsonc's build command (dev, deploy) and from vitest.config.ts (tests).
// The file is rewritten only when its bytes change, so `wrangler dev` doesn't rebuild in a loop.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OPUS_WASM_PATH = join(root, "dist", "opus-decoder.wasm");

export async function extractOpusWasm() {
  const require = createRequire(join(root, "package.json"));
  const opusDecoderIndex = require.resolve("opus-decoder");
  // The package's export map hides src/, so load the generated glue by file path.
  const glueUrl = pathToFileURL(join(dirname(opusDecoderIndex), "src", "EmscriptenWasm.js")).href;
  const commonUrl = pathToFileURL(createRequire(opusDecoderIndex).resolve("@wasm-audio-decoders/common")).href;

  const { default: EmscriptenWASM } = await import(glueUrl);
  const { WASMAudioDecoderCommon } = await import(commonUrl);

  new WASMAudioDecoderCommon(); // installs the static helpers, including the inflater
  new EmscriptenWASM(WASMAudioDecoderCommon); // defines EmscriptenWASM.wasm, the encoded binary
  const bytes = await WASMAudioDecoderCommon.inflateDynEncodeString(EmscriptenWASM.wasm);
  if (!WebAssembly.validate(bytes)) throw new Error("extracted bytes are not a valid Wasm module");

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const current = existsSync(OPUS_WASM_PATH) ? readFileSync(OPUS_WASM_PATH) : null;
  if (current === null || !current.equals(bytes)) {
    mkdirSync(dirname(OPUS_WASM_PATH), { recursive: true });
    writeFileSync(OPUS_WASM_PATH, bytes);
  }
  const pkg = JSON.parse(readFileSync(join(dirname(opusDecoderIndex), "package.json"), "utf8"));
  return { source: `${pkg.name}@${pkg.version}`, path: OPUS_WASM_PATH, bytes: bytes.length, sha256 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(await extractOpusWasm()));
}
