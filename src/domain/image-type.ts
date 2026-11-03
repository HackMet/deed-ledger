/**
 * What a file really is, from its first bytes. The content type a browser or client sends is a
 * claim; these signatures decide what is stored and sent to the model.
 */

export type SniffedImage = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** A photo format Meta reads, or null for anything else (HEIC, PDF, audio, random bytes). */
export function sniffImageType(bytes: ArrayBuffer): SniffedImage | null {
  const b = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 12));
  const at = (offset: number, ...values: number[]) => values.every((value, i) => b[offset + i] === value);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** Recorded sound by its bytes (OGG, WebM, WAV, MP4/M4A) or its declared type. */
export function looksLikeAudio(bytes: ArrayBuffer, contentType: string): boolean {
  if (contentType.toLowerCase().startsWith("audio/")) return true;
  const b = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 12));
  const at = (offset: number, ...values: number[]) => values.every((value, i) => b[offset + i] === value);
  return (
    at(0, 0x4f, 0x67, 0x67, 0x53) || // OggS
    at(0, 0x1a, 0x45, 0xdf, 0xa3) || // EBML (WebM)
    (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x41, 0x56, 0x45)) || // RIFF....WAVE
    (at(4, 0x66, 0x74, 0x79, 0x70) && at(8, 0x4d, 0x34, 0x41)) // ....ftypM4A
  );
}
