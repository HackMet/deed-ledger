/**
 * Composition root: the one place that turns env bindings into the application's dependencies.
 * Tests pass overrides for providers (channel, doorbell, media source, clock) and keep the real
 * D1 repositories.
 */
import { gatedHandler } from "./application/customer-gate";
import type { Engine } from "./application/engine";
import { OrderEngine } from "./application/engine/order-engine";
import { BusinessService } from "./application/business";
import { readerConfiguration } from "./application/perception/agent";
import { CatalogService } from "./application/catalog";
import type { ModelCallSettings } from "./application/model-settings";
import { type BurstReader as OrderBurstReader, createOrderHandler } from "./application/order-handler";
import { type BurstMediaResolver, createOrderReading, readingSourceOf, storedMediaResolver } from "./application/order-reading";
import { BurstReader } from "./application/perception/reader";
import { PlannerModel } from "./application/planner/plan-turn";
import { plannerSourceOf } from "./application/planner/source";
import { placeholderHandler } from "./application/placeholder-handler";
import type { ReceiptReader } from "./application/receipt-reader";
import { ReceiptService } from "./application/receipts";
import type {
  AudioDecoder,
  BusinessContext,
  Clock,
  Deps,
  Logger,
  MediaEraser,
  MediaStore,
  ModelProvider,
  Pendientes,
  PendientesBoard,
  Transcriber,
} from "./application/ports";
import { agentIdOf } from "./domain/agent-id";
import { PRIVACY_PATH } from "./domain/customer-controls";
import { SEND_TIMEOUT_MS } from "./domain/outbox";
import { type Config, readConfig } from "./infrastructure/config";
import { D1BusinessContext } from "./infrastructure/d1/business-context";
import { D1CatalogStore } from "./infrastructure/d1/catalog-store";
import { D1CommitRunner } from "./infrastructure/d1/commit-runner";
import { D1ConsoleAuthRepository } from "./infrastructure/d1/console-auth-repository";
import { D1ConsoleReceipts } from "./infrastructure/d1/console-receipts";
import { D1CustomerControlRepository } from "./infrastructure/d1/customer-control-repository";
import { D1CustomerPlaceRepository } from "./infrastructure/d1/customer-place-repository";
import { D1CustomerRepository } from "./infrastructure/d1/customer-repository";
import type { DeedChecks } from "./application/engine/deed-checks";
import { D1DeedChecks } from "./infrastructure/d1/deed-checks";
import { D1StockBalances } from "./infrastructure/d1/stock-balances";
import { D1FactLedger, D1FactPrecheck } from "./infrastructure/d1/fact-ledger";
import { D1IntakeRepository } from "./infrastructure/d1/intake-repository";
import { D1JobRepository } from "./infrastructure/d1/job-repository";
import { D1OrderStore } from "./infrastructure/d1/order-store";
import { PlannedDeedEngine, SetupCatalogOrderStore } from "./infrastructure/d1/planned-deed-engine";
import { D1ButtonsShown, D1OutboxRepository } from "./infrastructure/d1/outbox-repository";
import { D1Pendientes } from "./infrastructure/d1/pendientes-repository";
import { D1RetrievalRepository } from "./infrastructure/d1/retrieval-repository";
import { D1SpendLedger } from "./infrastructure/d1/spend-repository";
import { D1DemoStoreRepository } from "./infrastructure/d1/demo-store-repository";
import { DemoGuardedChannel, DemoGuardedMediaSource, DemoPooledSpendLedger, type DemoPresetFiles } from "./infrastructure/demo-guards";
import { LISTA_JPEG_BASE64, VOZ_OGG_BASE64 } from "./infrastructure/demo-preset-files";
import { DEMO_SPEND_POOL_ID, newDemoPhone } from "./domain/demo";
import { D1StoreSetupRepository } from "./infrastructure/d1/store-setup-repository";
import { D1TenancyRepository } from "./infrastructure/d1/tenancy-repository";
import { HmacKeyedHasher } from "./infrastructure/keyed-hasher";
import { DEMO_CATALOG } from "./infrastructure/memory/demo-catalog";
import { demoOrders } from "./infrastructure/memory/demo-orders";
import { D1PretendEngine } from "./infrastructure/memory/d1-pretend-engine";
import { MemoryEngine } from "./infrastructure/memory/memory-engine";
import { QueueDoorbell } from "./infrastructure/queue-doorbell";
import { R2MediaEraser } from "./infrastructure/r2-media-eraser";
import { R2MediaStore } from "./infrastructure/r2-media-store";
import { SimMediaSource } from "./infrastructure/sim-media-source";
import { consoleLogger, randomIds, realSleep, systemClock } from "./infrastructure/runtime";
import { OpusAudioDecoder } from "./integrations/audio";
import { MuseSparkProvider, SPARK_MODEL } from "./integrations/meta/spark";
import { MuseVoiceTranscriber } from "./integrations/meta/transcribe";
import { RecordedReceiptReader } from "./integrations/perception/recorded-receipt-reader";
import { WhatsAppCloudChannel } from "./integrations/whatsapp/client";
import { WhatsAppMediaSource } from "./integrations/whatsapp/media";
import { receiptRecordings } from "../test/fixtures/receipts";
import { DEMO_INVOICE_PENDING_JPEG_BASE64, DEMO_INVOICE_RECEIVED_JPEG_BASE64, DEMO_INVOICE_RECORDINGS } from "./infrastructure/demo-invoices";
import type { MemberContext } from "./application/engine";
import {
  type DemoHistoryQueue,
  type DemoHistoryRunner,
  type DemoHistoryMessage,
  DEMO_HISTORY_ITEMS,
  DEMO_HISTORY_WAIT_MS,
  demoHistoryMessage,
  historyComplete,
  ScriptedOrderReader,
  SeedClock,
  seedDemoHistoryItem,
} from "./application/demo-history";
import { readSeedProgress } from "./infrastructure/d1/demo-history-progress";

export interface Runtime {
  /** The Deed's record of checks (K20): the engine that writes it is wired where it runs (demo/worker.ts). */
  readonly deedChecks: DeedChecks;
  readonly config: Config;
  /** The simulator's media uploads (dev console with no WhatsApp token only); null everywhere else. */
  readonly simMedia: SimMediaSource | null;
  readonly deps: Deps;
  /** Products and prices (K6). */
  readonly catalog: CatalogService;
  /** What the store says about itself (K6, K15): saved by the owner, read by `business.context.current`. */
  readonly business: { readonly service: BusinessService; readonly context: BusinessContext };
  /** Supplier invoices on the console (K14). */
  readonly receipts: ReceiptService;
  /** Null until the real engine is wired in, except for the pretend engines (DEV_CONSOLE, PRETEND_ENGINE). */
  readonly engine: Engine | null;
  /** The burst reader the console's Anotar screen uses (#26). */
  readonly burstReader: BurstReader;
  /** The store's own products, hours and delivery fee (#40), edited on the console's Tienda screens. */
  readonly storeSetup: D1StoreSetupRepository;
  /** Each store's products for retrieval and its learned aliases (D-49), approved in Pendientes. */
  readonly retrieval: D1RetrievalRepository;
  /** The public demo's stores (migration 0032). */
  readonly demoStores: D1DemoStoreRepository;
  /** Model spend, every demo store pooled under the demo's daily cap: the demo charges voice notes to it. */
  readonly demoSpend: DemoPooledSpendLedger;
  /** What the demo's pool has spent today, in micro-USD. */
  readonly demoPoolSpent: (nowMs: number) => Promise<number>;
  /**
   * A new demo store's past few days (demo-history.ts): `schedule` queues its pieces, `run` seeds one
   * from the queue. Null without the real order engine.
   */
  readonly demoHistory: DemoHistoryRunner | null;
}

/** One pretend engine per Worker isolate, so the dev console's taps last between requests. */
const devEngine = new MemoryEngine(() => demoOrders(Date.now()), { catalog: DEMO_CATALOG });

export type RuntimeOverrides = Partial<
  Pick<
    Deps,
    "clock" | "ids" | "log" | "sleep" | "hasher" | "doorbell" | "channel" | "mediaSource" | "mediaStore" | "jobHandler"
  >
> & {
  readonly db?: D1Database;
  readonly engine?: Engine;
  readonly pendientes?: Pendientes;
  /** What the owner's console reads Pendientes from; by default the same D1 table they're raised into. */
  readonly pendientesBoard?: PendientesBoard;
  /** Stands in for Muse Spark (tests answer with recorded readings). */
  readonly modelProvider?: ModelProvider;
  /** Photos and voice notes for the reader; by default read back from R2 and transcribed. */
  readonly burstMedia?: BurstMediaResolver;
  // Tests pass a reader whose provider answers with recorded responses.
  readonly burstReader?: BurstReader;
  readonly mediaEraser?: MediaEraser;
  readonly receiptReader?: ReceiptReader;
  /** The order handler's reader instead of perception: the demo's history seed scripts its readings. */
  readonly orderReader?: OrderBurstReader;
  /** Where the demo's history pieces are queued; by default the jobs queue. */
  readonly demoHistoryQueue?: DemoHistoryQueue;
} & Partial<Pick<Deps, "audioDecoder" | "transcriber">>;

/** C11: the id of this deployment's agent configuration, hashed once when the Worker starts and stamped on customer facts. */
const AGENT_ID = agentIdOf(readerConfiguration(SPARK_MODEL));

export function buildRuntime(env: Env, overrides: RuntimeOverrides = {}): Runtime {
  const config = readConfig(env);
  const db = overrides.db ?? env.DB;
  const storeSetup = new D1StoreSetupRepository(db);
  // The simulator downloads the synthetic photos and voice notes it was sent (`npm run chat`): only with
  // the dev console on and no WhatsApp token, so a deployed Worker never serves uploads.
  const simMedia = config.devConsole && config.whatsappToken === "" ? new SimMediaSource(env.MEDIA) : null;
  const ids = overrides.ids ?? randomIds;
  const clock = overrides.clock ?? systemClock;
  const log = overrides.log ?? consoleLogger;
  // The Deed's record of checks (K20): the order engine writes every claim check and refusal to it.
  const deedChecks = new D1DeedChecks(db);
  // DEED_ENGINE: the real order engine on D1 (OrderEngine), which Angel's reader reads through. DEV_CONSOLE:
  // in memory, demo catalog, no login, local simulator only. PRETEND_ENGINE: state in D1, shared by every
  // isolate, each store's own products and hours (#40), console behind login. Both (the simulator's
  // --store): the D1 engine, so the Tienda screens feed the chat. Neither: no engine until the real one is wired in.
  const engine =
    overrides.engine ??
    (config.deedEngine
      ? config.conversation === "planner"
        ? plannedDeedEngine(db, storeSetup, { ids, checks: deedChecks, clock, log })
        : new OrderEngine({ store: new D1OrderStore(db), ids, ledger: new D1FactLedger(db), checks: deedChecks, stock: new D1StockBalances(db), clock, log, agentId: AGENT_ID })
      : config.pretendEngine
        ? new D1PretendEngine(db, { setup: storeSetup })
        : config.devConsole
          ? devEngine
          : null);
  const jobs = new D1JobRepository(db);
  const customers = new D1CustomerRepository(db);
  const customerControls = new D1CustomerControlRepository(db);
  // Kept in D1 for the owner's Pendientes screen, and logged (IDs only).
  const storedPendientes = new D1Pendientes(db, ids, clock, log);
  const pendientes = overrides.pendientes ?? storedPendientes;
  const pendientesBoard = overrides.pendientesBoard ?? storedPendientes;
  // ALTO, SEGUIR, handoff, deletion and the first message, ahead of the order handler (#30).
  const gate = {
    controls: customerControls,
    jobs,
    pendientes,
    clock,
    log,
    privacyUrl: config.publicBaseUrl === "" ? null : `${config.publicBaseUrl}${PRIVACY_PATH}`,
  };
  const mediaStore = overrides.mediaStore ?? new R2MediaStore(env.MEDIA);
  const audioDecoder = overrides.audioDecoder ?? new OpusAudioDecoder();
  const transcriber = overrides.transcriber ?? museTranscriber(config);
  const retrieval = new D1RetrievalRepository(db);
  // Customers' messages go to the order handler once an engine is wired in (#13 plugs the real one in here).
  const reader =
    engine === null
      ? null
      : overrides.orderReader ?? buildOrderReading(env, engine, { clock, log }, { db, jobs, mediaStore, audioDecoder, transcriber, retrieval, ...readingOverrides(overrides) });
  const orderHandler = engine === null ? null : createOrderHandler({
          engine,
          jobs,
          customers,
          clock,
          log,
          pendientes,
          reader,
          gate,
          places: new D1CustomerPlaceRepository(db),
          buttonsShown: new D1ButtonsShown(db),
          // Planner path: a confirmed order's planner picks propose learned aliases (D-49).
          aliases: config.conversation === "planner" ? retrieval : null,
          testCommands: {
            enabled: config.testCommands,
            engine,
            controls: customerControls,
            customers,
            jobs,
            mediaEraser: overrides.mediaEraser ?? new R2MediaEraser(env.MEDIA),
            clock,
            log,
          },
        });
  const ledger = new D1FactLedger(db);
  const runner = new D1CommitRunner(db);
  const businessInfo = new D1BusinessContext(db);
  // Recorded readings of synthetic invoices until the Muse Spark adapter lands (PR #63, decision Q2):
  // every other photo is refused as unreadable, never guessed.
  // The demo history's two invoices are recorded the same way (demo-invoices.ts).
  const receiptReader = overrides.receiptReader ?? new RecordedReceiptReader([...receiptRecordings, ...DEMO_INVOICE_RECORDINGS]);
  return {
    config,
    simMedia,
    engine,
    deedChecks,
    // One product list whichever engine runs the chat: a price is always the order engine's price fact (K6).
    catalog: new CatalogService({ catalog: new D1CatalogStore(db), ledger, runner, ids, engine: new OrderEngine({ store: new D1OrderStore(db), ids, ledger, checks: deedChecks, clock, log }) }),
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
    storeSetup,
    retrieval,
    demoStores: new D1DemoStoreRepository(db),
    demoSpend: spendLedger(db),
    demoPoolSpent: (nowMs) => new D1SpendLedger(db).spentMicroUsd({ businessId: DEMO_SPEND_POOL_ID }, nowMs),
    demoHistory: config.deedEngine ? demoHistoryRunner(env, overrides, db) : null,
    burstReader:
      overrides.burstReader ??
      buildBurstReader(env, { clock, log }, { db, ...(overrides.modelProvider === undefined ? {} : { provider: overrides.modelProvider }) }),
    deps: {
      clock: overrides.clock ?? systemClock,
      ids,
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
      // A demo store's replies never leave: the demo's phone reads them from the outbox.
      channel: new DemoGuardedChannel(
        overrides.channel ??
          new WhatsAppCloudChannel({
            token: config.whatsappToken,
            apiVersion: config.graphApiVersion,
            timeoutMs: SEND_TIMEOUT_MS,
            fetch: (input, init) => fetch(input, init),
          }),
      ),
      // A demo store's photos and voice notes are the demo's own synthetic files, never Meta's.
      mediaSource: new DemoGuardedMediaSource(
        overrides.mediaSource ??
          simMedia ??
          new WhatsAppMediaSource({
            token: config.whatsappToken,
            apiVersion: config.graphApiVersion,
            fetch: (input, init) => fetch(input, init),
          }),
        demoPresetFiles(),
      ),
      mediaStore,
      // Without an engine the placeholder answers, behind the same gate: ALTO, deletion and handoff
      // work, and the first reply carries the introduction (#30).
      jobHandler: overrides.jobHandler ?? orderHandler ?? gatedHandler(gate, placeholderHandler),
      // The second claim check reads the records through the engine; none wired, no claim holds.
      claimVerifier: engine,
      pendientes,
      pendientesBoard,
      audioDecoder,
      transcriber,
      customerControls,
      mediaEraser: overrides.mediaEraser ?? new R2MediaEraser(env.MEDIA),
    },
  };
}

/**
 * DEED_ENGINE=1 with CONVERSATION=planner: the planner's conversation over the real order engine, which
 * stays the only writer of orders. The order engine's store resolves the store's Tienda products too,
 * since the planner path matches against them (`SetupCatalogOrderStore`).
 */
function plannedDeedEngine(
  db: D1Database,
  setup: D1StoreSetupRepository,
  deps: { readonly ids: Deps["ids"]; readonly checks: DeedChecks; readonly clock: Clock; readonly log: Logger },
): PlannedDeedEngine {
  const store = new SetupCatalogOrderStore(new D1OrderStore(db), setup);
  // The store's stock, as the classic Deed branch reads it (D-57): each readback and availability claim.
  const ledger = new OrderEngine({
    store,
    ids: deps.ids,
    ledger: new D1FactLedger(db),
    checks: deps.checks,
    stock: new D1StockBalances(db),
    clock: deps.clock,
    log: deps.log,
    agentId: AGENT_ID,
  });
  return new PlannedDeedEngine({ db, ledger, store, setup });
}

/**
 * The burst reader: Muse Spark behind the per-store daily spend cap in D1. With MODEL_API_KEY blank
 * (tests, a fresh checkout) every call is refused before the network. Tests pass `fetch` with
 * recorded responses.
 */
export function buildBurstReader(
  env: Env,
  deps: { readonly clock: Clock; readonly log: Logger },
  overrides: {
    readonly db?: D1Database;
    readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
    readonly dailyCapMicroUsd?: number;
    readonly provider?: ModelProvider;
    /** Reasoning effort and cache retention; absent (the console's reader), Meta's defaults. */
    readonly settings?: ModelCallSettings;
  } = {},
): BurstReader {
  return new BurstReader({
    provider:
      overrides.provider ??
      new MuseSparkProvider({
        apiKey: env.MODEL_API_KEY ?? "",
        fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
      }),
    spend: spendLedger(overrides.db ?? env.DB),
    clock: deps.clock,
    log: deps.log,
    ...dailyCap(overrides.dailyCapMicroUsd ?? readConfig(env).modelDailyCapMicroUsd),
    ...(overrides.settings === undefined ? {} : { settings: overrides.settings }),
  });
}

/** MODEL_DAILY_CAP_USD for every metered call (reader, planner, one call); nothing: the default. */
function dailyCap(microUsd: number | null | undefined): { dailyCapMicroUsd?: number } {
  return microUsd == null ? {} : { dailyCapMicroUsd: microUsd };
}

/**
 * The order handler's reader: Muse Spark when MODEL_API_KEY is set (or a provider is passed) and the
 * engine offers perception's reads (gaps a and b). Otherwise null, and bursts get the placeholder.
 * With CONVERSATION=planner and an engine that offers the planner's read, the planner decides each
 * turn after the reader, on the same provider and the same spend cap (D-45).
 */
export function buildOrderReading(
  env: Env,
  engine: Engine,
  deps: { readonly clock: Clock; readonly log: Logger },
  overrides: {
    readonly db?: D1Database;
    readonly provider?: ModelProvider;
    readonly media?: BurstMediaResolver;
    readonly jobs?: D1JobRepository;
    readonly mediaStore?: MediaStore;
    readonly audioDecoder?: AudioDecoder;
    readonly transcriber?: Transcriber;
    readonly retrieval?: D1RetrievalRepository;
  } = {},
): OrderBurstReader | null {
  const source = readingSourceOf(engine);
  if (source === null) return null;
  if (overrides.provider === undefined && (env.MODEL_API_KEY ?? "") === "") return null;
  const jobs = overrides.jobs ?? new D1JobRepository(overrides.db ?? env.DB);
  const media =
    overrides.media ??
    storedMediaResolver({
      jobs,
      mediaStore: overrides.mediaStore ?? new R2MediaStore(env.MEDIA),
      audioDecoder: overrides.audioDecoder ?? new OpusAudioDecoder(),
      transcriber: overrides.transcriber ?? museTranscriber(readConfig(env)),
      log: deps.log,
    });
  const provider =
    overrides.provider ?? new MuseSparkProvider({ apiKey: env.MODEL_API_KEY ?? "", fetch: (input, init) => fetch(input, init) });
  const config = readConfig(env);
  const plannerSource = config.conversation === "planner" ? plannerSourceOf(engine) : null;
  return createOrderReading({
    reader: buildBurstReader(env, deps, { ...(overrides.db === undefined ? {} : { db: overrides.db }), provider, settings: config.readerModel }),
    source,
    media,
    leases: jobs,
    log: deps.log,
    planner:
      plannerSource === null
        ? null
        : {
            model: new PlannerModel({
              provider,
              spend: spendLedger(overrides.db ?? env.DB),
              clock: deps.clock,
              log: deps.log,
              settings: config.plannerModel,
              ...dailyCap(config.modelDailyCapMicroUsd),
            }),
            retrieval: overrides.retrieval ?? new D1RetrievalRepository(overrides.db ?? env.DB),
            source: plannerSource,
            log: deps.log,
          },
    oneCall:
      plannerSource === null || !config.fastText
        ? null
        : {
            provider,
            spend: spendLedger(overrides.db ?? env.DB),
            clock: deps.clock,
            log: deps.log,
            settings: config.fastTextModel,
            ...dailyCap(config.modelDailyCapMicroUsd),
          },
  });
}

/** Model spend in D1, with every demo store's spend pooled under the demo's one daily cap. */
function spendLedger(db: D1Database): DemoPooledSpendLedger {
  return new DemoPooledSpendLedger(new D1SpendLedger(db));
}

let presetFiles: DemoPresetFiles | null = null;
/** The demo phone's preset photo and voice note, decoded once per isolate. */
function demoPresetFiles(): DemoPresetFiles {
  presetFiles ??= { lista: fromBase64(LISTA_JPEG_BASE64), voz: fromBase64(VOZ_OGG_BASE64) };
  return presetFiles;
}

function fromBase64(encoded: string): ArrayBuffer {
  return Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)).buffer;
}

function museTranscriber(config: Config): Transcriber {
  return new MuseVoiceTranscriber({ apiKey: config.modelApiKey, fetch: (input, init) => fetch(input, init) });
}

function readingOverrides(overrides: RuntimeOverrides): { provider?: ModelProvider; media?: BurstMediaResolver } {
  return {
    ...(overrides.modelProvider === undefined ? {} : { provider: overrides.modelProvider }),
    ...(overrides.burstMedia === undefined ? {} : { media: overrides.burstMedia }),
  };
}

/** No queue: the history seed runs each conversation itself, at once. */
const silentDoorbell = { ring: async () => {} };

/** How long a piece waits when its batch already ran one. */
const DEMO_HISTORY_LATER_S = 2;
/** The supplier invoices a seeded store gets: one received, one to review. */
const DEMO_HISTORY_INVOICES = 2;

function demoHistoryRunner(env: Env, overrides: RuntimeOverrides, db: D1Database): DemoHistoryRunner {
  const queue: DemoHistoryQueue = overrides.demoHistoryQueue ?? {
    sendBatch: async (messages) => {
      await (env.DEMO_SEED as unknown as Queue<DemoHistoryMessage>).sendBatch(messages.map((m) => ({ ...m, contentType: "json" as const })));
    },
  };
  const stores = new D1DemoStoreRepository(db);
  const now = () => (overrides.clock ?? systemClock).now();
  return {
    // Every piece at once, newest orders first: the queue hands them out one per invocation, several
    // at a time, so the store fills in about as long as its slowest piece takes.
    schedule: (businessId) =>
      queue.sendBatch(Array.from({ length: DEMO_HISTORY_ITEMS }, (_, item) => ({ body: demoHistoryMessage(businessId, item) }))),
    later: (message) => queue.sendBatch([{ body: message, delaySeconds: DEMO_HISTORY_LATER_S }]),
    run: (message) => runPiece(message),
    async loading(businessId) {
      const target = await stores.seedTarget(businessId, now());
      if (target === null || now() - target.openedAtMs > DEMO_HISTORY_WAIT_MS) return false;
      const progress = await readSeedProgress(db, businessId);
      return progress !== null && !historyComplete(progress, DEMO_HISTORY_INVOICES);
    },
  };

  /** Nothing for a message that names no live demo store. A piece that fails is logged inside. */
  async function runPiece(message: DemoHistoryMessage): Promise<void> {
    const target = await stores.seedTarget(message.businessId, now());
    if (target === null) return;
    const clock = new SeedClock(target.openedAtMs);
    const reader = new ScriptedOrderReader();
    const { jobHandler: _handler, doorbell: _doorbell, ...rest } = overrides;
    const seed = buildRuntime(env, { ...rest, clock, doorbell: silentDoorbell, orderReader: reader });
    if (seed.engine === null) return;
    const owner: MemberContext = { businessId: target.businessId, memberId: target.ownerUserId, role: "owner", canApproveFiado: true, nowMs: target.openedAtMs };
    const done = await seedDemoHistoryItem(
      {
        deps: seed.deps,
        clock,
        reader,
        engine: seed.engine,
        receipts: seed.receipts,
        buttonsShown: new D1ButtonsShown(db),
        catalog: (tenant) => seed.catalog.list(tenant),
        newPhone: () => newDemoPhone((n) => crypto.getRandomValues(new Uint8Array(n))),
        invoices: {
          approved: new Uint8Array(fromBase64(DEMO_INVOICE_RECEIVED_JPEG_BASE64)),
          pending: new Uint8Array(fromBase64(DEMO_INVOICE_PENDING_JPEG_BASE64)),
        },
      },
      { businessId: target.businessId, phoneNumberId: target.phoneNumberId, owner },
      message.item,
    );
    seed.deps.log.info("demo_history_item", { businessId: target.businessId, count: message.item, outcome: done ? "seeded" : "skipped" });
  }
}
