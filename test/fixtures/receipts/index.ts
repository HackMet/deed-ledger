/**
 * Synthetic supplier invoices for the recorded receipt reader (K14). Each image is the PNG signature
 * followed by the fixture's `imageText`: not a real photo, never a real invoice. The recording is
 * keyed by those bytes' SHA-256.
 */
import type { ReceiptRecording } from "../../../src/integrations/perception/recorded-receipt-reader";
import distribuidora from "./distribuidora-ejemplo.json";
import sinCantidad from "./sin-cantidad.json";
import inyectado from "./texto-inyectado.json";

type Fixture = ReceiptRecording & { readonly description: string; readonly imageText: string };

export const receiptFixtures = {
  distribuidora: distribuidora as Fixture,
  inyectado: inyectado as Fixture,
  sinCantidad: sinCantidad as Fixture,
};

export const receiptRecordings: readonly ReceiptRecording[] = Object.values(receiptFixtures);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The synthetic image a fixture was recorded for. */
export function fixtureImage(fixture: Fixture): Uint8Array {
  const text = new TextEncoder().encode(fixture.imageText);
  const bytes = new Uint8Array(PNG_SIGNATURE.length + text.length);
  bytes.set(PNG_SIGNATURE);
  bytes.set(text, PNG_SIGNATURE.length);
  return bytes;
}
