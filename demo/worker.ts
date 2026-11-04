/**
 * The demo Worker (K10): the app's own Worker with the real order engine and recorded perception.
 * DEMO ONLY: run by `./demo.sh` with `demo/wrangler.demo.jsonc`; `src/` never imports this file.
 */
import { buildRuntime, type Runtime } from "../src/composition";
import { DEMO_AGENT_ID } from "./agent";
import { OrderEngine } from "../src/application/engine/order-engine";
import { D1CustomerRepository } from "../src/infrastructure/d1/customer-repository";
import { D1DeedChecks } from "../src/infrastructure/d1/deed-checks";
import { D1FactLedger } from "../src/infrastructure/d1/fact-ledger";
import { D1OrderStore } from "../src/infrastructure/d1/order-store";
import { consoleLogger, randomIds, systemClock } from "../src/infrastructure/runtime";
import { createWorker } from "../src/index";
import { type Recording, recordedPerceptionHandler, recordingsFromBase64 } from "./recorded-perception";

/** The runner passes the recordings in this plain var; the app's own config has no such field. */
type DemoEnv = Env & { readonly DEMO_RECORDINGS?: string };

/** The real engine on D1 (the one the app's job handler uses), fed by recorded perception. */
export function demoRuntime(env: Env, recordings: readonly Recording[] = recordingsFromBase64((env as DemoEnv).DEMO_RECORDINGS)): Runtime {
  const orders = new D1OrderStore(env.DB);
  const engine = new OrderEngine({
    store: orders,
    ids: randomIds,
    ledger: new D1FactLedger(env.DB),
    checks: new D1DeedChecks(env.DB),
    clock: systemClock,
    log: consoleLogger,
    agentId: DEMO_AGENT_ID,
  });
  return buildRuntime(env, { engine, jobHandler: recordedPerceptionHandler({ engine, orders, clock: systemClock, recordings, customers: new D1CustomerRepository(env.DB) }) });
}

export default createWorker((env) => demoRuntime(env));
