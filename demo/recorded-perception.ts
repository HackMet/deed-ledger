/**
 * Recorded perception for the demo Worker (K10). DEMO ONLY: `src/` never imports this file.
 *
 * A scripted message's text is looked up in the recordings (`demo/recordings/*.json`) and the
 * recorded `BurstReading` goes to the real engine, as perception's output would. Every recording
 * says where it came from: `"source": "fixture"` (copied from test/fixtures/contract.ts, or built by
 * hand to the type) or `"source": "muse"` (a real Muse Spark output). A `muse` recording for the same
 * text replaces the fixture. `confirmar` and `cancelar` go to the fixture perception handler, which
 * reads exactly those words; any other text goes to the placeholder, never a guess.
 */
import type { CustomerContext, Engine, LineMatch } from "../src/application/engine";
import { type OpenOrderReader, fixturePerceptionHandler, render } from "../src/application/engine/fixture-perception-handler";
import { placeholderHandler } from "../src/application/placeholder-handler";
import type { Clock, JobHandler, JobInput, JobOutcome } from "../src/application/ports";
import type { BurstReading } from "../src/domain/contract/observation";
import { PLACEHOLDER_TTL_MS } from "../src/domain/outbox";

export type RecordingSource = "fixture" | "muse";

export interface Recording {
  readonly source: RecordingSource;
  readonly name: string;
  /** The message text this reading answers, as the customer sends it. */
  readonly text: string;
  readonly reading: BurstReading;
  /** Catalog matches found by code, not by the model. */
  readonly matches: readonly LineMatch[];
  readonly note?: string;
}

const HOW = new Set<LineMatch["how"]>(["barcode", "exact_name", "known_alias", "customer_history"]);

/** The words, normalised as the fixture handler does: lowercase, no accents, no edge punctuation or spaces. */
export function normalizeText(body: string): string {
  return body
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[\s.!¡¿?]+$/u, "")
    .replace(/^[\s.!¡¿?]+/u, "");
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks each recording's envelope and the reading's outer shape, and keeps the reading exactly as
 * recorded. A malformed file is an error: the demo must not run on half its recordings.
 */
export function parseRecordings(raw: readonly unknown[]): Recording[] {
  return raw.map((item, index) => {
    const where = isObject(item) && typeof item["name"] === "string" ? `recording "${item["name"]}"` : `recording #${index}`;
    if (!isObject(item)) throw new Error(`${where}: not an object`);
    const { source, name, text, reading, matches, note } = item;
    if (source !== "fixture" && source !== "muse") throw new Error(`${where}: source must be "fixture" or "muse"`);
    if (typeof name !== "string" || name === "") throw new Error(`${where}: name is required`);
    if (typeof text !== "string" || normalizeText(text) === "") throw new Error(`${where}: text is required`);
    if (!isObject(reading) || !Array.isArray(reading["observations"]) || !Array.isArray(reading["calls"])) {
      throw new Error(`${where}: reading must have observations and calls`);
    }
    if (!reading["observations"].every((o) => isObject(o) && typeof o["kind"] === "string")) {
      throw new Error(`${where}: every observation needs a kind`);
    }
    const list = matches === undefined ? [] : matches;
    if (!Array.isArray(list) || !list.every(isMatch)) throw new Error(`${where}: matches must be LineMatch values`);
    if (note !== undefined && typeof note !== "string") throw new Error(`${where}: note must be text`);
    return { source, name, text, reading: reading as unknown as BurstReading, matches: list, ...(note === undefined ? {} : { note }) };
  });
}

function isMatch(value: unknown): value is LineMatch {
  return (
    isObject(value) &&
    Number.isSafeInteger(value["observation"]) &&
    Number.isSafeInteger(value["line"]) &&
    typeof value["productId"] === "string" &&
    HOW.has(value["how"] as LineMatch["how"])
  );
}

/** One recording per text. A `muse` recording replaces a fixture; two of the same source are an error. */
export function indexRecordings(recordings: readonly Recording[]): ReadonlyMap<string, Recording> {
  const index = new Map<string, Recording>();
  for (const recording of recordings) {
    const key = normalizeText(recording.text);
    const held = index.get(key);
    if (held !== undefined && held.source === recording.source) {
      throw new Error(`recordings "${held.name}" and "${recording.name}" answer the same text`);
    }
    if (held === undefined || recording.source === "muse") index.set(key, recording);
  }
  return index;
}

/** The recordings the demo runner passes in `DEMO_RECORDINGS`: a JSON array, base64 of its UTF-8. */
export function recordingsFromBase64(encoded: string | undefined): Recording[] {
  if (encoded === undefined || encoded === "") return [];
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(raw)) throw new Error("DEMO_RECORDINGS must be a JSON array");
  return parseRecordings(raw);
}

const CUSTOMER_WORDS = new Set(["confirmar", "confirmo", "cancelar", "cancela"]);

export function recordedPerceptionHandler(deps: {
  readonly engine: Engine;
  readonly orders: OpenOrderReader;
  readonly clock: Clock;
  readonly recordings: readonly Recording[];
}): JobHandler {
  const index = indexRecordings(deps.recordings);
  const words = fixturePerceptionHandler(deps);
  return {
    async handle(input: JobInput): Promise<JobOutcome> {
      const { lease, job, isNewestOfBurst } = input;
      const text = job.kind === "text" && job.textBody !== null ? normalizeText(job.textBody) : null;
      if (text === null) return placeholderHandler.handle(input);
      if (CUSTOMER_WORDS.has(text)) return words.handle(input);
      const recording = index.get(text);
      if (recording === undefined) return placeholderHandler.handle(input);

      const context: CustomerContext = {
        businessId: lease.businessId,
        conversationId: lease.conversationId,
        // As in the fixture handler: the conversation is the customer, never an id from the message.
        customerId: lease.conversationId,
        jobId: job.id,
        nowMs: deps.clock.now(),
      };
      const result = await deps.engine.onBurst(context, recording.reading, recording.matches);
      return {
        replies: isNewestOfBurst ? [{ body: render(result.outcome), ttlMs: PLACEHOLDER_TTL_MS, closesBurst: true }] : [],
        commits: result.commits,
      };
    },
  };
}
