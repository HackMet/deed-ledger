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
import { meteredCall, type MeteredCallDeps } from "../metered-call";
import type { ModelRequest, Tenant } from "../ports";
import { labelCatalog, matchLines, resolvePicks, type CatalogProduct, type LabelMatch } from "./matching";
import { PLANNER_MODE_PROMPT, PROMPT_VERSION, SYSTEM_PROMPT, userContent } from "./prompt";

export { boundMicroUsd, DEFAULT_DAILY_CAP_MICRO_USD, inputTokenBound } from "../metered-call";

/**
 * The output cap, sent as Chat Completions `max_tokens`. Meta's reasoning docs: on Chat Completions
 * `max_tokens` caps reasoning plus visible output together, and reasoning is billed as output. The
 * live check used 1,287-1,620 reasoning tokens and 1,400-1,815 in all; 8,192 leaves room for a long
 * invoice without starving the reasoning. A cut-off answer reads as invalid output, never as data.
 */
export const MAX_OUTPUT_TOKENS = 8_192;

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
  /**
   * Planner mode (D-45): no catalog labels and no pick rules in the prompt, so the reader only says
   * what was said; code still matches lines exactly across the whole catalog. Absent: classic.
   */
  readonly withoutLabels?: boolean;
}

export class BurstReader {
  constructor(private readonly deps: MeteredCallDeps) {}

  async read(tenant: Tenant, request: ReadRequest): Promise<ReadOutcome> {
    const { log } = this.deps;
    const messages = request.messages.map(sendable);
    const plannerMode = request.withoutLabels === true && request.audience === "customer";
    const catalog = labelCatalog(plannerMode ? [] : request.catalog);
    const context = { ...request.context, catalogLabels: catalog.labels };

    if (messages.length === 0) {
      return { ok: true, reading: { observations: [{ kind: "other", issues: [] }], calls: [] }, matches: [], labelMatches: [] };
    }

    const promptVersion = plannerMode ? PLANNER_MODE_PROMPT.version : PROMPT_VERSION[request.audience];
    const modelRequest: ModelRequest = {
      system: plannerMode ? PLANNER_MODE_PROMPT.text : SYSTEM_PROMPT[request.audience],
      user: userContent(messages, context, { catalogSection: !plannerMode }),
      schemaName: READING_SCHEMA_NAME,
      schema: readingSchema(request.audience),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      promptCacheKey: readerCacheKey(promptVersion),
    };
    const called = await meteredCall(this.deps, tenant, modelRequest, { promptVersion, logPrefix: "perception" });
    if (!called.ok) return { ok: false, reason: called.reason, calls: called.calls };

    const validated = validateReading(called.json, request.audience, messages, context);
    if (!validated.ok) {
      // Not the mismatch path: an unexpected key is the model's text, and logs carry no content.
      log.warn("perception.invalid_output", { businessId: tenant.businessId, reason: "schema" });
      return { ok: false, reason: "invalid_output", calls: [called.call] };
    }

    const matches = matchLines(validated.observations, request.catalog);
    const labelMatches = resolvePicks(validated.picks, catalog, matches);
    log.info("perception.read", { businessId: tenant.businessId, count: validated.observations.length, outcome: "ok" });
    return { ok: true, reading: { observations: validated.observations, calls: [called.call] }, matches, labelMatches };
  }
}

/** One cache group per fixed prompt: the system prompt and schema are the same bytes for every store. */
export function readerCacheKey(promptVersion: string): string {
  return `reader:${promptVersion}`;
}

/** Photos Meta can't read keep their place in the burst but aren't sent. */
function sendable(message: BurstMessage): BurstMessage {
  return message.type === "image" && message.bytes && !isSupportedImage(message.mimeType) ? { ...message, bytes: null } : message;
}
