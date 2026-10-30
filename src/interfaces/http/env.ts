import type { Runtime } from "../../composition";

export type HttpEnv = { Bindings: Env; Variables: { runtime: Runtime } };
