/**
 * Composition root: the one place that turns env bindings into the application's dependencies.
 * Tests pass overrides for providers (channel, doorbell, media source, clock) and keep the real
 * D1 repositories.
 */
import { gatedHandler } from "./application/customer-gate";
import type { Engine } from "./application/engine";
import { type BurstReader as OrderBurstReader, createOrderHandler } from "./application/order-handler";
import { type BurstMediaResolver, createOrderReading, readingSourceOf, storedMediaResolver } from "./application/order-reading";
import { BurstReader } from "./application/perception/reader";
import { placeholderHandler } from "./application/placeholder-handler";
import type {
  AudioDecoder,
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
import { PRIVACY_PATH } from "./domain/customer-controls";
import { SEND_TIMEOUT_MS } from "./domain/outbox";
import { type Config, readConfig } from "./infrastructure/config";
import { D1ConsoleAuthRepository } from "./infrastructure/d1/console-auth-repository";
import { D1CustomerControlRepository } from "./infrastructure/d1/customer-control-repository";
import { D1CustomerPlaceRepository } from "./infrastructure/d1/customer-place-repository";
import { D1CustomerRepository } from "./infrastructure/d1/customer-repository";
import { D1IntakeRepository } from "./infrastructure/d1/intake-repository";
import { D1JobRepository } from "./infrastructure/d1/job-repository";
import { D1ButtonsShown, D1OutboxRepository } from "./infrastructure/d1/outbox-repository";
import { D1Pendientes } from "./infrastructure/d1/pendientes-repository";
import { D1SpendLedger } from "./infrastructure/d1/spend-repository";
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
import { consoleLogger, randomIds, realSleep, systemClock } from "./infrastructure/runtime";
import { OpusAudioDecoder } from "./integrations/audio";
import { MuseSparkProvider } from "./integrations/meta/spark";
import { MuseVoiceTranscriber } from "./integrations/meta/transcribe";
import { WhatsAppCloudChannel } from "./integrations/whatsapp/client";
import { WhatsAppMediaSource } from "./integrations/whatsapp/media";

export interface Runtime {
  readonly config: Config;
  readonly deps: Deps;
  /** Null until the real engine is wired in, except for the pretend engines (DEV_CONSOLE, PRETEND_ENGINE). */
  readonly engine: Engine | null;
  /** The burst reader the console's Anotar screen uses (#26). */
  readonly burstReader: BurstReader;
  /** The store's own products, hours and delivery fee (#40), edited on the console's Tienda screens. */
  readonly storeSetup: D1StoreSetupRepository;
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
} & Partial<Pick<Deps, "audioDecoder" | "transcriber">>;

export function buildRuntime(env: Env, overrides: RuntimeOverrides = {}): Runtime {
  const config = readConfig(env);
  const db = overrides.db ?? env.DB;
  const storeSetup = new D1StoreSetupRepository(db);
  // DEV_CONSOLE: in memory, demo catalog, no login, local simulator only. PRETEND_ENGINE: state in
  // D1, shared by every isolate, each store's own products and hours (#40), console behind login.
  // Both (the simulator's --store): the D1 engine, so the Tienda screens feed the chat. Neither: no
  // engine until the real one is wired in.
  const engine =
    overrides.engine ??
    (config.pretendEngine ? new D1PretendEngine(db, { setup: storeSetup }) : config.devConsole ? devEngine : null);
  const clock = overrides.clock ?? systemClock;
  const log = overrides.log ?? consoleLogger;
  const jobs = new D1JobRepository(db);
  const customers = new D1CustomerRepository(db);
  const customerControls = new D1CustomerControlRepository(db);
  // Kept in D1 for the owner's Pendientes screen, and logged (IDs only).
  const storedPendientes = new D1Pendientes(db, overrides.ids ?? randomIds, clock, log);
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
  // Customers' messages go to the order handler once an engine is wired in (#13 plugs the real one in here).
  const reader =
    engine === null
      ? null
      : buildOrderReading(env, engine, { clock, log }, { db, jobs, mediaStore, audioDecoder, transcriber, ...readingOverrides(overrides) });
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
        });
  return {
    config,
    engine,
    storeSetup,
    burstReader:
      overrides.burstReader ??
      buildBurstReader(env, { clock, log }, { db, ...(overrides.modelProvider === undefined ? {} : { provider: overrides.modelProvider }) }),
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
      mediaSource:
        overrides.mediaSource ??
        new WhatsAppMediaSource({
          token: config.whatsappToken,
          apiVersion: config.graphApiVersion,
          fetch: (input, init) => fetch(input, init),
        }),
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
  } = {},
): BurstReader {
  return new BurstReader({
    provider:
      overrides.provider ??
      new MuseSparkProvider({
        apiKey: env.MODEL_API_KEY ?? "",
        fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
      }),
    spend: new D1SpendLedger(overrides.db ?? env.DB),
    clock: deps.clock,
    log: deps.log,
    ...(overrides.dailyCapMicroUsd === undefined ? {} : { dailyCapMicroUsd: overrides.dailyCapMicroUsd }),
  });
}

/**
 * The order handler's reader: Muse Spark when MODEL_API_KEY is set (or a provider is passed) and the
 * engine offers perception's reads (gaps a and b). Otherwise null, and bursts get the placeholder.
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
  return createOrderReading({
    reader: buildBurstReader(env, deps, {
      ...(overrides.db === undefined ? {} : { db: overrides.db }),
      ...(overrides.provider === undefined ? {} : { provider: overrides.provider }),
    }),
    source,
    media,
    leases: jobs,
    log: deps.log,
  });
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
