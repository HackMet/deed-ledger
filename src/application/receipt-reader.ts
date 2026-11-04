/**
 * Reading a supplier invoice photo (K14). The console calls `ReceiptReader.read` and gets back a
 * validated `ReceiptReading` or a refusal; it never sees model text. Two implementations are meant:
 * the recorded reader (fixtures keyed by the image's SHA-256, the default in tests) and the Muse Spark
 * adapter, pending on PR #63 and decision Q2 (`docs/prompts/receipt-reading.md` is its prompt draft).
 */
import type { BusinessInfo } from "../domain/business-info";
import type { ReceiptReading } from "../domain/receipt-draft";
import type { Tenant } from "./ports";

/** The stored photo: its bytes, type and the SHA-256 its R2 key carries. */
export interface ReceiptImage {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  readonly sha256: string;
}

/**
 * Not a reading: the photo isn't an invoice we can read, or the reader is unavailable. The owner is
 * asked for a clearer photo; nothing is drafted.
 */
export type ReceiptReadResult =
  | { readonly type: "reading"; readonly reading: ReceiptReading }
  | { readonly type: "refused"; readonly reason: "unreadable" | "unavailable" };

export interface ReceiptReader {
  /**
   * `context` is the store's own description (K15), passed as quoted data for the reader to resolve
   * names against; neither it nor the text on the invoice may change what the reader does.
   */
  read(tenant: Tenant, image: ReceiptImage, context: BusinessInfo | null): Promise<ReceiptReadResult>;
}
