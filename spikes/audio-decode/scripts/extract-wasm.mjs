// Build step, Node only. opus-decoder ships libopus as a compressed string inside its JavaScript and
// compiles it at runtime, which Workers forbid. This writes the same binary to dist/opus-decoder.wasm
// so Wrangler can upload it as a precompiled WebAssembly.Module that the Worker imports.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const opusDecoderIndex = require.resolve("opus-decoder");
// The package's export map hides src/, so load the generated glue by file path.
const glueUrl = pathToFileURL(join(dirname(opusDecoderIndex), "src", "EmscriptenWasm.js")).href;
const commonUrl = pathToFileURL(
  createRequire(opusDecoderIndex).resolve("@wasm-audio-decoders/common"),
).href;

const { default: EmscriptenWASM } = await import(glueUrl);
const { WASMAudioDecoderCommon } = await import(commonUrl);

new WASMAudioDecoderCommon(); // installs the static helpers, including the inflater
new EmscriptenWASM(WASMAudioDecoderCommon); // defines EmscriptenWASM.wasm, the encoded binary
const bytes = await WASMAudioDecoderCommon.inflateDynEncodeString(EmscriptenWASM.wasm);

if (!WebAssembly.validate(bytes)) throw new Error("extracted bytes are not a valid Wasm module");
const module = await WebAssembly.compile(bytes);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, "opus-decoder.wasm");
writeFileSync(outFile, bytes);

const pkg = JSON.parse(readFileSync(join(dirname(opusDecoderIndex), "package.json"), "utf8"));
console.log(
  JSON.stringify(
    {
      source: `${pkg.name}@${pkg.version}`,
      outFile,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      imports: WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}:${i.kind}`),
      exports: WebAssembly.Module.exports(module).map((e) => `${e.name}:${e.kind}`),
    },
    null,
    2,
  ),
);
