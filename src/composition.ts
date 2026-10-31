/**
 * Composition root: the one place that turns env bindings into the application's dependencies.
 * Tests pass overrides for providers (channel, doorbell, media source, clock) and keep the real
 * D1 repositories.
 */
import type { Engine } from "./application/engine";
import { createOrderHandler } from "./application/order-handler";
import { placeholderHandler } from "./application/placeholder-handler";
import type { Deps, Pendientes } from "./application/ports";
import { type Config, readConfig } from "./infrastructure/config";
import { D1ConsoleAuthRepository } from "./infrastructure/d1/console-auth-repository";
import { D1CustomerRepository } from "./infrastructure/d1/customer-repository";
import { D1IntakeRepository } from "./infrastructure/d1/intake-repository";
import { D1JobRepository } from "./infrastructure/d1/job-repository";
import { D1OutboxRepository } from "./infrastructure/d1/outbox-repository";
import { D1TenancyRepository } from "./infrastructure/d1/tenancy-repository";
import { HmacKeyedHasher } from "./infrastructure/keyed-hasher";
import { LoggingPendientes } from "./infrastructure/logging-pendientes";
import { demoOrders } from "./infrastructure/memory/demo-orders";
import { MemoryEngine } from "./infrastructure/memory/memory-engine";
import { QueueDoorbell } from "./infrastructure/queue-doorbell";
import { R2MediaStore } from "./infrastructure/r2-media-store";
import { consoleLogger, randomIds, realSleep, systemClock } from "./infrastructure/runtime";
import { WhatsAppCloudChannel } from "./integrations/whatsapp/client";
import { unavailableMediaSource } from "./integrations/whatsapp/media";
import { SEND_TIMEOUT_MS } from "./domain/outbox";

export interface Runtime {
  readonly config: Config;
  readonly deps: Deps;
  /** Null until the real engine is wired in, except for the dev console's pretend engine. */
  readonly engine: Engine | null;
}

/** One pretend engine per Worker isolate, so the dev console's taps last between requests. */
const devEngine = new MemoryEngine(() => demoOrders(Date.now()));

export type RuntimeOverrides = Partial<
  Pick<
    Deps,
    "clock" | "ids" | "log" | "sleep" | "hasher" | "doorbell" | "channel" | "mediaSource" | "mediaStore" | "jobHandler"
  >
> & { readonly db?: D1Database; readonly engine?: Engine; readonly pendientes?: Pendientes };

export function buildRuntime(env: Env, overrides: RuntimeOverrides = {}): Runtime {
  const config = readConfig(env);
  const db = overrides.db ?? env.DB;
  const engine = overrides.engine ?? (config.devConsole ? devEngine : null);
  const clock = overrides.clock ?? systemClock;
  const log = overrides.log ?? consoleLogger;
  const jobs = new D1JobRepository(db);
  const customers = new D1CustomerRepository(db);
  // Customers' messages go to the order handler once an engine is wired in (#13 plugs the real one in here).
  const orderHandler = engine === null ? null : createOrderHandler({ engine, jobs, customers, clock, log });
  return {
    config,
    engine,
    deps: {
      clock: overrides.clock ?? systemClock,
      ids: overrides.ids ?? randomIds,
      log: overrides.log ?? consoleLogger,
      sleep: overrides.sleep ?? realSleep,
      hasher: overrides.hasher ?? new HmacKeyedHasher(config.senderHashSalt),
      tenancy: new D1TenancyRepository(db),
      intake: new D1IntakeRepository(db),
      jobs,
      outbox: new D1OutboxRepository(db),
      consoleAuth: new D1ConsoleAuthRepository(db),
      customers,
      doorbell: overrides.doorbell ?? new QueueDoorbell(env.JOBS),
      channel:
        overrides.channel ??
        new WhatsAppCloudChannel({
          token: config.whatsappToken,
          apiVersion: config.graphApiVersion,
          timeoutMs: SEND_TIMEOUT_MS,
          fetch: (input, init) => fetch(input, init),
        }),
      mediaSource: overrides.mediaSource ?? unavailableMediaSource,
      mediaStore: overrides.mediaStore ?? new R2MediaStore(env.MEDIA),
      jobHandler: overrides.jobHandler ?? orderHandler ?? placeholderHandler,
      // The second claim check reads the records through the engine; none wired, no claim holds.
      claimVerifier: engine,
      pendientes: overrides.pendientes ?? new LoggingPendientes(overrides.log ?? consoleLogger),
    },
  };
}
