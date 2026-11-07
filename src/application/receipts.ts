/**
 * Supplier invoices on the console (K14), owner only. A photo is stored (immutable, by SHA-256), read
 * through `ReceiptReader`, and becomes draft revision 1 with each line matched to a product or
 * "nuevo". The owner edits it (each edit is the next revision), then approves the revision on screen
 * or declines it with a reason. Approve is one guarded batch: the new products, the `receipt` fact
 * (evidence: the member and the photo; the draft revision on the fact), its stock movements and
 * balances, the draft spent. Decline is one `receipt_review` fact. "Anular" is a `cancellation` that
 * closes the receipt and restores its stock with compensating movements.
 *
 * AI proposes, the engine commits (non-negotiable 1): the reading only fills a draft. Every approval
 * reads first (D-42) and the guards stay as the backstop for a race.
 */
import { type FactPrecheckReads, precheckFact } from "../domain/fact-precheck";
import type { FactCommit } from "../domain/facts";
import { reviewReason } from "../domain/change-request";
import {
  applyEdit,
  type CatalogEntry,
  CONSOLE_CONVERSATION,
  draftFromReading,
  type EditResult,
  type LineEdit,
  missingQuantity,
  nameKey,
  receiptApproveKey,
  receiptCancelKey,
  type ReceiptDraftBody,
  receiptReviewKey,
} from "../domain/receipt-draft";
import { isDemoBusiness } from "../domain/demo";
import { storePrefix } from "../domain/media";
import type { MemberContext } from "./engine";
import { FactRefusedError } from "./errors";
import type { CommitRunner } from "./catalog";
import type { BusinessContext, Commit, IdSource, MediaStore, Tenant } from "./ports";
import type { ReceiptReader } from "./receipt-reader";

export const MAX_INVOICE_BYTES = 10 * 1024 * 1024;
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A console draft and what the ledger says about it. */
export interface ConsoleReceiptDraft {
  readonly id: string;
  readonly revision: number;
  readonly state: "pending" | "committed" | "cancelled" | "expired";
  readonly body: ReceiptDraftBody;
  readonly mediaKey: string;
  readonly mediaSha256: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  /** The receipt fact an approval wrote, and whether it was cancelled since. */
  readonly receipt: { readonly factId: string; readonly cancelled: boolean } | null;
  /** The decline's reason. */
  readonly declined: { readonly reason: string } | null;
}

export interface ReceiptDraftStore {
  /** The store's products, for matching. No alias table exists yet, so `aliases` is empty. */
  catalog(tenant: Tenant): Promise<readonly CatalogEntry[]>;
  get(tenant: Tenant, draftId: string): Promise<ConsoleReceiptDraft | null>;
  list(tenant: Tenant): Promise<readonly ConsoleReceiptDraft[]>;
  /** Writes revision 1 once; the same id again changes nothing. */
  create(
    tenant: Tenant,
    draft: {
      readonly id: string;
      readonly memberId: string;
      readonly body: ReceiptDraftBody;
      readonly mediaKey: string;
      readonly mediaSha256: string;
      readonly nowMs: number;
      readonly expiresAtMs: number;
    },
  ): Promise<void>;
  /** The next revision, only from `fromRevision` while pending. False when someone got there first. */
  revise(tenant: Tenant, draftId: string, fromRevision: number, body: ReceiptDraftBody, nowMs: number): Promise<boolean>;
  /** The stored photo, or null when it is gone or not the store's. */
  image(tenant: Tenant, key: string): Promise<{ readonly bytes: ArrayBuffer; readonly contentType: string } | null>;
  /** The new products' rows, with the guard that every matched product is still the store's. */
  productsCommit(tenant: Tenant, created: readonly { readonly id: string; readonly name: string }[], matched: readonly string[], nowMs: number): Commit;
  /** The draft leaves `pending` as `cancelled`, pinned to the revision declined. */
  declineCommit(tenant: Tenant, draftId: string, revision: number, nowMs: number): Commit;
  /** The products whose balance is below what the receipt added: cancelling it would take them negative. */
  shortfalls(tenant: Tenant, receiptFactId: string): Promise<readonly string[]>;
}

/** The ledger's two halves, as this service uses them: the batch for a fact, and the read before it. */
export interface ReceiptLedger {
  statementsFor(scope: Tenant & { readonly conversationId?: string }, commit: FactCommit, nowMs: number): Commit;
}
export interface ReceiptPrecheck {
  read(scope: Tenant & { readonly conversationId?: string }, commit: FactCommit): Promise<FactPrecheckReads>;
}

export type UploadResult =
  | { readonly type: "drafted"; readonly draftId: string }
  /** The same photo was uploaded before: its draft, whatever became of it. */
  | { readonly type: "exists"; readonly draftId: string }
  | { readonly type: "refused"; readonly reason: "not_allowed" | "empty" | "too_large" | "pdf" | "type" | "unreadable" };

export type EditDraftResult =
  | { readonly type: "revised"; readonly revision: number }
  | { readonly type: "invalid"; readonly error: Extract<EditResult, { ok: false }> }
  | { readonly type: "refused"; readonly reason: "not_allowed" | "not_found" | "stale" | "not_pending" };

export type ApproveResult =
  | { readonly type: "approved"; readonly factId: string }
  | { readonly type: "duplicate" }
  | {
      readonly type: "refused";
      readonly reason: "not_allowed" | "not_found" | "stale" | "not_pending" | "missing_qty" | "name_taken";
      readonly line?: number;
    };

export type DeclineResult =
  | { readonly type: "declined" }
  | { readonly type: "duplicate" }
  | { readonly type: "refused"; readonly reason: "not_allowed" | "not_found" | "stale" | "not_pending" | "reason" };

export type CancelResult =
  | { readonly type: "cancelled" }
  | { readonly type: "duplicate" }
  | { readonly type: "refused"; readonly reason: "not_allowed" | "not_found" | "not_committed" | "stock_used"; readonly products?: readonly string[] };

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) => prefix.every((byte, n) => bytes[at + n] === byte);
const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/** The type the bytes are, never the type the form claims. PDF is named so it can be refused kindly. */
export function sniffImageType(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | "pdf" | null {
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, PNG)) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  return null;
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One draft per photo per store, race-free: the id is derived from the store and the photo's hash. */
async function draftIdFor(businessId: string, mediaSha256: string): Promise<string> {
  return `inv_${(await sha256Hex(new TextEncoder().encode(`${businessId}:${mediaSha256}`))).slice(0, 40)}`;
}

const scopeOf = (member: MemberContext) => ({ businessId: member.businessId, conversationId: CONSOLE_CONVERSATION });

export class ReceiptService {
  constructor(
    private readonly deps: {
      readonly store: ReceiptDraftStore;
      readonly media: MediaStore;
      readonly reader: ReceiptReader;
      readonly context: BusinessContext;
      readonly ledger: ReceiptLedger;
      readonly precheck: ReceiptPrecheck;
      readonly runner: CommitRunner;
      readonly ids: IdSource;
    },
  ) {}

  list(member: MemberContext): Promise<readonly ConsoleReceiptDraft[]> {
    return this.deps.store.list(member);
  }

  get(member: MemberContext, draftId: string): Promise<ConsoleReceiptDraft | null> {
    return this.deps.store.get(member, draftId);
  }

  catalog(member: MemberContext): Promise<readonly CatalogEntry[]> {
    return this.deps.store.catalog(member);
  }

  async image(member: MemberContext, draftId: string) {
    const draft = await this.deps.store.get(member, draftId);
    return draft === null ? null : this.deps.store.image(member, draft.mediaKey);
  }

  /** Owner only: store the photo, read it, draft revision 1. */
  /** `seeded` is set only by the demo history, which scripts a demo store's invoices; visitors can't upload. */
  async upload(member: MemberContext, file: { readonly bytes: ArrayBuffer }, opts: { readonly seeded?: boolean } = {}): Promise<UploadResult> {
    const { store, media, reader, context } = this.deps;
    if (member.role !== "owner") return { type: "refused", reason: "not_allowed" };
    if (isDemoBusiness(member.businessId) && opts.seeded !== true) return { type: "refused", reason: "not_allowed" };
    if (file.bytes.byteLength === 0) return { type: "refused", reason: "empty" };
    if (file.bytes.byteLength > MAX_INVOICE_BYTES) return { type: "refused", reason: "too_large" };
    const type = sniffImageType(new Uint8Array(file.bytes, 0, Math.min(file.bytes.byteLength, 16)));
    // A PDF's first page needs a renderer the Workers platform doesn't have; no PDF library (K14 scope).
    if (type === "pdf") return { type: "refused", reason: "pdf" };
    if (type === null) return { type: "refused", reason: "type" };

    const stored = await media.putImmutable(member, `${storePrefix(member.businessId)}invoices`, { bytes: file.bytes, contentType: type });
    const draftId = await draftIdFor(member.businessId, stored.sha256);
    if ((await store.get(member, draftId)) !== null) return { type: "exists", draftId };

    const read = await reader.read(member, { bytes: file.bytes, contentType: type, sha256: stored.sha256 }, await context.current(member));
    if (read.type === "refused") return { type: "refused", reason: "unreadable" };
    await store.create(member, {
      id: draftId,
      memberId: member.memberId,
      body: draftFromReading(read.reading, await store.catalog(member)),
      mediaKey: stored.key,
      mediaSha256: stored.sha256,
      nowMs: member.nowMs,
      expiresAtMs: member.nowMs + DRAFT_TTL_MS,
    });
    return { type: "drafted", draftId };
  }

  /** The owner's edit of the revision on screen becomes the next revision. */
  async edit(
    member: MemberContext,
    draftId: string,
    revision: number,
    edit: { readonly supplier: string; readonly lines: readonly LineEdit[] },
  ): Promise<EditDraftResult> {
    const { store } = this.deps;
    if (member.role !== "owner") return { type: "refused", reason: "not_allowed" };
    const draft = await store.get(member, draftId);
    if (draft === null) return { type: "refused", reason: "not_found" };
    if (draft.state !== "pending" || draft.expiresAtMs <= member.nowMs) return { type: "refused", reason: "not_pending" };
    if (draft.revision !== revision) return { type: "refused", reason: "stale" };
    const result = applyEdit(edit, await store.catalog(member), draft.body);
    if (!result.ok) return { type: "invalid", error: result };
    if (!(await store.revise(member, draftId, revision, result.body, member.nowMs))) return { type: "refused", reason: "stale" };
    return { type: "revised", revision: revision + 1 };
  }

  /** Owner only: the exact revision on screen becomes one receipt fact with its stock, in one batch. */
  async approve(member: MemberContext, draftId: string, revision: number): Promise<ApproveResult> {
    const { store, ledger, precheck, runner, ids } = this.deps;
    if (member.role !== "owner") return { type: "refused", reason: "not_allowed" };
    const draft = await store.get(member, draftId);
    if (draft === null) return { type: "refused", reason: "not_found" };
    if (draft.receipt !== null) return { type: "duplicate" };

    // A movement needs a known quantity; a new product needs a name no product took since the draft.
    const missing = missingQuantity(draft.body);
    if (draft.state === "pending" && draft.revision === revision && missing !== null) return { type: "refused", reason: "missing_qty", line: missing };
    const catalog = await store.catalog(member);
    const created = new Map<string, { id: string; name: string }>();
    const productOf: string[] = [];
    for (const [index, line] of draft.body.lines.entries()) {
      if (line.match !== null) {
        productOf.push(line.match.productId);
        continue;
      }
      const key = nameKey(line.name);
      if (catalog.some((product) => nameKey(product.name) === key)) return { type: "refused", reason: "name_taken", line: index + 1 };
      const product = created.get(key) ?? { id: ids.newId(), name: line.name };
      created.set(key, product);
      productOf.push(product.id);
    }

    const fact: FactCommit = {
      factId: ids.newId(),
      kind: "receipt",
      operationKey: receiptApproveKey(draftId),
      draft: { id: draftId, revision },
      actorUserId: member.memberId,
      validFromMs: member.nowMs,
      body: {
        supplier: draft.body.supplier,
        date: draft.body.date,
        lines: draft.body.lines.map((line, n) => ({ ...line, productId: productOf[n] })),
        media: { key: draft.mediaKey, sha256: draft.mediaSha256 },
      },
      evidence: [
        { kind: "member", refId: member.memberId, contentSha256: null },
        { kind: "media_asset", refId: draft.mediaKey, contentSha256: draft.mediaSha256 },
      ],
      dependsOn: [],
      closes: null,
      movements: draft.body.lines.map((line, n) => ({
        id: ids.newId(),
        productId: productOf[n]!,
        qtyMilli: line.qtyMilli!,
        unitCostCentavos: line.unitCostCentavos,
      })),
    };
    const stopped = precheckFact(fact, await precheck.read(scopeOf(member), fact), member.nowMs);
    if (stopped !== null) {
      if (stopped.outcome.type === "duplicate") return { type: "duplicate" };
      if (stopped.outcome.type === "rejected" && stopped.outcome.reason === "stale_version") return { type: "refused", reason: "stale" };
      return { type: "refused", reason: "not_pending" };
    }
    const matched = [...new Set(draft.body.lines.flatMap((line) => (line.match === null ? [] : [line.match.productId])))];
    try {
      await runner.run([store.productsCommit(member, [...created.values()], matched, member.nowMs), ledger.statementsFor(scopeOf(member), fact, member.nowMs)]);
    } catch (error) {
      // A race the read couldn't see (an edit or a decline between the read and the batch): nothing was written.
      if (error instanceof FactRefusedError) return { type: "refused", reason: "stale" };
      throw error;
    }
    return { type: "approved", factId: fact.factId };
  }

  /** Owner only: one `receipt_review` fact with the reason, and the draft leaves `pending`. No stock. */
  async decline(member: MemberContext, draftId: string, revision: number, rawReason: unknown): Promise<DeclineResult> {
    const { store, ledger, precheck, runner, ids } = this.deps;
    if (member.role !== "owner") return { type: "refused", reason: "not_allowed" };
    const reason = reviewReason(rawReason);
    if (reason === null) return { type: "refused", reason: "reason" };
    const draft = await store.get(member, draftId);
    if (draft === null) return { type: "refused", reason: "not_found" };
    if (draft.declined !== null) return { type: "duplicate" };
    if (draft.state !== "pending" || draft.expiresAtMs <= member.nowMs) return { type: "refused", reason: "not_pending" };
    if (draft.revision !== revision) return { type: "refused", reason: "stale" };

    const fact: FactCommit = {
      factId: ids.newId(),
      kind: "receipt_review",
      operationKey: receiptReviewKey(draftId),
      draft: null,
      actorUserId: member.memberId,
      validFromMs: member.nowMs,
      body: { draftId, revision, decision: "decline", reason },
      evidence: [{ kind: "member", refId: member.memberId, contentSha256: null }],
      dependsOn: [],
      closes: null,
      movements: [],
    };
    if ((await precheck.read(member, fact)).firstOutcome !== null) return { type: "duplicate" };
    try {
      await runner.run([store.declineCommit(member, draftId, revision, member.nowMs), ledger.statementsFor(member, fact, member.nowMs)]);
    } catch (error) {
      if (error instanceof FactRefusedError) return { type: "refused", reason: "stale" };
      throw error;
    }
    return { type: "declined" };
  }

  /**
   * Owner only: "anular factura". A cancellation closes the receipt and restores its stock with
   * compensating movements; a price resting on the receipt stops being live through the gate. If part
   * of the stock is already gone, the read refuses with the products; if it goes between the read and
   * the batch, the balance CHECK fails the whole batch loudly. Never clamped.
   */
  async cancel(member: MemberContext, draftId: string): Promise<CancelResult> {
    const { store, ledger, precheck, runner, ids } = this.deps;
    if (member.role !== "owner") return { type: "refused", reason: "not_allowed" };
    const draft = await store.get(member, draftId);
    if (draft === null) return { type: "refused", reason: "not_found" };
    if (draft.receipt === null) return { type: "refused", reason: "not_committed" };
    if (draft.receipt.cancelled) return { type: "duplicate" };

    const fact: FactCommit = {
      factId: ids.newId(),
      kind: "cancellation",
      operationKey: receiptCancelKey(draft.receipt.factId),
      draft: null,
      actorUserId: member.memberId,
      validFromMs: member.nowMs,
      body: { draftId, receiptFactId: draft.receipt.factId },
      evidence: [{ kind: "member", refId: member.memberId, contentSha256: null }],
      dependsOn: [],
      closes: { factId: draft.receipt.factId, reason: "cancelled" },
      movements: [],
    };
    const stopped = precheckFact(fact, await precheck.read(member, fact), member.nowMs);
    if (stopped !== null) return stopped.outcome.type === "duplicate" || stopped.closes === "closed" ? { type: "duplicate" } : { type: "refused", reason: "not_found" };
    const short = await store.shortfalls(member, draft.receipt.factId);
    if (short.length > 0) return { type: "refused", reason: "stock_used", products: short };
    try {
      await runner.run([ledger.statementsFor(member, fact, member.nowMs)]);
    } catch (error) {
      // Cancelled by another tap between the read and the batch. A balance that would go negative is
      // not caught here: it is a PermanentWriteError, and it reaches the owner as a failure.
      if (error instanceof FactRefusedError) return { type: "duplicate" };
      throw error;
    }
    return { type: "cancelled" };
  }
}
