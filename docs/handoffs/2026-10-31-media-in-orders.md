## Handoff: photos and voice notes in the order flow

- Agent and branch: Claude Code helper, `claude/media-in-orders` (worktree `hackathon-claude-mediawire`, on the
  combined branch with #27 media and #17 order trip). Nothing committed.
- Objective: a customer's photo and voice note reach the reader for real (bytes from R2, a transcript), the
  conversation lease survives a slow transcription, and unreadable media gets the fixed honest reply.
- References: `docs/handoffs/2026-10-31-media.md` (the lease risk), `docs/handoffs/2026-10-31-order-trip.md` (the
  `BurstMediaResolver` seam); AGENTS.md non-negotiables 5–7.
- Files changed:
  - `src/application/order-reading.ts`: `storedMediaResolver` (new default); burst messages resolved in order, one
    voice note at a time; `holdLeaseFor` before each transcription and before the model call; `leases` dep.
  - `src/application/order-handler.ts`: gives up on unreadable media (last attempt, or every failure permanent) with
    the fixed reply per kind, marking only those messages read.
  - `src/application/errors.ts` (add): `UnreadableMediaError`, `UnreadableMedia`, `BurstMediaUnreadableError`.
  - `src/domain/processing.ts` (add): `TRANSCRIBE_MAX_MS` (90 s), `READING_MAX_MS` (60 s).
  - `src/integrations/meta/transcribe.ts`, `spark.ts`: default timeouts now come from those constants (same values).
  - `src/integrations/audio/{decode,ogg,index}.ts`: `AudioTooLongError`, `AudioDecodeError`, `OggOpusError`,
    `AudioTooLargeError` extend `UnreadableMediaError` (names unchanged).
  - `src/composition.ts`: media store, decoder and transcriber built once and shared; `buildOrderReading` takes them
    (optional overrides, added) and defaults to `storedMediaResolver`; `RuntimeOverrides.burstMedia` still wins.
  - `test/helpers/harness.ts` (add): `transcriber`, `audioDecoder` options. `test/order-flow.test.ts`: 6 tests.
  - `docs/architecture.md`: lease, voice notes, reading a burst, risks.
- What was done:
  - **Resolver.** Photo: `jobs.getMediaAsset` → `MediaStore.read` with the tenant from the lease → image content
    (bare MIME type; a type the model doesn't take is a permanent failure, not "no disponible"). Voice note:
    `transcribeVoiceNote` → `{ type: "transcript" }` at the note's own position, so evidence points at it. Every
    photo and voice note of the burst is tried; failures are collected into one `BurstMediaUnreadableError` before
    any model call. Logs: `burst_media_unreadable` with inbound ID, error name and permanent/retryable, never
    content or URLs.
  - **Lease (option chosen: a fenced extension sized to each slow step).** Before each transcription the lease is
    extended to 90 s + 60 s, before the model call to 60 s + 60 s, through the existing fenced `extendLease`
    (same lease ID and still live, by D1's clock); false throws `LeaseLostError`, so a lost lease stops before the
    transcription or the paid call, and every later write is still fenced. Why not the alternatives: raising the
    lease at claim time doesn't work (the processor claims before it knows the burst, and the transcription runs at
    the burst's last job, after other jobs), and making every lease long slows crash recovery for all
    conversations. A heartbeat beside the call would add a concurrent writer for no gain: both steps have hard
    timeouts, so one extension bounds them. The same fix covers the model call, which could already overrun a 60 s
    lease after a slow download.
  - **Failure.** Transient failures (transcriber down, object missing) retry with the job (3 attempts); on the last
    the job completes with "Perdón, no pude escuchar tu nota de voz. ¿Me la mandás otra vez?" or "Perdón, no pude
    leer tu foto. ¿Me la mandás otra vez?" (once per kind). A permanent failure (broken or over-10-minute note,
    unsupported photo format) gets it on the first attempt, no transcription call. Only the failed media is marked
    read: the rest of the burst stays unread and is read with the next message, so a resent note isn't read beside
    the old one (tested). Nothing reaches the engine.
- Tests run:

  ```text
  $ npm run typecheck
  > tsc --noEmit -p tsconfig.json && tsc --noEmit -p test/tsconfig.json      (exit 0, no errors)

  $ npm test
   Test Files  32 passed (32)
        Tests  385 passed (385)
  ```

  New in `order-flow.test.ts` ("photos and voice notes in an order"): photo + voice note → one transcription, one
  model call with the photo's exact bytes and the transcript at `[1]`, two `burst_reads` rows from one job, one
  reply, no transcript or URL in logs; a 70 s transcription (fake clock advanced and the D1 lease end moved back
  70 s, with a second doorbell delivered mid-call) finishes once, the second consumer finds the lease busy; a lease
  expired mid-transcription with a takeover → one model call, one reply, the stale consumer logs `lease_lost`;
  3 failed transcriptions → the voice-note reply, then the resent note is read with the waiting photo; a broken
  note → reply at once, no retry; a HEIC photo → the photo reply. Real Opus decoder on the synthetic tone fixture;
  fake transcriber, fake model, fake media source; no network.
  Checked the 70 s test catches the bug: with the transcription extension disabled it fails (`expected 2 to be 1`,
  the transcriber ran twice); restored.
- Not done, risks, open questions:
  - A consumer that dies mid-transcription holds the conversation up to 150 s, not 60 s.
  - `no_speech` (empty transcript) is retried 3 times; it might be permanent. `TranscriptionError("not_configured")`
    (no key) is retried too.
  - Several voice notes in one burst are transcribed one after another: four 90 s worst cases is 6 minutes of wall
    time in one queue invocation (within the 15-minute limit, but the customer waits).
  - The console's Anotar reader (`Runtime.burstReader`) doesn't use the resolver; unchanged.
  - Queue `max_batch_size` for voice (media handoff) is still 10.
  - Never run against a real webhook, R2 bucket or transcriber.
- Next steps: deploy with `MODEL_API_KEY` set and send a real photo and voice note from a phone; decide whether
  `no_speech` should be permanent.
