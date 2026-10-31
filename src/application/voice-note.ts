import type { Deps, Tenant, Transcript } from "./ports";

/** Why a voice note couldn't be turned into text. Content-free, so it's safe to log. */
export class VoiceNoteError extends Error {
  override name = "VoiceNoteError";

  constructor(readonly reason: "media_not_stored" | "media_missing" | "no_speech") {
    super(`voice note not transcribed: ${reason}`);
  }
}

export interface VoiceNoteTranscript extends Transcript {
  /** Length of the decoded audio. */
  readonly durationMs: number;
}

export type VoiceNoteDeps = Pick<Deps, "jobs" | "mediaStore" | "audioDecoder" | "transcriber" | "log">;

/**
 * A job's stored voice note → text: read it back from the store's media, decode it to WAV, and
 * transcribe it. Throws on any failure, so a job handler that calls this gets the job's normal
 * retry and then the fixed "no pude escuchar tu nota de voz" reply (couldNotProcess("audio")).
 * A note with no words in it counts as a failure too.
 *
 * The transcript is untrusted: data for the model, never instructions, and never logged.
 */
export async function transcribeVoiceNote(deps: VoiceNoteDeps, tenant: Tenant, assetId: string): Promise<VoiceNoteTranscript> {
  const asset = await deps.jobs.getMediaAsset(tenant, assetId);
  if (asset === null || asset.state !== "stored" || asset.storedKey === null) {
    throw new VoiceNoteError("media_not_stored");
  }
  const media = await deps.mediaStore.read(tenant, asset.storedKey);
  if (media === null) throw new VoiceNoteError("media_missing");

  const audio = await deps.audioDecoder.toTranscriberWav(media);
  const transcript = await deps.transcriber.transcribe(audio);
  if (transcript.text.trim() === "") throw new VoiceNoteError("no_speech");

  deps.log.info("voice_note_transcribed", { businessId: tenant.businessId, assetId });
  return { ...transcript, durationMs: audio.durationMs };
}
