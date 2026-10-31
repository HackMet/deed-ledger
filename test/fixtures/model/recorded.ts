/**
 * Recorded model responses for the reader. Synthetic bursts only. Two kinds:
 * - "live": copied verbatim from a real muse-spark-1.3 call (the gap (p) check, Oct 30).
 * - "authored": written by hand in the wire format, to pin how code maps and checks a response.
 *   They test our side of the boundary, not the model's accuracy (that's #28's live measurement).
 */
import type { PerceptionContext } from "../../../src/domain/contract/observation";
import type { BurstMessage } from "../../../src/domain/perception/burst";
import type { Audience, WireEvidence } from "../../../src/domain/perception/wire";
import type { CatalogProduct } from "../../../src/application/perception/matching";

export interface Recorded {
  readonly source: "live" | "authored";
  readonly audience: Audience;
  readonly messages: readonly BurstMessage[];
  readonly context: PerceptionContext;
  /** The message content the model returned, parsed. */
  readonly response: unknown;
  readonly usage: { readonly prompt_tokens: number; readonly completion_tokens: number } | null;
}

export const noContext: PerceptionContext = { openOrder: null, pendingQuestion: null };

/** A few bytes standing in for a photo. Never a real image. */
export function photo(): BurstMessage {
  return { type: "image", mimeType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer };
}

export const text = (body: string): BurstMessage => ({ type: "text", text: body });
export const voice = (transcript: string): BurstMessage => ({ type: "transcript", text: transcript });

export const quote = (message: number, words: string): WireEvidence => ({ message, quote: words, box: null });
export const box = (message: number, corners: readonly number[]): WireEvidence => ({ message, quote: null, box: corners });
export const none: WireEvidence = { message: null, quote: null, box: null };

export function line(
  textSaid: string,
  name: string,
  quantity: string | null,
  unit: string | null,
  evidence: WireEvidence,
  more: Record<string, unknown> = {},
): Record<string, unknown> {
  return { text: textSaid, name, quantity, unit, restricted: false, pick: null, evidence, ...more };
}

export function edit(op: "add" | "remove" | "set_quantity", fields: Record<string, unknown>): Record<string, unknown> {
  return { op, ref: null, said: null, text: null, name: null, quantity: null, unit: null, restricted: false, pick: null, evidence: none, ...fields };
}

export const authoredUsage = { prompt_tokens: 3_950, completion_tokens: 1_500 };

export function authored(
  audience: Audience,
  messages: readonly BurstMessage[],
  observations: readonly unknown[],
  context: PerceptionContext = noContext,
): Recorded {
  return { source: "authored", audience, messages, context, response: { observations }, usage: authoredUsage };
}

/**
 * The synthetic store catalog. Its order sets the labels: P1 Aceite Clover 1 L, P2 Aceite Clover
 * 500 ml, P3 Aceite Mazola 1 L, P4 Arroz 1 lb, P5 Azúcar 1 lb, P6 Jabón Xtra (as in the live check).
 */
export const catalog: readonly CatalogProduct[] = [
  { productId: "product-aceite-clover-1l", names: ["Aceite Clover 1 L"], aliases: ["aceite clover"], barcode: "7401000000011" },
  { productId: "product-aceite-clover-500ml", names: ["Aceite Clover 500 ml"], aliases: ["aceite clover"], barcode: null },
  { productId: "product-mazola-1l", names: ["Aceite Mazola 1 L"], aliases: ["mazola"], barcode: null },
  { productId: "product-arroz-1lb", names: ["Arroz 1 lb", "Arroz"], aliases: [], barcode: null },
  { productId: "product-azucar-1lb", names: ["Azúcar 1 lb", "Azúcar"], aliases: [], barcode: null },
  { productId: "product-jabon-xtra", names: ["Jabón Xtra"], aliases: ["jabon de barra"], barcode: null },
];
