import { type FactPrecheckReads, precheckFact } from "../../domain/fact-precheck";
import type { EvidenceRef, FactCommit } from "../../domain/facts";
import {
  ALREADY_SAVED,
  DEPENDENCY_CANCELLED,
  DRAFT_CHANGED,
  draftReply,
  FIXTURE_CLAIM,
  isConfirmation,
  NOTHING_PENDING,
  type ReceiptClaim,
  savedReply,
} from "../../domain/receipt";
import type { Clock, Commit, IdSource, JobHandler, JobOutcome, Lease, ReplyDraft } from "../ports";
import { placeholderHandler } from "../placeholder-handler";

/** A receipt draft as stored: the claim is the revision `revision`, never re-read from a model. */
export interface StoredReceiptDraft {
  readonly id: string;
  readonly revision: number;
  readonly state: "pending" | "committed" | "cancelled" | "expired";
  readonly claim: ReceiptClaim;
  readonly sourceInboundId: string;
  readonly sourceMediaAssetId: string | null;
  readonly expiresAtMs: number;
}

export interface ReceiptDrafts {
  /** Writes revision 1 once; the same draft id again changes nothing. */
  propose(lease: Lease, draft: {
    readonly id: string;
    readonly claim: ReceiptClaim;
    readonly sourceInboundId: string;
    readonly sourceMediaAssetId: string | null;
    readonly nowMs: number;
    readonly expiresAtMs: number;
  }): Promise<void>;
  /** The conversation's newest receipt draft in any state. */
  latest(lease: Lease): Promise<StoredReceiptDraft | null>;
  /** The member the conversation belongs to: the actor, never taken from message text. */
  actorOf(lease: Lease): Promise<string | null>;
  /** The product ids for these names in the store, created if the catalog lacks them (fixture claims only). */
  ensureProducts(lease: Lease, names: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** The stored object's SHA-256, or null while the asset isn't stored. */
  mediaSha256(lease: Lease, assetId: string): Promise<string | null>;
}

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const REPLY_TTL_MS = 24 * 60 * 60 * 1000;

const reply = (body: string): JobOutcome => ({ replies: [{ body, ttlMs: REPLY_TTL_MS } satisfies ReplyDraft] });

/**
 * The receipt slice of the engine: an invoice photo becomes a pending draft (from a FIXTURE claim:
 * no perception yet), and "confirmar" admits one receipt fact from that exact draft revision. Every
 * other message gets the placeholder's acknowledgement.
 */
export function receiptHandler(deps: {
  readonly drafts: ReceiptDrafts;
  readonly ids: IdSource;
  readonly clock: Clock;
  /** Turns the domain fact into the `Commit` the job's batch runs (D-40, D-41). */
  readonly ledger: { statementsFor(lease: Lease, commit: FactCommit, nowMs: number): Commit };
  /** The read before the write: what the records already say about this fact. */
  readonly precheck: { read(lease: Lease, commit: FactCommit): Promise<FactPrecheckReads> };
}): JobHandler {
  const { drafts, ids, clock, ledger, precheck } = deps;

  return {
    async handle(input) {
      const { lease, job } = input;

      if (job.kind === "image" && job.mediaAssetId !== null) {
        const now = clock.now();
        const draftId = `draft-${job.id}`;
        await drafts.propose(lease, {
          id: draftId,
          claim: FIXTURE_CLAIM,
          sourceInboundId: job.id,
          sourceMediaAssetId: job.mediaAssetId,
          nowMs: now,
          expiresAtMs: now + DRAFT_TTL_MS,
        });
        // A retried job reads the stored draft back, so the reply always matches what was stored.
        const stored = await drafts.latest(lease);
        return reply(draftReply((stored ?? { claim: FIXTURE_CLAIM }).claim));
      }

      if (job.kind === "text" && isConfirmation(job.textBody)) {
        const draft = await drafts.latest(lease);
        if (draft === null || draft.state === "cancelled" || draft.state === "expired") return reply(NOTHING_PENDING);
        if (draft.state === "committed") return reply(ALREADY_SAVED);
        const now = clock.now();
        if (draft.expiresAtMs <= now) return reply(NOTHING_PENDING);

        const actorUserId = await drafts.actorOf(lease);
        if (actorUserId === null) return reply(NOTHING_PENDING);
        const products = await drafts.ensureProducts(lease, draft.claim.lines.map((line) => line.name));

        const evidence: EvidenceRef[] = [{ kind: "inbound_message", refId: draft.sourceInboundId, contentSha256: null }];
        if (draft.sourceMediaAssetId !== null) {
          const sha = await drafts.mediaSha256(lease, draft.sourceMediaAssetId);
          if (sha !== null) evidence.push({ kind: "media_asset", refId: draft.sourceMediaAssetId, contentSha256: sha });
        }
        // The confirming message goes last: it is the one the confirmation row records.
        evidence.push(
          { kind: "inbound_message", refId: job.id, contentSha256: null },
          { kind: "confirmation", refId: ids.newId(), contentSha256: null },
        );

        const commit: FactCommit = {
          factId: ids.newId(),
          kind: "receipt",
          operationKey: `receipt:${draft.id}`,
          draft: { id: draft.id, revision: draft.revision },
          actorUserId,
          validFromMs: now,
          body: draft.claim,
          evidence,
          dependsOn: [],
          closes: null,
          movements: draft.claim.lines.map((line) => ({
            id: ids.newId(),
            productId: products.get(line.name)!,
            qtyMilli: line.qtyMilli,
            unitCostCentavos: line.unitCostCentavos,
          })),
        };
        // Read before writing. A guard answers by failing the batch, which is right for a race and
        // wrong for something the records already settle, so ask them first and answer the owner.
        const stopped = precheckFact(commit, await precheck.read(lease, commit), now);
        if (stopped !== null) {
          if (stopped.outcome.type === "duplicate") return reply(ALREADY_SAVED);
          if (stopped.deadDependencies !== undefined) return reply(DEPENDENCY_CANCELLED);
          if (stopped.outcome.type === "rejected" && stopped.outcome.reason === "stale_version") return reply(DRAFT_CHANGED);
          return reply(NOTHING_PENDING);
        }
        return { replies: reply(savedReply(draft.claim)).replies, commits: [ledger.statementsFor(lease, commit, now)] };
      }

      return placeholderHandler.handle(input);
    },
  };
}

