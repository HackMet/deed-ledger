/**
 * What the reader is given: one burst's messages, oldest first, and what code knows about the
 * conversation. Message content is untrusted data. Only `import type` here (see wire.ts).
 */
import type { PerceptionContext } from "../contract/observation";

export type BurstMessage =
  | { readonly type: "text"; readonly text: string }
  /** A voice note, already transcribed (Muse Voice Transcribe). */
  | { readonly type: "transcript"; readonly text: string }
  /** A photo's bytes. Missing bytes (not fetched, unsupported format) still hold the position. */
  | { readonly type: "image"; readonly mimeType: string; readonly bytes: ArrayBuffer | null }
  /** A shared WhatsApp location. Coordinates come from the webhook, never from the model. */
  | { readonly type: "location"; readonly latitude: number; readonly longitude: number };

/** One product the model may point at by label ("P3"), never by ID. Built by code from the catalog. */
export interface CatalogLabel {
  readonly label: string;
  readonly text: string;
}

/**
 * The contract's PerceptionContext plus the catalog labels the model may pick among. Local until
 * the contract carries labels (contract question in the reading handoff).
 */
export interface ReadingContext extends PerceptionContext {
  readonly catalogLabels: readonly CatalogLabel[];
}

/** Formats Meta reads in an image (docs: image understanding). No HEIC. */
export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export function isSupportedImage(mimeType: string): boolean {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}
