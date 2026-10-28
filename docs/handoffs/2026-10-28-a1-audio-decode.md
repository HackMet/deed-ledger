## Handoff: A1 spike, decoding WhatsApp voice notes inside a Worker

- Agent and branch: Claude Code helper, `claude/audio-decode`. Verified and committed by the orchestrating Claude Code
  session.
- Objective: decide architecture decision A1 (where OGG/Opus → WAV decoding runs) before the voice pieces start.
- References: `docs/architecture.md` A1 and provider facts; `docs/handoffs/2026-10-27-e4-voice.md`; D-10.
- Files changed: `spikes/audio-decode/` (Worker, Ogg demuxer, WAV writer, benchmarks, synthetic-audio script). Generated
  audio, WAVs and the extracted `.wasm` live in the gitignored `dist/`; no audio is tracked.
- What was done:
  - Chose `opus-decoder` 0.7.12 (MIT; embeds libopus, BSD-3-Clause). Rejected `ogg-opus-decoder` and
    `@audio/decode-opus` (LGPL `codec-parser`), `@evan/opus` and `opusscript` (larger, encoder included, stale), and
    ffmpeg.wasm (size, LGPL/GPL). libopus outputs 16 or 24 kHz directly, so no resampler is needed.
  - Ogg demuxing is our own code, written from RFC 3533 and RFC 7845.
  - Two workarounds make the package run in workerd, both tied to its internals, so the version is pinned: the Wasm is
    extracted at build time and passed in as an imported `WebAssembly.Module` (runtime compilation is disallowed and
    otherwise hangs), and a Wrangler alias stubs `@eshaz/web-worker`.
  - Measured with synthetic speech (mono 48 kHz Opus, like WhatsApp), output mono 16-bit PCM at 16 kHz:

    | Audio | OGG | WAV | Node CPU (warm) | Local workerd CPU (warm) |
    |---|---|---|---|---|
    | 5 s | 15,416 B | 160,044 B | 23 ms | 32–39 ms |
    | 60 s | 181,849 B | 1,920,044 B | 229 ms | 273–310 ms |
    | 300 s | 909,495 B | 9,600,044 B | 1.14 s | 1.33–1.45 s |

  - Outputs validated with ffprobe and Python's `wave`; workerd and Node outputs are byte-identical; against ffmpeg's
    decode, 44–45 dB SNR at 16 kHz with zero lag.
  - Each decoder instance holds a fixed 28 MiB Wasm heap, plus about 9.2 MiB of WAV per 5 minutes of audio.
- Tests run:
  - `npm run typecheck` → exit 0 (rerun by the orchestrator).
  - `node --experimental-strip-types bench/node-bench.mjs --runs 3 dist/audio/*.ogg` → 300 s note ≈ 1.2 s wall,
    60 s ≈ 0.24 s, 5 s ≈ 20 ms (rerun by the orchestrator).
  - `ffprobe` on the 60 s output → `pcm_s16le`, 16000 Hz, 1 channel, 16 bits, 60.000000 s (rerun by the orchestrator).
  - The live transcription call was skipped: `MODEL_API_KEY` was not set.
- Not done, risks, open questions:
  - No unit tests; the production adapter (T2) needs them.
  - CPU on Cloudflare's hardware is unmeasured until the first deploy.
  - The production adapter must reject a truncated file instead of returning partial audio, cap the input size, and
    process one voice note at a time (`max_batch_size: 1`).
  - libopus's BSD notice has to ship with the Wasm.
  - The status trap about timers is half wrong: in local `wrangler dev` timers did advance during synchronous work;
    the freeze is production behavior per Cloudflare's docs.
- Next steps: A1 is decided (decode in the queue consumer, accepted by Angel on October 28). The voice piece builds
  an `AudioDecoder` adapter from this spike: `toTranscriberWav(audio) → { wav, durationMs }`, with a fake in tests.
