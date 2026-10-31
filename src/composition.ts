/**
 * Composition root: the one place that turns env bindings into the application's dependencies.
 * Tests pass overrides for providers (channel, doorbell, media source, clock) and keep the real
 * D1 repositories.
 */
import type { Engine } from "./application/engine";
import { fixturePerceptionHandler } from "./application/engine/fixture-perception-handler";
import { OrderEngine } from "./application/engine/order-engine";
import type { Deps } from "./application/ports";
import { type Config, readConfig } from "./infrastructure/config";
import { D1ConsoleAuthRepository } from "./infrastructure/d1/console-auth-repository";
import { D1IntakeRepository } from "./infrastructure/d1/intake-repository";
import { D1OrderStore } from "./infrastructure/d1/order-store";
import { D1JobRepository } from "./infrastructure/d1/job-repository";
import { D1OutboxRepository } from "./infrastructure/d1/outbox-repository";
import { D1TenancyRepository } from "./infrastructure/d1/tenancy-repository";
import { HmacKeyedHasher } from "./infrastructure/keyed-hasher";
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
> & { readonly db?: D1Database; readonly engine?: Engine };

export function buildRuntime(env: Env, overrides: RuntimeOverrides = {}): Runtime {
  const config = readConfig(env);
  const db = overrides.db ?? env.DB;
  const ids = overrides.ids ?? randomIds;
  const clock = overrides.clock ?? systemClock;
  const orders = new D1OrderStore(db);
  return {
    config,
    engine: overrides.engine ?? (config.devConsole ? devEngine : null),
    deps: {
      clock,
      ids,
      log: overrides.log ?? consoleLogger,
      sleep: overrides.sleep ?? realSleep,
      hasher: overrides.hasher ?? new HmacKeyedHasher(config.senderHashSalt),
      tenancy: new D1TenancyRepository(db),
      intake: new D1IntakeRepository(db),
      jobs: new D1JobRepository(db),
      outbox: new D1OutboxRepository(db),
      consoleAuth: new D1ConsoleAuthRepository(db),
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
      // Fixture perception stands in until the teammate's perception lands (D-37); see its header.
      jobHandler: overrides.jobHandler ?? fixturePerceptionHandler({ engine: new OrderEngine({ store: orders, ids }), orders, clock }),
    },
  };
}
