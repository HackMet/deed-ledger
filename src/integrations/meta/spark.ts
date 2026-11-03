/**
 * Muse Spark through Meta's Chat Completions API, with a strict json_schema response format.
 * The system prompt is the only system message; everything else is user content. No retries here:
 * the job queue retries, and the spend cap is reserved per attempt.
 */
import { isPromptCacheRetention, isReasoningEffort } from "../../application/model-settings";
import type { ModelContentPart, ModelProvider, ModelRequest, ModelResult } from "../../application/ports";
import { READING_MAX_MS } from "../../domain/processing";

export const META_API_BASE = "https://api.meta.ai/v1";
export const SPARK_MODEL = "muse-spark-1.3";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class ContributorModelError extends Error {
  constructor() {
    super("contributor model IDs are not allowed: Meta may train on their content (D-09)");
    this.name = "ContributorModelError";
  }
}

export function isContributorModel(model: string): boolean {
  return /contributor/i.test(model);
}

export class MuseSparkProvider implements ModelProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(options: {
    readonly apiKey: string;
    readonly fetch: Fetch;
    readonly model?: string;
    readonly timeoutMs?: number;
    readonly baseUrl?: string;
  }) {
    const model = options.model ?? SPARK_MODEL;
    if (isContributorModel(model)) throw new ContributorModelError();
    this.model = model;
    this.apiKey = options.apiKey;
    this.fetch = options.fetch;
    // The order reading sizes the conversation lease from the same number.
    this.timeoutMs = options.timeoutMs ?? READING_MAX_MS;
    this.baseUrl = options.baseUrl ?? META_API_BASE;
  }

  /** False when MODEL_API_KEY is blank: every call is refused without touching the network. */
  get configured(): boolean {
    return this.apiKey !== "";
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    if (!this.configured) return failure("rejected", null, 0);
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user.map(toChatPart) },
      ],
      // Chat Completions' output cap: reasoning plus visible tokens (Meta docs, reasoning).
      max_tokens: request.maxOutputTokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schemaName, schema: request.schema, strict: true },
      },
      // Only values Meta lists are sent ("none" is refused with HTTP 400); absent, Meta's defaults apply.
      ...(isReasoningEffort(request.reasoningEffort) ? { reasoning_effort: request.reasoningEffort } : {}),
      ...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
      ...(isPromptCacheRetention(request.promptCacheRetention) ? { prompt_cache_retention: request.promptCacheRetention } : {}),
    };

    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return failure("unavailable", null, Date.now() - started);
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const latencyMs = Date.now() - started;
    const usage = usageOf(payload);

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      return { ...failure(retryable ? "unavailable" : "rejected", response.status, latencyMs), ...usage };
    }
    const content = contentOf(payload);
    if (content === null) return { ...failure("invalid_json", response.status, latencyMs), ...usage };
    try {
      return { ok: true, json: JSON.parse(content), latencyMs, ...usage };
    } catch {
      return { ...failure("invalid_json", response.status, latencyMs), ...usage };
    }
  }
}

function failure(error: "rejected" | "unavailable" | "invalid_json", status: number | null, latencyMs: number): ModelResult {
  return { ok: false, error, status, latencyMs, inputTokens: null, outputTokens: null };
}

function toChatPart(part: ModelContentPart): unknown {
  if (part.type === "text") return { type: "text", text: part.text };
  return { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${base64(part.bytes)}` } };
}

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Null when there is no content, or when it was cut off at max_tokens: a partial answer isn't one. */
function contentOf(payload: unknown): string | null {
  const choices = (payload as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return null;
  const choice = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown } | undefined;
  if (choice?.finish_reason === "length") return null;
  const content = choice?.message?.content;
  return typeof content === "string" ? content : null;
}

interface Usage {
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
  readonly prompt_tokens_details?: { readonly cached_tokens?: unknown } | null;
  readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown } | null;
}

function usageOf(payload: unknown): Pick<ModelResult, "inputTokens" | "outputTokens" | "reasoningTokens" | "cachedTokens"> {
  const usage = (payload as { usage?: Usage } | null)?.usage;
  const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
  return {
    inputTokens: count(usage?.prompt_tokens),
    outputTokens: count(usage?.completion_tokens),
    reasoningTokens: count(usage?.completion_tokens_details?.reasoning_tokens),
    cachedTokens: count(usage?.prompt_tokens_details?.cached_tokens),
  };
}
