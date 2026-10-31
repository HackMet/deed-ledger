/**
 * Reading a customer's burst for the order handler: the jobs become the reader's messages, the
 * engine says what perception may know (the open order's labelled lines and the question it asked
 * last, contract gap a) and which catalog code matches against (gap b), Muse Spark reads, and code
 * matches lines. Nothing here decides or saves anything.
 */
import type { PerceptionContext } from "../domain/contract/observation";
import type { BurstMessage } from "../domain/perception/burst";
import type { CustomerContext, Engine } from "./engine";
import { ReadingFailedError } from "./errors";
import type { BurstRead, BurstReader, BurstReaderInput } from "./order-handler";
import type { CatalogProduct } from "./perception/matching";
import type { BurstReader as ModelBurstReader } from "./perception/reader";
import type { Job, Logger, Tenant } from "./ports";

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
 * Photos and voice notes as the reader gets them. The seam for #26 (a photo's bytes read back from
 * R2) and #27 (a voice note's transcript): until they land, `unresolvedMedia` keeps each one's
 * place in the burst with nothing to read.
 */
export interface BurstMediaResolver {
  resolve(tenant: Tenant, job: Job & { readonly kind: "image" | "audio" }): Promise<BurstMessage>;
}

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
  readonly log: Logger;
}

/** The order handler's reader: one model call per burst, behind the store's spend cap. */
export function createOrderReading(deps: OrderReadingDeps): BurstReader {
  return { read: (input) => readBurst(deps, input) };
}

async function readBurst(deps: OrderReadingDeps, { lease, messages, context }: BurstReaderInput): Promise<BurstRead> {
  const tenant: Tenant = { businessId: lease.businessId };
  const [perception, catalog, burst] = await Promise.all([
    deps.source.perceptionContext(context),
    deps.source.catalog(tenant),
    Promise.all(messages.map((job) => toBurstMessage(deps.media, tenant, job))),
  ]);
  const outcome = await deps.reader.read(tenant, { audience: "customer", messages: burst, context: perception, catalog });
  if (!outcome.ok) throw new ReadingFailedError(outcome.reason);
  if (outcome.labelMatches.length > 0) {
    // The model's picks among labels code supplied aren't LineMatches until the contract says so.
    deps.log.info("perception.label_picks_unused", { businessId: tenant.businessId, count: outcome.labelMatches.length });
  }
  return { reading: outcome.reading, matches: outcome.matches, pendingQuestion: perception.pendingQuestion };
}

/** One job, one message: positions in the burst are what evidence points at. */
function toBurstMessage(media: BurstMediaResolver, tenant: Tenant, job: Job): Promise<BurstMessage> | BurstMessage {
  switch (job.kind) {
    case "image":
    case "audio":
      return media.resolve(tenant, { ...job, kind: job.kind });
    case "text":
    case "interactive":
    case "other":
      return { type: "text", text: job.textBody ?? "" };
  }
}
