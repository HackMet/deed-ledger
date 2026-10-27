'use strict';
// ModelProvider (frozen TS shape) + Muse Spark implementation.
// Chat Completions: https://api.meta.ai/v1/chat/completions, Bearer MODEL_API_KEY.

const { chatCompletions, costUsd } = require('./lib');
const { E1_SCHEMA, E3_ANSWER_SCHEMA, E2_LINE_SCHEMA } = require('./schemas');
const { E1_SYSTEM, E3_SYSTEM } = require('./prompts');

const MAX_TOOL_CALLS = 4;

function responseFormat(name, schema, strict) {
  const js = { name, schema };
  if (strict !== null) js.strict = strict;
  return { type: 'json_schema', json_schema: js };
}

class SparkModelProvider {
  constructor({ apiKey, model }) {
    this.apiKey = apiKey;
    this.model = model;
    // Nullable strict-mode probe result: null until first proposeOperation call.
    this.strictNullable = null; // { accepted: bool, detail: string }
    this.strictFlag = true; // start strict; fall back to unconstrained-flag on 400
  }

  async proposeOperation(text) {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: E1_SYSTEM },
        { role: 'user', content: text },
      ],
      response_format: responseFormat('TypedOperation', E1_SCHEMA, this.strictFlag),
    };
    let res;
    try {
      res = await chatCompletions(this.apiKey, body);
    } catch (e) {
      // First-use probe: if strict rejects the nullable union types, fall back
      // to strict omitted (output still schema-constrained per Meta docs) once.
      if (this.strictNullable === null && this.strictFlag === true && e.status === 400) {
        this.strictNullable = { accepted: false, detail: `strict:true rejected (HTTP 400): ${(e.body || '').slice(0, 200)}; fell back to strict omitted` };
        this.strictFlag = null;
        body.response_format = responseFormat('TypedOperation', E1_SCHEMA, null);
        res = await chatCompletions(this.apiKey, body);
      } else throw e;
    }
    if (this.strictNullable === null) {
      this.strictNullable = { accepted: true, detail: 'strict:true accepted nullable ["type","null"] on first live call' };
    }
    return this._finish(res, 'proposeOperation');
  }

  // Lane B owns E2; implemented for interface completeness, NOT tested by Lane A.
  async extractPaper(imageBytes, mimeType = 'image/png') {
    const b64 = Buffer.from(imageBytes).toString('base64');
    const body = {
      model: this.model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Transcribe cada renglon visible del papel al esquema. Solo lo impreso/escrito; null lo ausente.' },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } },
      ] }],
      response_format: responseFormat('ExtractionLines', {
        type: 'object',
        properties: { lines: { type: 'array', items: E2_LINE_SCHEMA } },
        required: ['lines'], additionalProperties: false,
      }, true),
    };
    const res = await chatCompletions(this.apiKey, body);
    return this._finish(res, 'extractPaper');
  }

  // tools: { defs: OpenAI tools, execute(name, args): object }
  // userContext: { today, store } supplied by the APP, never the model.
  async answerWithTools(question, tools, userContext) {
    const messages = [
      { role: 'system', content: E3_SYSTEM },
      { role: 'user', content: `Hoy es ${userContext.today}. Tu tienda es ${userContext.store}. Pregunta del dueno: ${question}` },
    ];
    const calls = [];
    const usages = [];
    let latencyMs = 0;
    let retried = 0;
    let toolCallsUsed = 0;
    for (let turn = 0; turn <= MAX_TOOL_CALLS; turn++) {
      const body = {
        model: this.model,
        messages,
        tools: tools.defs,
        response_format: responseFormat('GroundedAnswer', E3_ANSWER_SCHEMA, true),
      };
      const res = await chatCompletions(this.apiKey, body);
      latencyMs += res.latencyMs;
      retried += res.retried;
      usages.push(res.json.usage || {});
      const msg = res.json.choices[0].message;
      const tcs = msg.tool_calls || [];
      if (!tcs.length) {
        const parsed = JSON.parse(msg.content);
        return { output: parsed, toolCalls: calls, usage: sumUsage(usages), latencyMs, retried, apiCalls: turn + 1, truncated: false };
      }
      calls.push(...tcs.map((tc) => ({ name: tc.function.name, args: safeJson(tc.function.arguments) })));
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: tcs });
      for (const tc of tcs) {
        toolCallsUsed++;
        if (toolCallsUsed > MAX_TOOL_CALLS) {
          return { output: null, toolCalls: calls, usage: sumUsage(usages), latencyMs, retried, apiCalls: turn + 1, truncated: true };
        }
        let result;
        try {
          result = tools.execute(tc.function.name, JSON.parse(tc.function.arguments || '{}'));
        } catch (e) {
          result = { error: String(e.message || e) };
        }
        calls[calls.length - (tcs.length - tcs.indexOf(tc))].result = result;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
    }
    return { output: null, toolCalls: calls, usage: sumUsage(usages), latencyMs, retried, apiCalls: MAX_TOOL_CALLS + 1, truncated: true };
  }

  _finish(res, op) {
    const msg = res.json.choices[0].message;
    let output;
    try {
      output = JSON.parse(msg.content);
    } catch (e) {
      throw new Error(`${op}: model content was not JSON: ${(msg.content || '').slice(0, 200)}`);
    }
    return { output, usage: res.json.usage || {}, latencyMs: res.latencyMs, retried: res.retried, apiCalls: 1 };
  }
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return { _raw: s }; }
}

function sumUsage(usages) {
  const u = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const x of usages) {
    u.prompt_tokens += x.prompt_tokens || 0;
    u.completion_tokens += x.completion_tokens || 0;
    u.total_tokens += x.total_tokens || 0;
  }
  return u;
}

module.exports = { SparkModelProvider, MAX_TOOL_CALLS, costOf: costUsd };
