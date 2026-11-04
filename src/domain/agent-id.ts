import { sha256Hex } from "./sha256";

/**
 * The configuration that makes an agent's claims: the model, every prompt version and every schema
 * name the agent sends. Order doesn't matter; the id sorts both lists.
 */
export interface AgentConfiguration {
  readonly model: string;
  readonly promptVersions: readonly string[];
  readonly schemaNames: readonly string[];
}

/**
 * C11: the agent's id, 8 lowercase hex characters of sha256 over the configuration. The same
 * configuration gives the same id; changing any prompt version or the model gives a new one.
 */
export function agentIdOf(configuration: AgentConfiguration): string {
  const canonical = JSON.stringify({
    model: configuration.model,
    promptVersions: [...configuration.promptVersions].sort(),
    schemaNames: [...configuration.schemaNames].sort(),
  });
  return sha256Hex(canonical).slice(0, 8);
}
