/**
 * One Muse Spark call behind the store's daily spend cap, shared by the reader and the planner:
 * reserve the most the call can cost, call, settle what it really cost. Logs carry IDs, codes,
 * latency and token counts only, under the caller's prefix ("perception", "planner"). Nothing here
 * reads the output.
 *
 * The call site's settings (reasoning effort, cache retention) go on the request as sent. They
 * never change the reservation: `max_tokens` caps reasoning plus output at every effort, so the
 * bound below holds whatever the effort, and a lower effort only settles lower.
 */
import type { ModelCall } from "../domain/contract/observation";
import type { ModelCallSettings } from "./model-settings";
import type { Clock, LogFields, Logger, ModelProvider, ModelRequest, ModelResult, SpendLedger, Tenant } from "./ports";

/** Muse Spark 1.3 list prices in micro-dollars per token ($1.25 and $4.25 per million). */
const INPUT_MICRO_USD_PER_TOKEN = 1.25;
const OUTPUT_MICRO_USD_PER_TOKEN = 4.25;

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

export interface MeteredCallDeps {
  readonly provider: ModelProvider;
  readonly spend: SpendLedger;
  readonly clock: Clock;
  readonly log: Logger;
  readonly dailyCapMicroUsd?: number;
  /** This call site's reasoning effort and cache retention; absent, Meta's defaults. */
  readonly settings?: ModelCallSettings;
}

export type MeteredOutcome =
  | { readonly ok: true; readonly json: unknown; readonly call: ModelCall }
  | {
      readonly ok: false;
      /**
       * spend_cap: today's cap is reached, no call made. rejected: the provider refused the request.
       * unavailable: try later. invalid_output: the content wasn't JSON (or was cut off).
       */
      readonly reason: "spend_cap" | "rejected" | "unavailable" | "invalid_output";
      readonly calls: readonly ModelCall[];
    };

export async function meteredCall(
  deps: MeteredCallDeps,
  tenant: Tenant,
  request: ModelRequest,
  meta: { readonly promptVersion: string; readonly logPrefix: string },
): Promise<MeteredOutcome> {
  const { provider, spend, clock, log } = deps;
  const prefix = meta.logPrefix;
  const sent: ModelRequest = { ...request, ...deps.settings };
  // The reservation is the most this call can cost, so a call admitted near the cap can't pass it.
  const bound = boundMicroUsd(sent);
  const reservation = await spend.reserve(tenant, clock.now(), bound, deps.dailyCapMicroUsd ?? DEFAULT_DAILY_CAP_MICRO_USD);
  if (!reservation) {
    log.warn(`${prefix}.spend_cap`, { businessId: tenant.businessId, reason: "spend_cap" });
    return { ok: false, reason: "spend_cap", calls: [] };
  }

  const result = await provider.complete(sent);
  const call: ModelCall = {
    model: provider.model,
    promptVersion: meta.promptVersion,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
  log.info(`${prefix}.model_call`, {
    businessId: tenant.businessId,
    outcome: result.ok ? "ok" : result.error,
    latencyMs: result.latencyMs,
    effort: sent.reasoningEffort ?? "default",
    ...usageFields(result),
  });

  // A refused request costs nothing; an unknown outcome keeps the bound; otherwise the usage.
  const actual = !result.ok && result.error === "rejected" ? 0 : (actualMicroUsd(result.inputTokens, result.outputTokens) ?? bound);
  if (actual > reservation.microUsd) {
    // The bound was wrong (a photo bigger than estimated, or usage over max_tokens). The ledger
    // records what was spent, so the next reservation sees it; the overshoot (micro-USD) is logged.
    log.warn(`${prefix}.spend_over_bound`, { businessId: tenant.businessId, reason: "over_bound", count: actual - reservation.microUsd });
  }
  await spend.settle(reservation, actual);

  if (!result.ok) {
    const reason = result.error === "invalid_json" ? "invalid_output" : result.error;
    log.warn(`${prefix}.failed`, { businessId: tenant.businessId, reason, status: result.status ?? "none" });
    return { ok: false, reason, calls: [call] };
  }
  return { ok: true, json: result.json, call };
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

/** Token counts for the log line; a count the provider didn't report is left out. */
function usageFields(result: ModelResult): LogFields {
  const fields: { [K in "inputTokens" | "cachedTokens" | "outputTokens" | "reasoningTokens"]?: number } = {};
  if (result.inputTokens !== null) fields.inputTokens = result.inputTokens;
  if (typeof result.cachedTokens === "number") fields.cachedTokens = result.cachedTokens;
  if (result.outputTokens !== null) fields.outputTokens = result.outputTokens;
  if (typeof result.reasoningTokens === "number") fields.reasoningTokens = result.reasoningTokens;
  return fields;
}

const encoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function actualMicroUsd(inputTokens: number | null, outputTokens: number | null): number | null {
  if (inputTokens === null || outputTokens === null) return null;
  return Math.ceil(inputTokens * INPUT_MICRO_USD_PER_TOKEN + outputTokens * OUTPUT_MICRO_USD_PER_TOKEN);
}
