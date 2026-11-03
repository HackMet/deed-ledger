/**
 * What the application layer needs from the outside world. Infrastructure and integrations
 * implement these; tests swap in fakes for providers and use the real D1 repositories.
 */
import type { Claim } from "../domain/contract/outcomes";
import type { ProviderStatus } from "../domain/outbox";
import type { Pin, SavedPlace } from "../domain/place";
import type { MessageKind } from "../domain/processing";
import type { ClaimCheck, ReplyButton } from "../domain/replies";
import type { PromptCacheRetention, ReasoningEffort } from "./model-settings";

// ---------------------------------------------------------------------------------------------
// Context

/** Every read or write of store data is scoped by this. Never built from model output or text. */
export interface Tenant {
  readonly businessId: string;
}

export interface ConversationRef extends Tenant {
  readonly conversationId: string;
}

/** A consumer's hold on a conversation. leaseId is the fencing token every write checks. */
export interface Lease extends ConversationRef {
  readonly leaseId: string;
}

// ---------------------------------------------------------------------------------------------
// Channel-neutral events produced by a channel adapter (WhatsApp today)

export interface InboundMedia {
  readonly providerMediaId: string;
  readonly mimeType: string | null;
  readonly sha256: string | null;
}

export interface InboundMessageEvent {
  readonly type: "message";
  /** The store's receiving number (Meta's phone_number_id). */
  readonly phoneNumberId: string;
  /** Digits only. */
  readonly senderPhone: string;
  readonly providerMessageId: string;
  /** As sent by the provider: audit only, never trusted for time decisions. */
  readonly providerTimestampS: number;
  readonly kind: MessageKind;
  /** Untrusted content. Never logged. */
  readonly textBody: string | null;
  readonly replyId: string | null;
  readonly contextMessageId: string | null;
  readonly media: InboundMedia | null;
  /** A shared WhatsApp location (kind stays "other"): coordinates from the webhook. Absent means none. */
  readonly location?: Pin | null;
}

export interface StatusEvent {
  readonly type: "status";
  readonly phoneNumberId: string;
  readonly providerMessageId: string;
  readonly status: ProviderStatus;
  readonly providerTimestampS: number;
}

export type ChannelEvent = InboundMessageEvent | StatusEvent;

// ---------------------------------------------------------------------------------------------
// Small services

export interface Clock {
  /** Unix epoch milliseconds. */
  now(): number;
}

export interface IdSource {
  newId(): string;
}

/** Keyed hash (HMAC), so phone numbers and provider message IDs (which embed them) aren't stored. */
export interface KeyedHasher {
  hash(purpose: "sender" | "message" | "status", value: string): Promise<string>;
}

/** Logs carry IDs and codes only: never content, phone numbers or provider message IDs. */
export type LogFields = {
  readonly [K in
    | "businessId"
    | "conversationId"
    | "inboundId"
    | "outboxId"
    | "leaseId"
    | "assetId"
    | "channelAccountId"
    | "count"
    | "attempts"
    | "delaySeconds"
    | "reason"
    | "outcome"
    | "status"
    | "latencyMs"
    // A model call's usage and settings: counts and a setting name, never content.
    | "effort"
    | "inputTokens"
    | "cachedTokens"
    | "outputTokens"
    | "reasoningTokens"]?: string | number | boolean;
};

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

// ---------------------------------------------------------------------------------------------
// Providers

/** Tells the processor that a conversation has work. Carries nothing else. */
export interface Doorbell {
  ring(conversation: ConversationRef, delaySeconds?: number): Promise<void>;
}

export interface OutgoingText {
  readonly fromPhoneNumberId: string;
  readonly toPhone: string;
  readonly body: string;
}

/**
 * retry: not sent, try again later (a rate limit). permanent: not sent, never will be. unknown: it
 * may have been sent (a timeout, a dropped connection, a server error), so it is never sent again
 * automatically.
 */
export type SendResult =
  | { readonly ok: true; readonly providerMessageId: string }
  | { readonly ok: false; readonly disposition: "retry" | "permanent" | "unknown"; readonly errorCode: string };

/**
 * A text with reply buttons (Confirmar / Corregir / Cancelar), and the grey footer under them. When
 * the buttons can't be shown, the body goes as plain text with `textFallback` under it.
 */
export interface OutgoingButtons extends OutgoingText {
  readonly buttons: readonly ReplyButton[];
  readonly footer?: string;
  readonly textFallback?: string;
}

/** The inbound message a "typing…" indicator answers. Read from D1, never from text or model output. */
export interface TypingIndicator {
  /** The store's number the message arrived on (its conversation's channel account). */
  readonly fromPhoneNumberId: string;
  /** The provider's ID of that inbound message. It embeds the sender's phone: never logged. */
  readonly providerMessageId: string;
}

export type TypingResult = { readonly ok: true } | { readonly ok: false; readonly errorCode: string };

export interface MessagingChannel {
  /** False when credentials are missing: nothing is sent and the outbox keeps the message. */
  readonly configured: boolean;
  /** The longest text body the channel accepts, in UTF-16 code units. */
  readonly maxTextChars: number;
  sendText(message: OutgoingText): Promise<SendResult>;
  /**
   * Sends the body with reply buttons. Buttons the channel can't carry (too many, too long, a body
   * over the interactive limit) are dropped and the body goes as plain text. A channel without
   * this method gets plain text.
   */
  sendButtons?(message: OutgoingButtons): Promise<SendResult>;
  /**
   * Marks the inbound message (and the conversation's earlier ones) read and shows "typing…" until
   * the next reply, or 25 s on WhatsApp. Best effort: never retried, and a failure only means the
   * customer doesn't see it.
   */
  showTyping(indicator: TypingIndicator): Promise<TypingResult>;
}

export interface MediaBytes {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
}

export interface MediaSource {
  /** Null (or a throw) when the media can't be fetched now. */
  fetch(ref: { readonly providerMediaId: string; readonly phoneNumberId: string }): Promise<MediaBytes | null>;
}

export interface StoredMedia {
  readonly key: string;
  readonly sha256: string;
  readonly size: number;
}

export interface MediaStore {
  /**
   * Writes the bytes to an immutable key, `prefix/<sha256 of the bytes>`. The prefix must be inside
   * the tenant's prefix. Writing the same bytes twice writes the same object.
   */
  putImmutable(tenant: Tenant, prefix: string, media: MediaBytes): Promise<StoredMedia>;
  /** Reads a stored object back. The key must be inside the tenant's prefix. Null when it's gone. */
  read(tenant: Tenant, key: string): Promise<MediaBytes | null>;
}

/** A voice note as the transcriber takes it: mono 16-bit PCM WAV at 16 kHz. */
export interface TranscriberAudio {
  readonly wav: Uint8Array;
  readonly durationMs: number;
}

/** Turns a stored voice note (OGG/Opus from WhatsApp) into TranscriberAudio. Throws when it can't. */
export interface AudioDecoder {
  toTranscriberWav(audio: MediaBytes): Promise<TranscriberAudio>;
}

/** The transcript is untrusted content: data for the model, never instructions, never logged. */
export interface Transcript {
  readonly text: string;
  /** As reported by the provider; null when it didn't say. */
  readonly audioDurationMs: number | null;
}

/** Speech to text. Throws on any failure; the job's normal retry handles it. */
export interface Transcriber {
  transcribe(audio: TranscriberAudio): Promise<Transcript>;
}

// ---------------------------------------------------------------------------------------------
// Job handling: the engine plugs in here later. Today a placeholder handler replies.

export interface Job {
  readonly id: string;
  readonly kind: MessageKind;
  readonly textBody: string | null;
  readonly replyId: string | null;
  readonly contextMessageId: string | null;
  readonly mediaAssetId: string | null;
  /** A shared WhatsApp location's coordinates, from the webhook; null for any other message. */
  readonly location: Pin | null;
  readonly orderTsS: number;
  readonly receivedAtMs: number;
  /** Attempts started before this one. */
  readonly attempts: number;
  /** A deferred job isn't started before this time. */
  readonly retryAfterMs: number | null;
}

export interface JobInput {
  readonly lease: Lease;
  readonly job: Job;
  /**
   * True for the burst's newest message: the conversation's last open job when the round began.
   * Never for the last job of a round that couldn't take every open job (a longer burst goes on in
   * the next round).
   */
  readonly isNewestOfBurst: boolean;
}

export interface ReplyDraft {
  readonly body: string;
  /** How long the reply stays worth sending. Every reply expires. */
  readonly ttlMs: number;
  /**
   * True for a reply that answers the whole burst, from its newest message. Decided per job: if any
   * reply of a job closes the burst, all of that job's replies are written only if no other job of
   * the conversation is open when it completes, and otherwise none of them is (the burst's later
   * job answers instead). Other jobs' replies are not affected.
   */
  readonly closesBurst?: boolean;
  /**
   * What the reply claims, checked again right before it's sent: a reply with a claim that no
   * longer holds is not sent, the safe fixed reply goes instead. Absent or empty: claims nothing.
   */
  readonly claims?: readonly ClaimCheck[];
  /** Reply buttons; only the reply's last part carries them. */
  readonly buttons?: readonly ReplyButton[];
  /** The grey line under the buttons; goes with them. */
  readonly footer?: string;
  /** Put under the body only if it goes as plain text, without its buttons (the typed choices). */
  readonly textFallback?: string;
  /**
   * The outbox row's kind; "reply" when absent. A direct answer to a customer's control word
   * (CONTROL_REPLY_KIND) is the only kind dispatch still sends to a customer who typed ALTO.
   */
  readonly kind?: string;
}

/** A precondition checked inside a batch: `holdsSql` is 1 when it holds, NULL otherwise. */
export interface BatchGuard {
  readonly holdsSql: string;
  readonly params: readonly unknown[];
  /** Thrown when the batch fails and this is the first guard that doesn't hold. */
  readonly error: () => Error;
}

/**
 * Engine writes that land with the job or not at all. The engine's repositories build them; the
 * job repository runs them in the batch that completes the job, after the lease and job guards.
 * A guard that doesn't hold, or a statement that breaks a constraint, rolls back the whole batch:
 * no fact, no reply, and the job stays open.
 */
export interface Commit {
  readonly guards: readonly BatchGuard[];
  readonly statements: readonly D1PreparedStatement[];
  /**
   * Checked after the statements, in the same batch: the facts were written as intended. Not run
   * yet: until the fence runs them, completeJob refuses a commit that carries any.
   */
  readonly post?: readonly BatchGuard[];
}

export interface JobOutcome {
  /** Replies rendered by code, written to the outbox in the same batch that completes the job. */
  readonly replies: readonly ReplyDraft[];
  /** Saved in that same batch, whether or not the replies are withheld for closing a burst early. */
  readonly commits?: readonly Commit[];
}

/** Reads of fact memory, for the engine and for the answers. */
export interface FactQuery {
  isLive(tenant: Tenant, factId: string, atMs: number): Promise<boolean>;
  /** Null means unknown, never zero. */
  balance(tenant: Tenant, productId: string): Promise<{ readonly qtyMilli: number } | null>;
}

export interface JobHandler {
  handle(input: JobInput): Promise<JobOutcome>;
}

// ---------------------------------------------------------------------------------------------
// Repositories (D1 implementations in infrastructure/d1)

export interface ChannelAccount {
  readonly id: string;
  readonly businessId: string;
  readonly phoneNumberId: string;
}

export interface Member {
  readonly userId: string;
  readonly role: "owner" | "staff";
}

export interface TenancyRepository {
  /** Exact match on the receiving number. Null when no store owns it: there is no fallback. */
  findChannelAccount(phoneNumberId: string): Promise<ChannelAccount | null>;
  findChannelAccountOf(tenant: Tenant, channelAccountId: string): Promise<ChannelAccount | null>;
  findActiveMember(tenant: Tenant, phone: string): Promise<Member | null>;
}

export interface CustomerMessageInput {
  readonly channelAccountId: string;
  readonly event: InboundMessageEvent;
  readonly receivedAtMs: number;
  /** The provider timestamp clamped around receivedAtMs; used only for ordering. */
  readonly orderTsS: number;
  /** Used only if the customer, conversation, message or media asset doesn't exist yet. */
  readonly newCustomerId: string;
  readonly newConversationId: string;
  readonly newInboundId: string;
  readonly newMediaAssetId: string;
  readonly hourlyCap: number;
  /**
   * The sender's keyed hash (`hasher.hash("sender", phone)`): the batch stores nothing when this
   * sender's customer was deleted after the message was sent (#30).
   */
  readonly senderHash: string;
}

/** "refused": the sender's customer was deleted after this message was sent; nothing was stored. */
export type CustomerMessageOutcome = "new" | "duplicate" | "capped" | "refused";

export interface UnknownMessageInput {
  readonly channelAccountId: string;
  readonly senderHash: string;
  readonly messageHash: string;
  readonly providerTimestampS: number;
  readonly receivedAtMs: number;
  readonly newNoticeId: string;
  readonly noticeBody: string;
  /** Set on a notice when it is created or re-opened. */
  readonly noticeExpiresAtMs: number;
  readonly dailyCap: number;
}

/** Thrown as PermanentWriteError for constraint violations; other errors are transient. */
export interface IntakeRepository {
  /**
   * One batch: the customer (anyone writing to the store's number is the store's customer), the
   * conversation, media asset, the message with its pending job, last-inbound time. Every write
   * checks admission itself: the message isn't stored yet and the conversation is under its hourly
   * cap. A message that isn't admitted leaves no message or media row.
   */
  recordCustomerMessage(
    tenant: Tenant,
    input: CustomerMessageInput,
  ): Promise<
    | { readonly conversationId: string; readonly customerId: string; readonly outcome: Exclude<CustomerMessageOutcome, "refused"> }
    | { readonly outcome: "refused" }
  >;
  /**
   * One batch: the hashed record (unless over the daily cap) and the sender's notice. A notice is
   * created or re-opened unless one was sent in the last 24 hours. Returns the notice to send now.
   */
  recordUnknownMessage(
    tenant: Tenant,
    input: UnknownMessageInput,
  ): Promise<{ readonly stored: boolean; readonly pendingNoticeId: string | null }>;
  /**
   * Moves a sent message's delivery status forward. If the send result isn't stored yet, the
   * status is kept under `statusHash` and applied when it is.
   */
  recordProviderStatus(
    tenant: Tenant,
    event: StatusEvent,
    statusHash: string,
    nowMs: number,
  ): Promise<"applied" | "kept_early" | "unchanged">;
}

export interface MediaAssetForJob {
  readonly id: string;
  readonly providerMediaId: string;
  /** The asset's own prefix inside the store's prefix; objects live under it. */
  readonly prefix: string;
  readonly state: "pending" | "stored" | "failed";
  readonly storedKey: string | null;
  readonly phoneNumberId: string;
}

/** A row for the outbox. The job writing it is its group: see outbound_messages.job_id. */
export interface OutboxDraft {
  readonly id: string;
  readonly kind: string;
  readonly body: string;
  readonly dedupeKey: string;
  /** Which of the job's replies this is, and which part of it after splitting. */
  readonly replyIndex: number;
  readonly partIndex: number;
  readonly expiresAtMs: number;
  /** Every part of a reply carries the reply's claims. */
  readonly claims?: readonly ClaimCheck[];
  /** The last part carries the buttons, and the footer and text fallback that go with them. */
  readonly buttons?: readonly ReplyButton[];
  readonly footer?: string;
  readonly textFallback?: string;
}

/**
 * A customer notice from a console action, as an outbox row: in the customer's conversation, with
 * no job. Its group is the action's operation key within that conversation (outbound_messages.operation_key).
 */
export interface ConsoleNoticeDraft extends OutboxDraft {
  readonly conversationId: string;
}

/** A notice row the save wrote (a repeated dedupe key writes none), and whether it waits for the window. */
export interface QueuedConsoleNotice {
  readonly outboxId: string;
  readonly conversationId: string;
  readonly replyIndex: number;
  readonly partIndex: number;
  readonly status: "pending" | "waiting_window";
}

/** A burst still waiting for its answer, named by its oldest open message. */
export interface SlowBurst extends ConversationRef {
  readonly inboundId: string;
  readonly receivedAtMs: number;
}

/**
 * The fixed "we got your message" line, as an outbox row. It belongs to no job's group, so its
 * fate never stops the real answer. `claims` is always empty: the line says nothing about orders,
 * prices or stock, so neither pass of the claim check has anything to check.
 */
export interface SlowNoticeDraft {
  readonly id: string;
  readonly kind: string;
  readonly body: string;
  readonly dedupeKey: string;
  readonly expiresAtMs: number;
  readonly claims: readonly [];
}

export type LeaseClaim = "claimed" | "busy" | "missing";

export interface JobSnapshot {
  /** Open jobs in the conversation, settled or not. */
  readonly openCount: number;
  readonly newestReceivedAtMs: number | null;
  /** Insertion mark of the newest open job when the snapshot was taken. */
  readonly seq: number;
  /** The eligible jobs, in order. Empty unless every open job is older than the settle cutoff. */
  readonly jobs: readonly Job[];
}

/**
 * Jobs and leases. Lease times use the database's clock. Every method that takes a Lease writes
 * in one batch that fails, and throws a StaleWriteError, unless the lease is still held and the
 * job is in the state the transition expects.
 */
export interface JobRepository {
  claimLease(conversation: ConversationRef, leaseId: string, ttlMs: number): Promise<LeaseClaim>;
  extendLease(lease: Lease, ttlMs: number): Promise<boolean>;
  releaseLease(lease: Lease): Promise<void>;
  holdsLease(lease: Lease): Promise<boolean>;
  /** One statement: the open-job count, the newest arrival, and the jobs if all are settled. */
  snapshot(conversation: ConversationRef, settledBeforeMs: number, limit: number): Promise<JobSnapshot>;
  /** Whether a job arrived after the snapshot with that seq was taken. */
  hasArrivalsAfter(conversation: ConversationRef, seq: number): Promise<boolean>;
  getMediaAsset(tenant: Tenant, assetId: string): Promise<MediaAssetForJob | null>;
  /**
   * Where an open job's typing indicator goes: its message's provider ID and the store number it
   * arrived on. Null when the job isn't open in this conversation or its provider ID was erased (#30).
   */
  typingTarget(conversation: ConversationRef, jobId: string): Promise<TypingIndicator | null>;
  /**
   * pending (and due) or left processing by a dead lease -> processing under this lease. Only the
   * conversation's next job in order starts: if a message that sorts before it is open (it arrived
   * after the snapshot), nothing is written and a StaleSnapshotError is thrown.
   */
  startJob(lease: Lease, jobId: string, nowMs: number): Promise<void>;
  /** Publishes a stored object for an asset of a job running under this lease. */
  publishMedia(lease: Lease, jobId: string, assetId: string, stored: StoredMedia, nowMs: number): Promise<void>;
  /**
   * Completes the job, saves its commits and writes its replies, one batch. With `closesBurst`, the
   * replies are written only if no other job of the conversation is open, checked inside the batch:
   * all or none. The commits don't depend on that. Returns how many replies were written. A commit
   * guard that doesn't hold throws its own error; a constraint violation, PermanentWriteError.
   */
  completeJob(
    lease: Lease,
    jobId: string,
    nowMs: number,
    replies: readonly OutboxDraft[],
    closesBurst: boolean,
    commits?: readonly Commit[],
  ): Promise<number>;
  deferJob(lease: Lease, jobId: string, errorCode: string, retryAfterMs: number): Promise<void>;
  failJob(lease: Lease, jobId: string, errorCode: string, nowMs: number, replies: readonly OutboxDraft[]): Promise<void>;
  /** A job whose last attempt died with its consumer: open, attempts used up, not this lease's. */
  abandonJob(lease: Lease, jobId: string, errorCode: string, nowMs: number, replies: readonly OutboxDraft[]): Promise<void>;
  /** System sweep: conversations with due open jobs older than the cutoff and no live lease. */
  findStrandedConversations(cutoffMs: number, nowMs: number, limit: number): Promise<ConversationRef[]>;
  /**
   * System sweep: bursts still waiting for an answer, leased or not. One per conversation: its oldest
   * open message, received in [`notBeforeMs`, `receivedBeforeMs`), with no outbox row of the
   * conversation written at or after that message's arrival.
   */
  findSlowBursts(receivedBeforeMs: number, notBeforeMs: number, limit: number): Promise<SlowBurst[]>;
  /**
   * Queues the slow notice for that burst, in one statement that checks, as it writes, that the
   * message is still open and nothing was written to the conversation since it arrived. The
   * dedupe key is UNIQUE, so a burst gets it at most once. True only for the call that wrote it.
   */
  queueSlowNotice(burst: SlowBurst, notice: SlowNoticeDraft, nowMs: number): Promise<boolean>;
  /**
   * The burst a reading uses: the conversation's messages no reading has used yet, received at or
   * after `sinceMs`, in order, through `throughJobId` (which must be running under this lease).
   * Earlier messages qualify once their job is done; failed ones never do (they got their reply).
   * Every one of them, or BurstTooLargeError: never part of a burst.
   */
  unreadBurst(lease: Lease, throughJobId: string, sinceMs: number): Promise<Job[]>;
  /** The conversation's next open job after this one, in order; null when none is open. */
  nextOpenJob(lease: Lease, afterJobId: string): Promise<Job | null>;
  /**
   * A commit for the completion batch of `readerJobId`: these messages were used by its reading.
   * Fails loudly (BurstAlreadyReadError) when any of them was used already, so no line is applied
   * twice; a crash before the batch leaves them unread, so none is lost.
   */
  markReadCommit(lease: Lease, readerJobId: string, messageIds: readonly string[], nowMs: number): Commit;
}

export interface OutboxMessage {
  readonly id: string;
  readonly businessId: string;
  readonly channelAccountId: string;
  readonly conversationId: string | null;
  readonly recipientHash: string | null;
  readonly kind: string;
  readonly body: string;
  /** Attempts reserved so far, including the current claim's. */
  readonly attempts: number;
  readonly expiresAtMs: number;
  /** Checked right before the send. A stored value that can't be read never holds. */
  readonly claims?: readonly ClaimCheck[];
  readonly buttons?: readonly ReplyButton[];
  /** Under the buttons; sent only with them. */
  readonly footer?: string;
  /** Under the body when it goes as plain text after all. */
  readonly textFallback?: string;
}

export interface OutboxMaintenance {
  readonly expired: number;
  readonly unknownDelivery: number;
  /** Rows never sent because an earlier row of their group ended unsent. */
  readonly predecessorNotSent: number;
  readonly waitingWindow: number;
  readonly abandonedNotices: number;
  readonly pruned: number;
}

/**
 * The outbox. A conversation's rows go out one at a time, in the order they were written; a row
 * in a group (one job's replies) is never sent after an earlier row of the group ended unsent.
 * Claims use the database's clock. markSent and every method that settles a claim run as one batch
 * guarded by the claim: they return false, and write nothing at all, when this call's claim isn't
 * held (maintenance settled the row after the claim ran out, or the claim already settled it).
 */
export interface OutboxRepository {
  /**
   * Member rows that can go out now, oldest first: the oldest unsettled row of each conversation
   * whose window is open, if it is pending or waiting. The dispatcher settles expired ones.
   */
  listDispatchable(nowMs: number, limit: number, conversation?: ConversationRef): Promise<OutboxMessage[]>;
  get(tenant: Tenant, outboxId: string): Promise<OutboxMessage | null>;
  /**
   * Claims a pending or waiting row for `ttlMs` and reserves one send attempt, only if every
   * earlier row of its conversation has settled and none of its group ended unsent.
   */
  claim(tenant: Tenant, outboxId: string, claimId: string, ttlMs: number, nowMs: number): Promise<OutboxMessage | null>;
  /** Right before the send: true, and the claim extended by `ttlMs`, only while it is still held. */
  confirmClaim(tenant: Tenant, outboxId: string, claimId: string, ttlMs: number): Promise<boolean>;
  /** Our receive time of the recipient's newest message to this store, for the 24-hour window. */
  lastInboundAtMs(message: OutboxMessage): Promise<number | null>;
  /** The phone of the conversation's customer, or null when there is none to send to. */
  customerPhone(tenant: Tenant, conversationId: string): Promise<string | null>;
  /** Stores the result; then, and only then, applies any delivery status kept early under statusHash. */
  markSent(
    tenant: Tenant,
    outboxId: string,
    claimId: string,
    providerMessageId: string | null,
    statusHash: string | null,
    nowMs: number,
  ): Promise<boolean>;
  /** Not sent because the window was closed; the reserved attempt is given back. */
  markWaitingWindow(tenant: Tenant, outboxId: string, claimId: string, nowMs: number): Promise<boolean>;
  markExpired(tenant: Tenant, outboxId: string, claimId: string, nowMs: number): Promise<boolean>;
  /** The outcome is unknown: never sent again automatically. */
  markUnknownDelivery(tenant: Tenant, outboxId: string, claimId: string, errorCode: string, nowMs: number): Promise<boolean>;
  /** Not sent: back to pending, or failed when final. */
  release(tenant: Tenant, outboxId: string, claimId: string, errorCode: string, final: boolean, nowMs: number): Promise<boolean>;
  /**
   * The row's claims didn't hold right before the send: records it on the row (the safe reply goes
   * instead) and fails the reply's later parts, so none of them goes out. Guarded by the claim.
   */
  markClaimsBlocked(tenant: Tenant, outboxId: string, claimId: string, nowMs: number): Promise<boolean>;
  /** Sweep housekeeping: expiries, stale sends, stopped groups, closed windows, old notices, retention. */
  maintain(nowMs: number): Promise<OutboxMaintenance>;
  /**
   * The conversation a store's customer is written to: the one they wrote in last. Null when the
   * customer isn't this store's or has never written (known only by name).
   */
  conversationOfCustomer(tenant: Tenant, customerId: string): Promise<string | null>;
  /**
   * Saves a console action: its commits' guards and statements and its customer notices, as one
   * guarded batch, all or nothing. A notice whose conversation's 24-hour window has closed is written
   * as waiting_window. A repeated dedupe key writes nothing for that row. A commit guard that
   * doesn't hold throws its own error; a constraint violation, PermanentWriteError.
   */
  saveConsoleAction(
    tenant: Tenant,
    operationKey: string,
    commits: readonly Commit[],
    notices: readonly ConsoleNoticeDraft[],
    nowMs: number,
  ): Promise<QueuedConsoleNotice[]>;
}

/** A logged-in console member, from a session. The store comes from here, never from the request. */
export interface ConsoleMember extends Tenant {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: "owner" | "staff";
  readonly canApproveFiado: boolean;
  /** The name this store shows for them (same rule as `listMembers`); null when it has none. */
  readonly displayName: string | null;
}

export interface InvitePreview {
  readonly storeName: string;
}

export interface NewConsoleSession {
  readonly id: string;
  readonly tokenHash: string;
  readonly nowMs: number;
  readonly expiresAtMs: number;
}

export interface MemberSummary {
  readonly userId: string;
  readonly displayName: string | null;
  readonly role: "owner" | "staff";
  readonly active: boolean;
  readonly canApproveFiado: boolean;
}

/** Console invites and sessions. Tokens arrive and are stored hashed; times are the Worker's clock. */
export interface ConsoleAuthRepository {
  /** An invite that would open a session now, without using it. */
  previewInvite(tokenHash: string, nowMs: number): Promise<InvitePreview | null>;
  /**
   * One batch: uses the invite and opens the session, only while the invite is unused and unexpired
   * and its membership active. Null when it isn't, and then nothing was written.
   */
  acceptInvite(tokenHash: string, session: NewConsoleSession): Promise<ConsoleMember | null>;
  /** The session's member while the session is open and the membership active; checked on every request. */
  findSession(tokenHash: string, nowMs: number): Promise<ConsoleMember | null>;
  /**
   * Dev mode only (the local simulator, no login): the owner of the store on this WhatsApp phone
   * number ID, so the console shows the store the simulated customers write to. Null when none.
   */
  devOwner(phoneNumberId: string): Promise<ConsoleMember | null>;
  /** Ends every open session of the member. Returns how many were open. */
  revokeSessions(tenant: Tenant, userId: string, nowMs: number): Promise<number>;
  listMembers(tenant: Tenant): Promise<MemberSummary[]>;
  /**
   * Makes the person with this phone a staff member of the store, if they aren't a member yet.
   * Returns their membership as it is now; an existing member keeps their role. The name is this
   * store's own (a blank one on an existing staff membership is filled); the person's shared record
   * and other stores' names are never written or returned.
   */
  addStaff(
    tenant: Tenant,
    person: { readonly phone: string; readonly displayName: string | null; readonly nowMs: number },
  ): Promise<{ readonly userId: string; readonly role: "owner" | "staff" }>;
  /**
   * A new invite for a staff member of this store, active again if they were removed (with the
   * fiado permission off). Null when the person isn't staff of this store; then nothing was written.
   */
  createStaffInvite(
    tenant: Tenant,
    userId: string,
    invite: { readonly id: string; readonly tokenHash: string; readonly nowMs: number; readonly expiresAtMs: number },
  ): Promise<{ readonly phone: string; readonly displayName: string | null } | null>;
  /**
   * One batch: deactivates a staff member of this store, ends their unused invites and every open
   * session, or does none of it. Null when the person isn't staff of this store, and then nothing
   * was written. Owners are never removed here.
   */
  removeStaff(tenant: Tenant, userId: string, nowMs: number): Promise<{ readonly sessionsEnded: number } | null>;
  /** Turns the fiado permission of an active staff member on or off. False when there is no such member. */
  setFiadoPermission(tenant: Tenant, userId: string, allowed: boolean): Promise<boolean>;
  /** Whether the member already acknowledged that voice notes are kept as records. */
  voiceNoticeSeen(tenant: Tenant, userId: string): Promise<boolean>;
  markVoiceNoticeSeen(tenant: Tenant, userId: string, nowMs: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Customers. Customers and conversations are channel records owned by this side; business
// records (orders, payments, fiado) are the engine's.

export interface Customer {
  readonly id: string;
  /** As the customer gave it; null until they do. */
  readonly name: string | null;
  /** When the assistant asked for the name; it is asked once. */
  readonly nameAskedAtMs: number | null;
}

/** The order and version of the readback last queued to a conversation: what a typed "confirmar" answers. */
export interface ReadbackRef {
  readonly orderId: string;
  readonly version: number;
}

/**
 * The buttons on the last message a conversation was sent before a moment: what "1", "2" or "3"
 * typed alone, or a typed yes, can refer to. Empty when that message had none.
 */
export interface ButtonsShown {
  lastButtons(conversation: ConversationRef, beforeMs: number): Promise<readonly ReplyButton[]>;
}

export interface ConversationCustomer extends Customer {
  /** With when it was queued (our clock): a typed word answers it only if it arrived after that. */
  readonly lastReadback: (ReadbackRef & { readonly queuedAtMs: number }) | null;
}

/**
 * Customer records. Reads take the store from the lease; writes are commits for the job's
 * completion batch (`JobOutcome.commits`), never saved on their own.
 */
export interface CustomerRepository {
  /** The customer of a conversation in this store; null when the conversation isn't the store's. */
  ofConversation(conversation: ConversationRef): Promise<ConversationCustomer | null>;
  /**
   * Saves the name unless one is saved already: the first answer wins, so a name is saved once.
   * Fails loudly when the customer isn't this store's.
   */
  saveNameCommit(tenant: Tenant, customerId: string, name: string, nowMs: number): Commit;
  /**
   * Records that the name was asked, the first time only. With `closingJobId`, only when the
   * burst-closing reply carrying the question is written (see rememberReadbackCommit).
   */
  markNameAskedCommit(tenant: Tenant, customerId: string, nowMs: number, closingJobId: string | null): Commit;
  /**
   * Remembers the readback just queued, so typed words answer that version. With `closingJobId`
   * (the reply closes the burst and is withheld when another job is open), it is remembered only
   * when the reply is written: never a readback the customer won't see.
   */
  rememberReadbackCommit(
    conversation: ConversationRef,
    readback: ReadbackRef,
    nowMs: number,
    closingJobId: string | null,
  ): Commit;
}

/**
 * A customer's delivery places (#29), our records. A place is saved when a delivery order that used
 * it is confirmed; the newest used one is offered back as a question. Writes are commits for the
 * job's completion batch, each guarded on the customer being the store's.
 */
export interface CustomerPlaceRepository {
  /** The place used last, or null. */
  latest(tenant: Tenant, customerId: string): Promise<SavedPlace | null>;
  /**
   * Saves the place a confirmed delivery order used. One row per order: confirmed again after a
   * change, the order's place is updated, not added.
   */
  saveForOrderCommit(
    tenant: Tenant,
    customerId: string,
    orderId: string,
    place: { readonly placeText: string | null; readonly pin: Pin | null },
    nowMs: number,
  ): Commit;
  /** A saved place was used again: it stays the one offered next. */
  markUsedCommit(tenant: Tenant, customerId: string, placeId: string, nowMs: number): Commit;
}

// ---------------------------------------------------------------------------------------------
// The claim check and Pendientes

/** The second claim check: `Engine.verifyClaims` satisfies it. One answer per claim, in order. */
export interface ClaimVerifier {
  verifyClaims(tenant: Tenant, claims: readonly Claim[]): Promise<readonly boolean[]>;
}

/** Something a person must look at, raised from outside the engine. IDs only, never content. */
export interface PendienteItem {
  readonly kind: "claim_blocked";
  /** Which check blocked it: before the save, or right before sending. */
  readonly stage: "before_save" | "before_send";
  readonly conversationId: string | null;
  readonly outboxId: string | null;
  /** The reply's template name. */
  readonly template: string | null;
  readonly urgency?: PendienteUrgency;
}

/** How soon a person should look. Absent: in the normal course. */
export type PendienteUrgency = "urgent";

/** A customer is still waiting for an answer past the slow-notice limit: someone should look now. */
export interface SlowReplyPendiente {
  readonly kind: "slow_reply";
  readonly urgency: "urgent";
  readonly conversationId: string;
  /** The burst's oldest open message. */
  readonly inboundId: string;
  /** The notice queued to the customer. */
  readonly outboxId: string;
}

/**
 * A customer notice from a console action that can't go out yet: WhatsApp's 24-hour window is
 * closed, so it waits until the customer writes (no paid templates). Someone may call them instead.
 */
export interface NoticeWaitingPendiente {
  readonly kind: "notice_waiting_window";
  readonly conversationId: string;
  readonly outboxId: string;
  /** The notice's type, as the engine named it ("order_ready"). */
  readonly notice: string;
}

/**
 * Raises one Pendientes item. Contract gap (c) isn't agreed: this narrow port stands in until it is
 * (the proposal there returns a Commit for the caller's own batch instead). Never throws.
 */
export interface Pendientes {
  raise(tenant: Tenant, item: AnyPendiente): Promise<void>;
}

/** Pendientes as the owner's console lists them (wireframe C5). */
export interface PendientesBoard {
  /** Open items, urgent first, then newest first; at most 100. */
  listOpen(tenant: Tenant): Promise<readonly OpenPendiente[]>;
  /** "Listo": the item leaves the list. False when it isn't this store's or was already done. */
  markDone(tenant: Tenant, id: string, userId: string, nowMs: number): Promise<boolean>;
  /** How many items are open: the count on the owner's Pendientes tab. */
  countOpen(tenant: Tenant): Promise<number>;
}

export interface OpenPendiente {
  readonly id: string;
  readonly kind: AnyPendiente["kind"];
  /** A code: the question's topic, the notice's type, or the check's stage. */
  readonly detail: string | null;
  readonly count: number | null;
  readonly urgent: boolean;
  readonly raisedAtMs: number;
  /** Who it's about, when known: the name they gave, and the last four digits of their number. */
  readonly customerName: string | null;
  readonly phoneEnding: string | null;
  /** The conversation it came from, so the owner can answer in it; null when none. */
  readonly conversationId?: string | null;
  /**
   * What the customer last wrote before it was raised (their own words, up to three messages),
   * read from the conversation itself, so the owner knows what to answer. Null when nothing typed.
   */
  readonly said?: string | null;
}

export type AnyPendiente =
  | PendienteItem
  | SlowReplyPendiente
  | HandoffPendienteItem
  | NoticeWaitingPendiente
  | CustomerQuestionPendiente;

/**
 * A customer asked something the records can't answer yet and was told "te lo anoto y te
 * confirmo" (#47): a price not confirmed, a product with no recent stock evidence or not matched,
 * or hours not set. Someone answers from the conversation. IDs and counts only, never the words.
 */
export interface CustomerQuestionPendiente {
  readonly kind: "customer_question";
  readonly conversationId: string;
  readonly customerId: string;
  /** The message that closed the burst holding the question. */
  readonly inboundId: string;
  /** `order_prices`: a confirmed order holds lines with no confirmed price or product (Nov 2). */
  readonly topic: "price" | "availability" | "store_hours" | "order_prices";
  /** How many things asked about got "te confirmo" (1 for hours). */
  readonly unknown: number;
}

/** A customer asked to talk to a person ("quiero hablar con Johan"). IDs only, never the text. */
export interface HandoffPendienteItem {
  readonly kind: "customer_handoff";
  readonly conversationId: string;
  readonly customerId: string;
  /** The message that asked. */
  readonly inboundId: string;
}

// ---------------------------------------------------------------------------------------------
// Customer controls (#30): the first message, ALTO and SEGUIR, deletion on request

/** What the customer gate needs to know about a conversation's customer, and how the store speaks. */
export interface CustomerControlState {
  readonly customerId: string;
  readonly storeName: string;
  /** The first name of the store's first active owner, if the console has one. */
  readonly ownerName: string | null;
  readonly introducedAtMs: number | null;
  readonly stoppedAtMs: number | null;
  readonly stopRemindedAtMs: number | null;
  readonly deletionRequestedAtMs: number | null;
}

/** A customer whose deletion was requested and is due to be purged. */
export interface DeletionDue extends Tenant {
  readonly customerId: string;
}

/** What a purge must remove outside D1: the R2 prefixes of the customer's media assets. */
export interface DeletionMedia {
  readonly phone: string | null;
  readonly mediaPrefixes: readonly string[];
}

/**
 * Customer control records. Reads take the store from the lease or the message; the gate's writes
 * are commits for the job's completion batch, like CustomerRepository's.
 */
export interface CustomerControlRepository {
  stateOf(conversation: ConversationRef): Promise<CustomerControlState | null>;
  /** Dispatch: whether the conversation's customer typed ALTO (or asked for deletion) and hasn't resumed. */
  isStopped(tenant: Tenant, conversationId: string): Promise<boolean>;
  /**
   * The first reply was written. With `closingJobId`, only if the burst-closing reply carrying it
   * is written (no other job of the conversation is open), like rememberReadbackCommit.
   */
  markIntroducedCommit(tenant: Tenant, customerId: string, nowMs: number, closingJobId: string | null): Commit;
  /** ALTO: the stop time, kept if already stopped; a new stop gets a new reminder. */
  stopCommit(tenant: Tenant, customerId: string, nowMs: number): Commit;
  /** SEGUIR: clears the stop, unless a deletion was requested. */
  resumeCommit(tenant: Tenant, customerId: string): Commit;
  markStopRemindedCommit(tenant: Tenant, customerId: string, nowMs: number): Commit;
  /** An explicit deletion request: stops the customer and marks them for the purge. */
  requestDeletionCommit(tenant: Tenant, customerId: string, nowMs: number): Commit;
  /**
   * Customers due for the purge, across stores (the sweep, like findStrandedConversations): asked
   * at or before `readyBeforeMs`, or whose conversations have nothing left to send.
   */
  deletionsDue(readyBeforeMs: number, limit: number): Promise<DeletionDue[]>;
  /**
   * The customer's phone and the R2 prefixes of their messages' media; with `uptoReceivedAtMs`
   * (a test reset), only of messages received by then: the same cutoff as `resetCommit`.
   */
  deletionMedia(tenant: Tenant, customerId: string, uptoReceivedAtMs?: number): Promise<DeletionMedia>;
  /**
   * One batch: removes the customer's personal data from D1 (phone, name, message text, provider
   * IDs, media references, sent bodies), fails anything still unsent, and writes the tombstone.
   * Only for a customer whose deletion was requested and not finished. False when there was none.
   */
  purge(tenant: Tenant, customerId: string, senderHash: string | null, nowMs: number): Promise<boolean>;
  /** Test commands' lock: the customer's phone is an active member's (owner or staff) of this store. */
  isStoreMember(tenant: Tenant, customerId: string): Promise<boolean>;
  /**
   * Test command /new: the purge's erasure for this customer's messages up to `uptoReceivedAtMs`,
   * and the customer's own marks (name, introduced, ALTO, deletion request) cleared. The phone
   * stays, so the reply reaches them and their next message is a first message. The inbound
   * messages keep their provider IDs: intake recognizes a re-delivered message by them.
   */
  resetCommit(tenant: Tenant, customerId: string, uptoReceivedAtMs: number, nowMs: number): Commit;
  /**
   * Customers purged at or after `sinceMs`, across stores: the sweep erases their media prefixes
   * again, for an upload that was in flight during the purge.
   */
  purgedSince(sinceMs: number, limit: number): Promise<DeletionDue[]>;
}

/** Deletes stored objects. Used only by the deletion purge. */
export interface MediaEraser {
  /** Deletes every object under `prefix/`, which must be inside the tenant's prefix. Idempotent. */
  erasePrefix(tenant: Tenant, prefix: string): Promise<number>;
}

// ---------------------------------------------------------------------------------------------
// Model provider (Muse Spark) and the per-store spend cap

/** A user-content part. Message text, photos and transcripts only ever travel as these. */
export type ModelContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mimeType: string; readonly bytes: ArrayBuffer };

/** One structured-output call: a fixed system prompt, untrusted user content, a strict schema. */
export interface ModelRequest {
  readonly system: string;
  readonly user: readonly ModelContentPart[];
  readonly schemaName: string;
  readonly schema: { readonly [key: string]: unknown };
  /** Caps reasoning plus visible output tokens; the spend reservation counts on it. */
  readonly maxOutputTokens: number;
  /** Absent: the model's own effort. Lower effort means fewer reasoning tokens, never more than the cap. */
  readonly reasoningEffort?: ReasoningEffort;
  /**
   * Groups requests that start with the same fixed instructions, for prompt-cache hits. Names an
   * instruction version, never a store, a customer or a message.
   */
  readonly promptCacheKey?: string;
  readonly promptCacheRetention?: PromptCacheRetention;
}

/**
 * rejected: the provider refused the request (4xx other than 429), so nothing was spent.
 * unavailable: rate limited, server error, timeout or network failure; spend unknown.
 * invalid_json: the call succeeded but the content wasn't JSON.
 * reasoningTokens (part of outputTokens) and cachedTokens (part of inputTokens): for the logs only,
 * absent when the provider doesn't report them.
 */
export type ModelResult = {
  readonly reasoningTokens?: number | null;
  readonly cachedTokens?: number | null;
} & (
  | {
      readonly ok: true;
      readonly json: unknown;
      readonly latencyMs: number;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    }
  | {
      readonly ok: false;
      readonly error: "rejected" | "unavailable" | "invalid_json";
      readonly status: number | null;
      readonly latencyMs: number;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    }
);

export interface ModelProvider {
  /** A standard model ID; `*-contributor` IDs are refused when the provider is built. */
  readonly model: string;
  complete(request: ModelRequest): Promise<ModelResult>;
}

export interface SpendReservation extends Tenant {
  /** The store's day the spend counts against, YYYY-MM-DD. */
  readonly day: string;
  readonly microUsd: number;
}

/** A per-store daily spend cap, in micro-dollars (1,000,000 is US$1). */
export interface SpendLedger {
  /** Atomically adds `microUsd` to the store's day, only if the day stays within `capMicroUsd`. */
  reserve(tenant: Tenant, nowMs: number, microUsd: number, capMicroUsd: number): Promise<SpendReservation | null>;
  /** Replaces a reservation's estimate with what the call actually cost. */
  settle(reservation: SpendReservation, actualMicroUsd: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------

export interface Deps {
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly log: Logger;
  readonly sleep: (ms: number) => Promise<void>;
  readonly hasher: KeyedHasher;
  readonly tenancy: TenancyRepository;
  readonly intake: IntakeRepository;
  readonly jobs: JobRepository;
  readonly outbox: OutboxRepository;
  readonly consoleAuth: ConsoleAuthRepository;
  readonly customers: CustomerRepository;
  readonly doorbell: Doorbell;
  readonly channel: MessagingChannel;
  readonly mediaSource: MediaSource;
  readonly mediaStore: MediaStore;
  readonly jobHandler: JobHandler;
  /** Null until an engine is wired in: a reply with claims then sends the safe reply instead. */
  readonly claimVerifier: ClaimVerifier | null;
  readonly pendientes: Pendientes;
  readonly pendientesBoard: PendientesBoard;
  readonly audioDecoder: AudioDecoder;
  readonly transcriber: Transcriber;
  readonly customerControls: CustomerControlRepository;
  readonly mediaEraser: MediaEraser;
}
