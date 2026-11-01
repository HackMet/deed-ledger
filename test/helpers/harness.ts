import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Engine } from "../../src/application/engine";
import type { BurstMediaResolver } from "../../src/application/order-reading";
import type { BurstReader } from "../../src/application/perception/reader";
import type {
  AudioDecoder,
  Deps,
  JobHandler,
  MediaSource,
  ModelProvider,
  Pendientes,
  PendientesBoard,
  Transcriber,
} from "../../src/application/ports";
import { buildRuntime } from "../../src/composition";
import { createWorker } from "../../src/index";
import type { DoorbellMessage } from "../../src/infrastructure/queue-doorbell";
import { FakeChannel, FakeClock, FakeDoorbell, FakeMediaSource, RecordingLogger, type Ring } from "./fakes";
import { signBody } from "./whatsapp";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/** Obviously fake secrets, passed explicitly. The WhatsApp send token stays blank. */
export const TEST_APP_SECRET = "test-app-secret-not-real";
export const TEST_VERIFY_TOKEN = "test-verify-token-not-real";
export const TEST_SALT = "test-salt-not-real";
export const TEST_LINK_SECRET = "test-link-secret-not-real";

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    MEDIA: env.MEDIA,
    JOBS: env.JOBS,
    WHATSAPP_GRAPH_API_VERSION: env.WHATSAPP_GRAPH_API_VERSION,
    WHATSAPP_APP_SECRET: TEST_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: TEST_VERIFY_TOKEN,
    WHATSAPP_TOKEN: "",
    SENDER_HASH_SALT: TEST_SALT,
    LINK_SIGNING_SECRET: TEST_LINK_SECRET,
    ...overrides,
  } as Env;
}

export interface HarnessOptions {
  readonly clock?: FakeClock;
  readonly jobHandler?: JobHandler;
  readonly mediaSource?: MediaSource;
  readonly db?: D1Database;
  readonly env?: Env;
  readonly engine?: Engine;
  /** Recorded readings instead of Muse Spark: with an engine, wires the real reader. */
  readonly modelProvider?: ModelProvider;
  readonly burstMedia?: BurstMediaResolver;
  readonly burstReader?: BurstReader;
  readonly pendientes?: Pendientes;
  readonly pendientesBoard?: PendientesBoard;
  /** A fake transcriber; the default has a blank key and never reaches the network. */
  readonly transcriber?: Transcriber;
  readonly audioDecoder?: AudioDecoder;
}

/** The real Worker (routes, D1 repositories, R2) with fake providers and a controllable clock. */
export function harness(options: HarnessOptions = {}) {
  const clock = options.clock ?? new FakeClock();
  const doorbell = new FakeDoorbell();
  const channel = new FakeChannel();
  const log = new RecordingLogger();
  const mediaSource = options.mediaSource ?? new FakeMediaSource();
  const sleeps: number[] = [];
  const workerEnv = options.env ?? testEnv();
  const makeRuntime = (e: Env) =>
    buildRuntime(e, {
      clock,
      doorbell,
      channel,
      log,
      mediaSource,
      // Inline retries don't really wait in tests; the waits are recorded instead.
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      ...(options.jobHandler === undefined ? {} : { jobHandler: options.jobHandler }),
      ...(options.db === undefined ? {} : { db: options.db }),
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(options.modelProvider === undefined ? {} : { modelProvider: options.modelProvider }),
      ...(options.burstMedia === undefined ? {} : { burstMedia: options.burstMedia }),
      ...(options.burstReader === undefined ? {} : { burstReader: options.burstReader }),
      ...(options.pendientes === undefined ? {} : { pendientes: options.pendientes }),
      ...(options.pendientesBoard === undefined ? {} : { pendientesBoard: options.pendientesBoard }),
      ...(options.transcriber === undefined ? {} : { transcriber: options.transcriber }),
      ...(options.audioDecoder === undefined ? {} : { audioDecoder: options.audioDecoder }),
    });
  const worker = createWorker(makeRuntime);
  const deps: Deps = makeRuntime(workerEnv).deps;

  const request = async (body: unknown, signature?: string | null) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const header = signature === undefined ? await signBody(TEST_APP_SECRET, raw) : signature;
    if (header !== null) headers["x-hub-signature-256"] = header;
    return new IncomingRequest("https://worker.test/webhooks/whatsapp", { method: "POST", headers, body: raw });
  };

  return {
    clock,
    doorbell,
    channel,
    log,
    mediaSource,
    sleeps,
    deps,
    worker,
    env: workerEnv,

    /** POSTs a webhook body signed with the test app secret (or the given signature header). */
    async post(body: unknown, signature?: string | null): Promise<Response> {
      const ctx = createExecutionContext();
      const response = await worker.fetch(await request(body, signature), workerEnv, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    },

    /** Starts a POST without waiting for it: the response and the after-response work, separately. */
    async start(body: unknown): Promise<{ response: Promise<Response>; ctx: ExecutionContext }> {
      const ctx = createExecutionContext();
      const response = Promise.resolve(worker.fetch(await request(body), workerEnv, ctx));
      return { response, ctx };
    },

    async get(path: string): Promise<Response> {
      const ctx = createExecutionContext();
      const response = await worker.fetch(new Request(`https://worker.test${path}`), workerEnv, ctx);
      await waitOnExecutionContext(ctx);
      return response;
    },

    /** Hands rung doorbells to the queue handler, as Cloudflare Queues would. */
    async deliver(rings: readonly Ring[] = doorbell.take()) {
      if (rings.length === 0) return null;
      const batch = createMessageBatch<DoorbellMessage>(
        "store-assistant-jobs",
        rings.map((ring, n) => ({
          id: `doorbell-${n}-${crypto.randomUUID()}`,
          timestamp: new Date(clock.now()),
          attempts: 1,
          body: { v: 1, businessId: ring.conversation.businessId, conversationId: ring.conversation.conversationId },
        })),
      );
      const ctx = createExecutionContext();
      await worker.queue(batch, workerEnv, ctx);
      return getQueueResult(batch, ctx);
    },

    /** Messages sent to one phone. Storage is shared within a test file, so assert per recipient. */
    sentTo(phone: string): string[] {
      return channel.sent.filter((sent) => sent.toPhone === phone).map((sent) => sent.body);
    },

    /** Rings for one store, for the same reason. */
    ringsFor(businessId: string): Ring[] {
      return doorbell.rings.filter((ring) => ring.conversation.businessId === businessId);
    },

    /** Takes (removes) the rings for one store. */
    takeRingsFor(businessId: string): Ring[] {
      const mine = doorbell.rings.filter((ring) => ring.conversation.businessId === businessId);
      doorbell.rings = doorbell.rings.filter((ring) => ring.conversation.businessId !== businessId);
      return mine;
    },

    /** The cron sweep. It spans every store, so assert per store. */
    async runCron(): Promise<void> {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ cron: "* * * * *", scheduledTime: clock.now() }), workerEnv, ctx);
      await waitOnExecutionContext(ctx);
    },
  };
}

export type Harness = ReturnType<typeof harness>;

/** Rows for assertions. */
export async function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql).bind(...params).all<T>();
  return results;
}

/** The store's only conversation, as a reference. */
export async function conversationOf(businessId: string): Promise<{ businessId: string; conversationId: string }> {
  const [row] = await rows<{ id: string }>(`SELECT id FROM conversations WHERE business_id = ?`, businessId);
  if (row === undefined) throw new Error("no conversation");
  return { businessId, conversationId: row.id };
}

/** Lease times use the database's clock, so tests expire a lease in the database itself. */
export async function expireLease(conversationId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE conversations SET lease_until_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) - 1
     WHERE id = ? AND lease_id IS NOT NULL`,
  )
    .bind(conversationId)
    .run();
}

/** Outbox claims use the database's clock too: this ends every claim held in a store. */
export async function expireClaims(businessId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE outbound_messages SET claim_until_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) - 1
     WHERE business_id = ? AND claim_id IS NOT NULL`,
  )
    .bind(businessId)
    .run();
}

/** A reply lifetime longer than any test, for tests about windows and retries rather than expiry. */
export const OUTLIVES_TEST_MS = 30 * 24 * 60 * 60 * 1000;
