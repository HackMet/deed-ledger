import { buildRuntime, type Runtime } from "./composition";
import { createHttpApp } from "./interfaces/http/app";
import { handleQueueBatch } from "./interfaces/queue";
import { handleScheduled } from "./interfaces/scheduled";

/** The Worker: webhook intake (fetch), the processor (queue) and the sweep (scheduled). */
export function createWorker(makeRuntime: (env: Env) => Runtime = (env) => buildRuntime(env)) {
  const app = createHttpApp(makeRuntime);
  return {
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    queue: (batch, env, _ctx) => handleQueueBatch(batch, makeRuntime(env).deps),
    scheduled: (_controller, env, _ctx) => handleScheduled(makeRuntime(env).deps),
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
