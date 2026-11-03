/**
 * Per-call settings for Muse Spark's Chat Completions: how hard it reasons, and how its prompt
 * cache groups requests. Values per Meta's docs (checked Nov 2, 2026): `reasoning_effort` takes
 * the values below ("max" only on standard muse-spark-1.3); "none" is not one of them, and Muse
 * Spark answers it with HTTP 400. Left out, the model picks its own effort (it always reasons).
 * `prompt_cache_retention` takes "in_memory" or "24h"; left out, Meta's default applies.
 */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const PROMPT_CACHE_RETENTIONS = ["in_memory", "24h"] as const;
export type PromptCacheRetention = (typeof PROMPT_CACHE_RETENTIONS)[number];

/** One call site's settings. Absent fields are not sent: the provider's defaults apply. */
export interface ModelCallSettings {
  readonly reasoningEffort?: ReasoningEffort;
  readonly promptCacheRetention?: PromptCacheRetention;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function isPromptCacheRetention(value: unknown): value is PromptCacheRetention {
  return typeof value === "string" && (PROMPT_CACHE_RETENTIONS as readonly string[]).includes(value);
}
