/**
 * The demo's agent id names the recordings, not a live Muse call: the same configuration as the app's, but
 * with the model named `recorded:` so its id never equals production's and a judge can tell them apart.
 * Its own module, not demo/worker.ts: wrangler reads every export of the Worker's entry file as a binding.
 */
import { agentIdOf } from "../src/domain/agent-id";
import { readerConfiguration } from "../src/application/perception/agent";
import { SPARK_MODEL } from "../src/integrations/meta/spark";

export const DEMO_AGENT_ID = agentIdOf({ ...readerConfiguration(SPARK_MODEL), model: `recorded:${SPARK_MODEL}` });
