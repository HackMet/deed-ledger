/**
 * Reads one burst with one model call: reserve the store's spend, call Muse Spark with the fixed
 * prompt and the burst as user content, check the output (schema, then contract rules), settle the
 * spend, and match lines to the catalog by code. It decides nothing and saves nothing else.
 *
 * One call per burst: the live check of Oct 30 showed strict json_schema accepts the union of
 * observation kinds nested inside the root object (docs/handoffs/2026-10-31-reading.md).
 */
import type { BurstReading, ModelCall, PerceptionContext } from "../../domain/contract/observation";
import { isSupportedImage, type BurstMessage } from "../../domain/perception/burst";
import { validateReading } from "../../domain/perception/validate";
import { READING_SCHEMA_NAME, readingSchema, type Audience } from "../../domain/perception/wire";
import type { LineMatch } from "../engine";
import type { Clock, Logger, ModelProvider, ModelRequest, SpendLedger, Tenant } from "../ports";
import { labelCatalog, matchLines, resolvePicks, type CatalogProduct, type LabelMatch } from "./matching";
import { PROMPT_VERSION, SYSTEM_PROMPT, userContent } from "./prompt";

/** Muse Spark 1.3 list prices in micro-dollars per token ($1.25 and $4.25 per million). */
const INPUT_MICRO_USD_PER_TOKEN = 1.25;
const OUTPUT_MICRO_USD_PER_TOKEN = 4.25;

/**
 * The output cap, sent as Chat Completions `max_tokens`. Meta's reasoning docs: on Chat Completions
 * `max_tokens` caps reasoning plus visible output together, and reasoning is billed as output. The
 * live check used 1,287-1,620 reasoning tokens and 1,400-1,815 in all; 8,192 leaves room for a long
 * invoice without starving the reasoning. A cut-off answer reads as invalid output, never as data.
 */
export const MAX_OUTPUT_TOKENS = 8_192;

/**
 * Input upper bound. Text: one token per UTF-8 byte of everything sent (system prompt, user parts,
 * schema), which holds for a byte-level BPE tokenizer: every token covers at least one byte. The
 * live order request is about 16,600 bytes and was billed 3,956 tokens. Plus Meta's chat formatting (about 110
 * tokens for a short request, per its docs) with margin. A photo is about 1,300-1,500 tokens at
 * 1280 px (Meta's docs) but the model may resize it, so the per-photo figure is a generous estimate,
 * not a proven bound.
 */
const REQUEST_OVERHEAD_TOKENS = 1_024;
const TOKENS_PER_IMAGE = 4_096;

/** US$2 a day per store unless the caller says otherwise. */
export const DEFAULT_DAILY_CAP_MICRO_USD = 2_000_000;

export type ReadOutcome =
  | {
      readonly ok: true;
      readonly reading: BurstReading;
      /** Found by code: barcode, exact name, known alias. */
      readonly matches: readonly LineMatch[];
      /** The model's pick among labels code supplied, for lines code couldn't match. */
      readonly labelMatches: readonly LabelMatch[];
    }
  | {
      readonly ok: false;
      /**
       * spend_cap: today's cap is reached, no call made. rejected: the provider refused the request.
       * unavailable: try later. invalid_output: the output didn't fit the schema; nothing was read.
       */
      readonly reason: "spend_cap" | "rejected" | "unavailable" | "invalid_output";
      readonly calls: readonly ModelCall[];
    };

export interface ReadRequest {
  readonly audience: Audience;
  readonly messages: readonly BurstMessage[];
  readonly context: PerceptionContext;
  /** The store's catalog, already scoped to the tenant by the caller's repository. */
  readonly catalog: readonly CatalogProduct[];
}

export class BurstReader {
  constructor(
    private readonly deps: {
      readonly provider: ModelProvider;
      readonly spend: SpendLedger;
      readonly clock: Clock;
      readonly log: Logger;
      readonly dailyCapMicroUsd?: number;
    },
  ) {}

  async read(tenant: Tenant, request: ReadRequest): Promise<ReadOutcome> {
    const { provider, spend, clock, log } = this.deps;
    const messages = request.messages.map(sendable);
    const catalog = labelCatalog(request.catalog);
    const context = { ...request.context, catalogLabels: catalog.labels };

    if (messages.length === 0) {
      return { ok: true, reading: { observations: [{ kind: "other", issues: [] }], calls: [] }, matches: [], labelMatches: [] };
    }

    const modelRequest: ModelRequest = {
      system: SYSTEM_PROMPT[request.audience],
      user: userContent(messages, context),
      schemaName: READING_SCHEMA_NAME,
      schema: readingSchema(request.audience),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    };
    // The reservation is the most this call can cost, so a call admitted near the cap can't pass it.
    const bound = boundMicroUsd(modelRequest);
    const reservation = await spend.reserve(tenant, clock.now(), bound, this.deps.dailyCapMicroUsd ?? DEFAULT_DAILY_CAP_MICRO_USD);
    if (!reservation) {
      log.warn("perception.spend_cap", { businessId: tenant.businessId, reason: "spend_cap" });
      return { ok: false, reason: "spend_cap", calls: [] };
    }

    const result = await provider.complete(modelRequest);
    const call: ModelCall = {
      model: provider.model,
      promptVersion: PROMPT_VERSION[request.audience],
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };

    // A refused request costs nothing; an unknown outcome keeps the bound; otherwise the usage.
    const actual = !result.ok && result.error === "rejected" ? 0 : (actualMicroUsd(result.inputTokens, result.outputTokens) ?? bound);
    if (actual > reservation.microUsd) {
      // The bound was wrong (a photo bigger than estimated, or usage over max_tokens). The ledger
      // records what was spent, so the next reservation sees it; the overshoot (micro-USD) is logged.
      log.warn("perception.spend_over_bound", { businessId: tenant.businessId, reason: "over_bound", count: actual - reservation.microUsd });
    }
    await spend.settle(reservation, actual);

    if (!result.ok) {
      const reason = result.error === "invalid_json" ? "invalid_output" : result.error;
      log.warn("perception.failed", { businessId: tenant.businessId, reason, status: result.status ?? "none" });
      return { ok: false, reason, calls: [call] };
    }

    const validated = validateReading(result.json, request.audience, messages, context);
    if (!validated.ok) {
      // Not the mismatch path: an unexpected key is the model's text, and logs carry no content.
      log.warn("perception.invalid_output", { businessId: tenant.businessId, reason: "schema" });
      return { ok: false, reason: "invalid_output", calls: [call] };
    }

    const matches = matchLines(validated.observations, request.catalog);
    const labelMatches = resolvePicks(validated.picks, catalog, matches);
    log.info("perception.read", { businessId: tenant.businessId, count: validated.observations.length, outcome: "ok" });
    return { ok: true, reading: { observations: validated.observations, calls: [call] }, matches, labelMatches };
  }
}

/** Photos Meta can't read keep their place in the burst but aren't sent. */
function sendable(message: BurstMessage): BurstMessage {
  return message.type === "image" && message.bytes && !isSupportedImage(message.mimeType) ? { ...message, bytes: null } : message;
}

/** The most a request can cost: its input upper bound plus the full output cap, in micro-dollars. */
export function boundMicroUsd(request: ModelRequest): number {
  return Math.ceil(inputTokenBound(request) * INPUT_MICRO_USD_PER_TOKEN + request.maxOutputTokens * OUTPUT_MICRO_USD_PER_TOKEN);
}

export function inputTokenBound(request: ModelRequest): number {
  let tokens = REQUEST_OVERHEAD_TOKENS + utf8Bytes(request.system) + utf8Bytes(request.schemaName) + utf8Bytes(JSON.stringify(request.schema));
  for (const part of request.user) tokens += part.type === "text" ? utf8Bytes(part.text) : TOKENS_PER_IMAGE;
  return tokens;
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function actualMicroUsd(inputTokens: number | null, outputTokens: number | null): number | null {
  if (inputTokens === null || outputTokens === null) return null;
  return Math.ceil(inputTokens * INPUT_MICRO_USD_PER_TOKEN + outputTokens * OUTPUT_MICRO_USD_PER_TOKEN);
}
