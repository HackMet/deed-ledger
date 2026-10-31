/**
 * The console's reader: what a logged-in member typed, photographed or (later) said, read by Muse
 * Spark into the contract's observations, for a screen to show. It decides nothing and saves no
 * observation: confirming what was read is the engine's job (contract gap (i), not agreed yet).
 *
 * - The store is the member's, from the session. Nothing in the request names a store.
 * - Photos are stored first, in R2 under the store's own prefix, keyed by their hash.
 * - "report" reads the console kinds (sale_report, fiado_report, setup_card, supplier_invoice).
 *   "order" is Pedido a mano: staff write down what a customer asked for in person, read like a
 *   customer's first message with no open order. Only order kinds survive that reading.
 * - Text and photos are data, never instructions (the reader's fixed prompt and checks).
 * - Every call goes through the reader's daily spend cap.
 */
import type { BurstReading, Observation, ObservationKind } from "../domain/contract/observation";
import { looksLikeAudio, sniffImageType } from "../domain/image-type";
import { storePrefix } from "../domain/media";
import type { BurstMessage } from "../domain/perception/burst";
import type { LineMatch } from "./engine";
import type { CatalogProduct, LabelMatch } from "./perception/matching";
import type { ReadOutcome, ReadRequest } from "./perception/reader";
import type { Logger, MediaStore, StoredMedia, Tenant } from "./ports";

/** Photos larger than this are refused before anything is stored or sent. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** A typed note or a transcript; about two minutes of speech is well under this. */
export const MAX_TEXT_CHARS = 2_000;
/** Pieces read together as one burst: a photo and a typed note, say. */
export const MAX_PARTS = 3;

export type ConsolePurpose = "report" | "order";

export type ConsoleInput =
  | { readonly type: "text"; readonly text: string }
  /** A voice note already transcribed (Muse Voice Transcribe, #27). */
  | { readonly type: "transcript"; readonly text: string }
  /** Bytes as uploaded. The content type is the client's claim; the bytes decide. */
  | { readonly type: "photo"; readonly bytes: ArrayBuffer; readonly contentType: string }
  /** Recorded audio. Not read yet: voice comes with #27. */
  | { readonly type: "audio"; readonly bytes: ArrayBuffer; readonly contentType: string };

export interface ConsoleReadRequest {
  readonly purpose: ConsolePurpose;
  /** In order, oldest first. Evidence points at these by position. */
  readonly inputs: readonly ConsoleInput[];
}

export type ConsoleReadOutcome =
  | {
      readonly ok: true;
      readonly purpose: ConsolePurpose;
      readonly reading: BurstReading;
      readonly matches: readonly LineMatch[];
      readonly labelMatches: readonly LabelMatch[];
      /** The stored photos, in input order (only photos are stored). */
      readonly media: readonly StoredMedia[];
    }
  | {
      readonly ok: false;
      /**
       * empty: nothing to read. too_many: more than MAX_PARTS. too_large: a photo or text over its
       * limit. unsupported_photo: not a JPEG, PNG, GIF or WebP. voice_not_ready: audio, until #27.
       * The rest come from the reader (spend_cap, rejected, unavailable, invalid_output).
       */
      readonly reason:
        | "empty"
        | "too_many"
        | "too_large"
        | "unsupported_photo"
        | "voice_not_ready"
        | Extract<ReadOutcome, { ok: false }>["reason"];
      readonly media: readonly StoredMedia[];
    };

export interface ConsoleReaderDeps {
  readonly reader: { read(tenant: Tenant, request: ReadRequest): Promise<ReadOutcome> };
  readonly mediaStore: MediaStore;
  readonly log: Logger;
  /** The store's catalog, read inside the tenant's scope. None until a catalog repository exists. */
  readonly catalog?: (tenant: Tenant) => Promise<readonly CatalogProduct[]>;
}

/** Kinds a Pedido a mano reading keeps; anything else reads as `other`. */
const ORDER_KINDS: ReadonlySet<ObservationKind> = new Set(["customer_order", "fulfillment", "customer_name", "other"]);

export function consoleMediaPrefix(businessId: string): string {
  return `${storePrefix(businessId)}console`;
}

export async function readConsoleInput(
  deps: ConsoleReaderDeps,
  /** The session's member (a `ConsoleMember` fits). Only its store is used. */
  member: Tenant,
  request: ConsoleReadRequest,
): Promise<ConsoleReadOutcome> {
  // Only the store, never anything else from the caller's object, scopes what follows.
  const tenant: Tenant = { businessId: member.businessId };
  const refuse = (reason: Extract<ConsoleReadOutcome, { ok: false }>["reason"], media: readonly StoredMedia[] = []) => {
    deps.log.info("console_reader.refused", { businessId: tenant.businessId, reason });
    return { ok: false as const, reason, media };
  };

  const inputs = request.inputs.filter((input) => !(isText(input) && input.text.trim() === ""));
  if (inputs.length === 0) return refuse("empty");
  if (inputs.length > MAX_PARTS) return refuse("too_many");

  // Every check before anything is stored or spent.
  const checked: (BurstMessage | { readonly type: "photo"; readonly bytes: ArrayBuffer; readonly mimeType: string })[] = [];
  for (const input of inputs) {
    if (isText(input)) {
      if (input.text.length > MAX_TEXT_CHARS) return refuse("too_large");
      checked.push({ type: input.type, text: input.text });
      continue;
    }
    if (input.bytes.byteLength > MAX_PHOTO_BYTES) return refuse("too_large");
    if (input.type === "audio" || looksLikeAudio(input.bytes, input.contentType)) return refuse("voice_not_ready");
    const mimeType = sniffImageType(input.bytes);
    if (mimeType === null) return refuse("unsupported_photo");
    checked.push({ type: "photo", bytes: input.bytes, mimeType });
  }

  const media: StoredMedia[] = [];
  const messages: BurstMessage[] = [];
  for (const part of checked) {
    if (part.type !== "photo") {
      messages.push(part);
      continue;
    }
    media.push(await deps.mediaStore.putImmutable(tenant, consoleMediaPrefix(tenant.businessId), { bytes: part.bytes, contentType: part.mimeType }));
    messages.push({ type: "image", mimeType: part.mimeType, bytes: part.bytes });
  }

  const catalog = deps.catalog ? await deps.catalog(tenant) : [];
  const outcome = await deps.reader.read(tenant, {
    audience: request.purpose === "order" ? "customer" : "console",
    messages,
    // A console note has no open order and answers no question.
    context: { openOrder: null, pendingQuestion: null },
    catalog,
  });
  if (!outcome.ok) return refuse(outcome.reason, media);

  const result = request.purpose === "order" ? keepOrderKinds(outcome) : outcome;
  deps.log.info("console_reader.read", {
    businessId: tenant.businessId,
    count: result.reading.observations.length,
    outcome: request.purpose,
  });
  return { ok: true, purpose: request.purpose, reading: result.reading, matches: result.matches, labelMatches: result.labelMatches, media };
}

function isText(input: ConsoleInput): input is Extract<ConsoleInput, { type: "text" | "transcript" }> {
  return input.type === "text" || input.type === "transcript";
}

/**
 * Pedido a mano starts a new order. A change, cancel, payment, question, handoff or stop typed by
 * staff isn't one, so it reads as `other`, keeping only a warning about embedded instructions.
 * Positions stay, so matches of kept observations keep their indexes.
 */
function keepOrderKinds(outcome: Extract<ReadOutcome, { ok: true }>): Extract<ReadOutcome, { ok: true }> {
  const dropped = new Set<number>();
  const observations: Observation[] = outcome.reading.observations.map((observation, index) => {
    if (ORDER_KINDS.has(observation.kind)) return observation;
    dropped.add(index);
    const warnings = observation.issues
      .filter((issue) => issue.code === "embedded_instructions")
      .map((issue) => ({ ...issue, line: null }));
    return { kind: "other", issues: warnings };
  });
  return {
    ...outcome,
    reading: { ...outcome.reading, observations },
    matches: outcome.matches.filter((match) => !dropped.has(match.observation)),
    labelMatches: outcome.labelMatches.filter((match) => !dropped.has(match.observation)),
  };
}
