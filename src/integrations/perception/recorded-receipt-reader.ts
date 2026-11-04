/**
 * The recorded receipt reader: the reading a fixture holds for the exact image bytes, by SHA-256.
 * Default runs never call a model (AGENTS.md, Tests). Each recording is validated like a model's
 * output would be (schema first), and an image without a recording is refused, never guessed.
 */
import type { ReceiptImage, ReceiptReader, ReceiptReadResult } from "../../application/receipt-reader";
import type { Tenant } from "../../application/ports";
import type { BusinessInfo } from "../../domain/business-info";
import { parseReceiptReading } from "../../domain/receipt-draft";

export interface ReceiptRecording {
  /** Every recording is synthetic: "fixture". */
  readonly source: "fixture";
  readonly sha256: string;
  readonly reading: unknown;
}

export class RecordedReceiptReader implements ReceiptReader {
  private readonly bySha: ReadonlyMap<string, unknown>;

  constructor(recordings: readonly ReceiptRecording[]) {
    this.bySha = new Map(recordings.filter((r) => r.source === "fixture").map((r) => [r.sha256, r.reading]));
  }

  /** The context is ignored: a recording is the same whatever the store says about itself. */
  async read(_tenant: Tenant, image: ReceiptImage, _context: BusinessInfo | null): Promise<ReceiptReadResult> {
    const recorded = this.bySha.get(image.sha256);
    if (recorded === undefined) return { type: "refused", reason: "unreadable" };
    const reading = parseReceiptReading(recorded);
    return reading === null ? { type: "refused", reason: "unreadable" } : { type: "reading", reading };
  }
}
