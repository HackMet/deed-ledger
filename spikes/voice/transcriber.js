'use strict';
// Transcriber (frozen TS shape) + Muse Voice Transcribe implementation.
// POST https://api.meta.ai/v1/asr/transcribe, multipart (request JSON + audio).
// WAV only: mono, 16-bit PCM, 16 or 24 kHz. Docs checked 2026-10-27:
// https://dev.meta.ai/docs/speech-to-text

const ASR_URL = 'https://api.meta.ai/v1/asr/transcribe';
const ASR_MODEL = 'muse-voice-transcribe-1.0';
// List price, metered in whole seconds rounded down:
// https://dev.meta.ai/docs/pricing-rate-limits (checked 2026-10-27)
const VOICE_PRICE_PER_HOUR = 0.18;
const VOICE_PRICE_SOURCE = 'https://dev.meta.ai/docs/pricing-rate-limits';

function voiceCostUsd(durationMs) {
  if (durationMs === null || durationMs === undefined) return null;
  return (Math.floor(durationMs / 1000) / 3600) * VOICE_PRICE_PER_HOUR;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class VoiceTranscriber {
  constructor({ apiKey, model = ASR_MODEL } = {}) {
    if (!apiKey) throw new Error('MODEL_API_KEY is not set');
    if (model.includes('contributor')) throw new Error('Refusing *-contributor model ID.');
    this.apiKey = apiKey;
    this.model = model;
  }

  // wavBytes: Buffer/Uint8Array, mono 16-bit PCM WAV at 16/24 kHz.
  // Returns { transcript, audioDurationMs, turns, latencyMs, retried, costUsd }.
  async transcribe(wavBytes, { sessionId, languageBias = ['Spanish'], mode = 'PUSH_TO_TALK' } = {}) {
    const settings = { mode, model: this.model, audioEncoding: 'WAV', languageBias };
    let lastErr;
    let retried = 0;
    for (let attempt = 0; attempt <= 1; attempt++) {
      const form = new FormData();
      form.append('request', new Blob([JSON.stringify(settings)], { type: 'application/json' }));
      form.append('audio', new Blob([wavBytes], { type: 'audio/wav' }), `${sessionId || 'audio'}.wav`);
      const url = sessionId ? `${ASR_URL}?sessionId=${encodeURIComponent(sessionId)}` : ASR_URL;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}` },
          body: form,
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const latencyMs = Date.now() - t0;
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
        if (res.ok) {
          return {
            transcript: json.transcript, audioDurationMs: json.audioDurationMs ?? null,
            turns: json.turns ?? [], latencyMs, retried,
            costUsd: voiceCostUsd(json.audioDurationMs),
          };
        }
        const err = new Error(`ASR ${res.status}: ${String(text).slice(0, 500)}`);
        err.status = res.status;
        lastErr = err;
        if ((res.status === 429 || res.status >= 500) && attempt < 1) { retried++; await sleep(2000); continue; }
        throw err;
      } catch (e) {
        clearTimeout(timer);
        if (e.status) throw e;
        lastErr = e;
        if (attempt < 1) { retried++; await sleep(2000); continue; }
        throw e;
      }
    }
    throw lastErr;
  }
}

module.exports = { VoiceTranscriber, voiceCostUsd, ASR_MODEL, ASR_URL, VOICE_PRICE_PER_HOUR, VOICE_PRICE_SOURCE };
