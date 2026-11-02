/**
 * Reading a customer's burst for the order handler: the jobs become the reader's messages, the
 * engine says what perception may know (the open order's labelled lines and the question it asked
 * last, contract gap a) and which catalog code matches against (gap b), Muse Spark reads, and code
 * matches lines. Nothing here decides or saves anything.
 */
import type { BurstReading, Observation, PerceptionContext } from "../domain/contract/observation";
import { type BurstMessage, isSupportedImage } from "../domain/perception/burst";
import { LEASE_TTL_MS, READING_MAX_MS, TRANSCRIBE_MAX_MS } from "../domain/processing";
import type { CustomerContext, Engine, LineMatch } from "./engine";
import {
  BurstMediaUnreadableError,
  describeError,
  LeaseLostError,
  ReadingFailedError,
  StaleWriteError,
  UnreadableMediaError,
  type UnreadableMedia,
} from "./errors";
import type { BurstRead, BurstReader, BurstReaderInput } from "./order-handler";
import type { CatalogProduct } from "./perception/matching";
import type { BurstReader as ModelBurstReader } from "./perception/reader";
import type { Job, JobRepository, Lease, Logger, Tenant } from "./ports";
import { transcribeVoiceNote, type VoiceNoteDeps } from "./voice-note";

/**
 * What the engine tells perception, through reads the contract doesn't have yet (gaps a and b,
 * proposed). Local until agreed; an engine that has both methods gets the reader in composition.
 */
export interface OrderReadingSource {
  /** The customer's open order as labelled lines ("L1"), and the question asked last. */
  perceptionContext(context: CustomerContext): Promise<PerceptionContext>;
  /** The store's catalog for matching by code: names, known aliases, barcodes. */
  catalog(tenant: Tenant): Promise<readonly CatalogProduct[]>;
}

/** The engine's reads for perception, when it has them. */
export function readingSourceOf(engine: Engine): OrderReadingSource | null {
  const candidate = engine as Partial<OrderReadingSource>;
  return typeof candidate.perceptionContext === "function" && typeof candidate.catalog === "function"
    ? (engine as Engine & OrderReadingSource)
    : null;
}

/**
 * Photos and voice notes as the reader gets them. Throws when one can't be read now; an
 * UnreadableMediaError means it never will be (retrying reads the same bytes).
 */
export interface BurstMediaResolver {
  resolve(tenant: Tenant, job: Job & { readonly kind: "image" | "audio" }): Promise<BurstMessage>;
}

/**
 * The default: a photo's bytes read back from the store's R2 media, a voice note's transcript
 * (decode, then Muse Voice Transcribe). The processor stored each message's media before its job
 * ran, so a missing object is a failure, not "no disponible". Logs carry IDs only.
 */
export function storedMediaResolver(deps: VoiceNoteDeps): BurstMediaResolver {
  return {
    async resolve(tenant, job) {
      if (job.mediaAssetId === null) throw new UnreadableMediaError("no media with this message");
      if (job.kind === "audio") {
        const transcript = await transcribeVoiceNote(deps, tenant, job.mediaAssetId);
        // Attributed to this message by its position in the burst, like any other message.
        return { type: "transcript", text: transcript.text };
      }
      const asset = await deps.jobs.getMediaAsset(tenant, job.mediaAssetId);
      if (asset === null || asset.state !== "stored" || asset.storedKey === null) throw new Error("photo not stored");
      const media = await deps.mediaStore.read(tenant, asset.storedKey);
      if (media === null) throw new Error("photo missing from storage");
      // "image/jpeg; charset=…" never happens for photos, but the reader compares bare types.
      const mimeType = media.contentType.split(";")[0]!.trim().toLowerCase();
      if (!isSupportedImage(mimeType)) throw new UnreadableMediaError("photo format the model doesn't take");
      return { type: "image", mimeType, bytes: media.bytes };
    },
  };
}

/** No media reading at all: each photo or voice note keeps its place with nothing to read. */
export const unresolvedMedia: BurstMediaResolver = {
  async resolve(_tenant, job) {
    // A photo with no bytes reads as "(no disponible)"; a voice note has no transcript yet.
    return job.kind === "image" ? { type: "image", mimeType: "image/jpeg", bytes: null } : { type: "transcript", text: "" };
  },
};

export interface OrderReadingDeps {
  readonly reader: ModelBurstReader;
  readonly source: OrderReadingSource;
  readonly media: BurstMediaResolver;
  /** Extends the conversation lease before each slow step (a transcription, the model call). */
  readonly leases: Pick<JobRepository, "extendLease">;
  readonly log: Logger;
}

/** The order handler's reader: one model call per burst, behind the store's spend cap. */
export function createOrderReading(deps: OrderReadingDeps): BurstReader {
  return { read: (input) => readBurst(deps, input) };
}

async function readBurst(deps: OrderReadingDeps, { lease, messages, context }: BurstReaderInput): Promise<BurstRead> {
  const tenant: Tenant = { businessId: lease.businessId };
  const burst = await resolveBurst(deps, lease, tenant, messages);
  if (burst.every((message) => message.type === "location")) {
    // Only pins: nothing for the model to read. Code says what they are, at no cost.
    const perception = await deps.source.perceptionContext(context);
    return { reading: withSharedPin({ observations: [], calls: [] }, burst), matches: [], pendingQuestion: perception.pendingQuestion };
  }
  const [perception, catalog] = await Promise.all([deps.source.perceptionContext(context), deps.source.catalog(tenant)]);
  await holdLeaseFor(deps, lease, READING_MAX_MS);
  const outcome = await deps.reader.read(tenant, { audience: "customer", messages: burst, context: perception, catalog });
  if (!outcome.ok) throw new ReadingFailedError(outcome.reason);
  // Code matches come first; a pick only fills a line code couldn't match (resolvePicks).
  const picks: LineMatch[] = outcome.labelMatches.map(({ observation, line, productId }) => ({ observation, line, productId, how: "label_pick" }));
  if (picks.length > 0) deps.log.info("perception.label_picks_used", { businessId: tenant.businessId, count: picks.length });
  return { reading: withSharedPin(outcome.reading, burst), matches: [...outcome.matches, ...picks], pendingQuestion: perception.pendingQuestion };
}

/**
 * A shared location is a fulfillment fact whatever the model made of the burst (#29): its
 * coordinates come from the webhook, never from the model. When no fulfillment observation carries
 * the burst's last pin, code adds one (mode unknown, no words); a lone `other` gives way to it.
 */
export function withSharedPin(reading: BurstReading, burst: readonly BurstMessage[]): BurstReading {
  const pin = lastPin(burst);
  if (pin === null || reading.observations.some((o) => o.kind === "fulfillment" && o.pin !== null)) return reading;
  const fulfillment: Observation = { kind: "fulfillment", mode: null, pin, placeText: null, sameAsBefore: false, issues: [] };
  const kept = reading.observations.filter((o) => !(o.kind === "other" && o.issues.length === 0));
  return { ...reading, observations: [...kept, fulfillment] };
}

function lastPin(burst: readonly BurstMessage[]): { latitude: number; longitude: number } | null {
  for (let i = burst.length - 1; i >= 0; i--) {
    const message = burst[i]!;
    if (message.type === "location") return { latitude: message.latitude, longitude: message.longitude };
  }
  return null;
}

/**
 * One job, one message, in order: positions in the burst are what evidence points at, so a voice
 * note's transcript is evidence from that voice note. Voice notes run one at a time, each under a
 * lease extended to cover it. Every photo and voice note is tried, so one failure reports them all.
 */
async function resolveBurst(deps: OrderReadingDeps, lease: Lease, tenant: Tenant, messages: readonly Job[]): Promise<BurstMessage[]> {
  const burst: BurstMessage[] = [];
  const failures: UnreadableMedia[] = [];
  for (const job of messages) {
    if (job.location !== null) {
      burst.push({ type: "location", latitude: job.location.latitude, longitude: job.location.longitude });
      continue;
    }
    if (job.kind !== "image" && job.kind !== "audio") {
      burst.push({ type: "text", text: job.textBody ?? "" });
      continue;
    }
    if (job.kind === "audio") await holdLeaseFor(deps, lease, TRANSCRIBE_MAX_MS);
    try {
      burst.push(await deps.media.resolve(tenant, { ...job, kind: job.kind }));
    } catch (error) {
      if (error instanceof StaleWriteError) throw error;
      failures.push({ jobId: job.id, kind: job.kind, reason: describeError(error), permanent: error instanceof UnreadableMediaError });
    }
  }
  for (const failure of failures) {
    deps.log.warn("burst_media_unreadable", {
      businessId: lease.businessId,
      conversationId: lease.conversationId,
      inboundId: failure.jobId,
      reason: failure.reason,
      outcome: failure.permanent ? "permanent" : "retryable",
    });
  }
  if (failures.length > 0) throw new BurstMediaUnreadableError(failures);
  return burst;
}

/**
 * Makes the lease outlast a slow step: the step's own timeout plus a normal lease for what follows.
 * The step has a hard timeout, so one fenced extension is enough: no renewal runs beside it. If the
 * lease is already gone, nothing slow (or paid) starts, and every later write is refused anyway.
 */
async function holdLeaseFor(deps: OrderReadingDeps, lease: Lease, stepMaxMs: number): Promise<void> {
  if (!(await deps.leases.extendLease(lease, stepMaxMs + LEASE_TTL_MS))) throw new LeaseLostError();
}
