import { type AgentConfiguration } from "../../domain/agent-id";
import { READING_SCHEMA_NAME } from "../../domain/perception/wire";
import { PLANNER_MODE_PROMPT, PROMPT_VERSION } from "./prompt";

/**
 * The configuration the burst reader sends to the model (C11): the model it names, every prompt version
 * it can use (per audience, and the planner mode's), and the schema name of its one call. The model is
 * passed in by the composition root, so this module never imports an integration.
 */
export function readerConfiguration(model: string): AgentConfiguration {
  return {
    model,
    promptVersions: [...Object.values(PROMPT_VERSION), PLANNER_MODE_PROMPT.version],
    schemaNames: [READING_SCHEMA_NAME],
  };
}
