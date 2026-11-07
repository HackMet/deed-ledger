import { buildRuntime, type Runtime } from "./composition";
import { createHttpApp } from "./interfaces/http/app";
import { DEMO_SEED_QUEUE, handleQueueBatch, handleSeedBatch } from "./interfaces/queue";
import { handleScheduled } from "./interfaces/scheduled";

/**
 * The Worker: webhook intake (fetch), the processor (the jobs queue), demo stores' history (the
 * demo-seed queue) and the sweep (scheduled).
 */
export function createWorker(makeRuntime: (env: Env) => Runtime = (env) => buildRuntime(env)) {
  const app = createHttpApp(makeRuntime);
  return {
    fetch: (request, env, ctx) => app.fetch(request, env, ctx),
    queue: (batch, env, _ctx) => {
      const runtime = makeRuntime(env);
      if (batch.queue === DEMO_SEED_QUEUE) return handleSeedBatch(batch, runtime.deps, runtime.demoHistory);
      return handleQueueBatch(batch, runtime.deps, runtime.demoHistory);
    },
    scheduled: (_controller, env, _ctx) => handleScheduled(makeRuntime(env).deps),
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
