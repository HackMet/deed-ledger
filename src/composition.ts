/**
 * Composition root: the one place that turns env bindings into the application's dependencies.
 * Tests pass overrides for providers (channel, doorbell, media source, clock) and keep the real
 * D1 repositories.
 */
import type { Engine } from "./application/engine";
import { fixturePerceptionHandler } from "./application/engine/fixture-perception-handler";
import { OrderEngine } from "./application/engine/order-engine";
import { BusinessService } from "./application/business";
import { CatalogService } from "./application/catalog";
import type { ReceiptReader } from "./application/receipt-reader";
import { ReceiptService } from "./application/receipts";
import type { BusinessContext, Deps } from "./application/ports";
import { type Config, readConfig } from "./infrastructure/config";
import { D1BusinessContext } from "./infrastructure/d1/business-context";
import { D1CatalogStore } from "./infrastructure/d1/catalog-store";
import { D1CommitRunner } from "./infrastructure/d1/commit-runner";
import { D1ConsoleAuthRepository } from "./infrastructure/d1/console-auth-repository";
import { D1ConsoleReceipts } from "./infrastructure/d1/console-receipts";
import { D1IntakeRepository } from "./infrastructure/d1/intake-repository";
import { D1FactLedger, D1FactPrecheck } from "./infrastructure/d1/fact-ledger";
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
import { RecordedReceiptReader } from "./integrations/perception/recorded-receipt-reader";
import { WhatsAppCloudChannel } from "./integrations/whatsapp/client";
import { unavailableMediaSource } from "./integrations/whatsapp/media";
import { SEND_TIMEOUT_MS } from "./domain/outbox";
import { receiptRecordings } from "../test/fixtures/receipts";

export interface Runtime {
  readonly config: Config;
  readonly deps: Deps;
  /** Products and prices (K6). */
  readonly catalog: CatalogService;
  /** What the store says about itself (K6, K15): saved by the owner, read by `business.context.current`. */
  readonly business: { readonly service: BusinessService; readonly context: BusinessContext };
  /** Supplier invoices on the console (K14). */
  readonly receipts: ReceiptService;
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
> & { readonly db?: D1Database; readonly engine?: Engine; readonly receiptReader?: ReceiptReader };

export function buildRuntime(env: Env, overrides: RuntimeOverrides = {}): Runtime {
  const config = readConfig(env);
  const db = overrides.db ?? env.DB;
  const ids = overrides.ids ?? randomIds;
  const clock = overrides.clock ?? systemClock;
  const orders = new D1OrderStore(db);
  const engine = overrides.engine ?? (config.devConsole ? devEngine : null);
  const ledger = new D1FactLedger(db);
  const runner = new D1CommitRunner(db);
  const businessInfo = new D1BusinessContext(db);
  const mediaStore = overrides.mediaStore ?? new R2MediaStore(env.MEDIA);
  // Recorded readings of synthetic invoices until the Muse Spark adapter lands (PR #63, decision Q2):
  // every other photo is refused as unreadable, never guessed.
  const receiptReader = overrides.receiptReader ?? new RecordedReceiptReader(receiptRecordings);
  return {
    config,
    engine,
    catalog: new CatalogService({ catalog: new D1CatalogStore(db), ledger, runner, ids, engine }),
    business: { service: new BusinessService({ store: businessInfo, ledger, runner, ids }), context: businessInfo },
    receipts: new ReceiptService({
      store: new D1ConsoleReceipts(db, env.MEDIA),
      media: mediaStore,
      reader: receiptReader,
      context: businessInfo,
      ledger,
      precheck: new D1FactPrecheck(db),
      runner,
      ids,
    }),
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
      mediaStore,
      // Fixture perception stands in until the teammate's perception lands (D-37); see its header.
      jobHandler: overrides.jobHandler ?? fixturePerceptionHandler({ engine: new OrderEngine({ store: orders, ids, ledger: new D1FactLedger(db) }), orders, clock }),
    },
  };
}
