// Lane B: minimal Meta Model API client for E2 (vision) + E5 (text).
// Chat Completions, OpenAI-style, strict structured output. Node 22 fetch.
const BASE = "https://api.meta.ai/v1";
export const MODEL = "muse-spark-1.3";
export const PRICE_URL = "https://dev.meta.ai/docs/pricing-rate-limits";
export const PRICE_IN_PER_M = 1.25; // USD per 1M input tokens (Spark 1.3 standard)
export const PRICE_OUT_PER_M = 4.25; // USD per 1M output tokens

export function listCost(inputTokens, outputTokens) {
  return (inputTokens * PRICE_IN_PER_M + outputTokens * PRICE_OUT_PER_M) / 1e6;
}

export async function chatJson({ system, userParts, schema, schemaName }) {
  const key = process.env.MODEL_API_KEY;
  if (!key) throw new Error("MODEL_API_KEY is not set");
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userParts },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      },
    }),
  });
  const latencyMs = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`API ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    err.latencyMs = latencyMs;
    throw err;
  }
  const body = JSON.parse(text);
  const content = body.choices?.[0]?.message?.content ?? "";
  const usage = body.usage ?? {};
  return {
    data: JSON.parse(content),
    raw: content,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
    latencyMs,
    model: body.model ?? MODEL,
  };
}
