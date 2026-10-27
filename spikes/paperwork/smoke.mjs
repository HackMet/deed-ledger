// Lane B: one-call smoke test (endpoint + strict schema + nullable union types).
import { chatJson, listCost, MODEL } from "./provider.mjs";
import { E5_SCHEMA, E5_PROMPT_V1 } from "./schemas.mjs";

const catalog = `Store A catalog: P-COCA2L "Coca 2 litros" aliases [coca 2l]; P-COCA500 "Coca 500 ml" aliases [coca 500].`;
const out = await chatJson({
  system: E5_PROMPT_V1,
  userParts: [{ type: "text", text: `${catalog}\nOwner message: "Entraron 5 cocas de dos litros."` }],
  schema: E5_SCHEMA,
  schemaName: "e5_disambiguation",
});
console.log("model:", out.model, "| expected:", MODEL);
console.log("latency_ms:", out.latencyMs);
console.log("usage:", JSON.stringify(out.usage));
console.log("cost_usd:", listCost(out.usage.input_tokens, out.usage.output_tokens).toFixed(6));
console.log("data:", JSON.stringify(out.data));
