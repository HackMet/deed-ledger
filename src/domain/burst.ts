/**
 * Rules for reading a customer's burst and their taps. Pure: no I/O. Everything here reads
 * untrusted input (message text, button IDs) and returns at most a claim for the engine to check.
 */

/** A reading looks back this far for messages no reading has used yet. */
export const BURST_LOOKBACK_MS = 60 * 60 * 1000;

/**
 * The most messages one reading takes. Intake admits at most 300 messages an hour per conversation
 * and a reading looks back an hour, so a burst reaches this only if something is wrong; then the
 * reading fails loudly (BurstTooLargeError) instead of leaving messages unread with no job left.
 */
export const BURST_MAX_MESSAGES = 300;

/** Button IDs are operation keys, and WhatsApp allows 256 characters for a reply button's ID. */
export const OPERATION_KEY_MAX_CHARS = 256;

/** The readback's three answers. */
export type ReadbackWord = "confirm" | "correct" | "cancel";

/** An answer to a readback: the word, and the order version it answers. Not yet checked by anyone. */
export interface ReadbackAnswer {
  readonly word: ReadbackWord;
  readonly orderId: string;
  readonly version: number;
}

const TYPED_WORDS: ReadonlyMap<string, ReadbackWord> = new Map([
  ["confirmar", "confirm"],
  ["corregir", "correct"],
  ["cancelar", "cancel"],
]);

/**
 * "Confirmar", "CONFIRMAR", "confirmár!" and the like: the readback's words typed alone, in any case,
 * with or without accents and surrounding punctuation. Anything longer is a message to read.
 */
export function typedReadbackWord(text: string | null): ReadbackWord | null {
  if (text === null) return null;
  const folded = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s.,;:!¡?¿]+/gu, " ")
    .trim();
  return TYPED_WORDS.get(folded) ?? null;
}

/**
 * A reply button's ID, `confirm:<order>:v<version>` (or correct, cancel). Untrusted: the order is
 * resolved only among the customer's own orders, by the engine. Null when it isn't one of ours.
 */
export function parseReadbackButton(replyId: string | null): ReadbackAnswer | null {
  if (replyId === null || replyId.length > OPERATION_KEY_MAX_CHARS) return null;
  const match = /^(confirm|correct|cancel):(\S+):v([1-9][0-9]{0,8})$/u.exec(replyId);
  if (match === null) return null;
  const [, word, orderId, version] = match;
  return { word: word as ReadbackWord, orderId: orderId!, version: Number(version) };
}

/** The operation key a button and the same word typed share: one confirmation, saved once. */
export function readbackOperationKey(answer: ReadbackAnswer): string {
  return `${answer.word}:${answer.orderId}:v${answer.version}`;
}

/** The button ID for an answer, as the readback reply will carry it. */
export const readbackButtonId = readbackOperationKey;
