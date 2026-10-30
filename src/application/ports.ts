/**
 * What the application layer needs from the outside world. Infrastructure and integrations
 * implement these; tests swap in fakes for providers and use the real D1 repositories.
 */
import type { ProviderStatus } from "../domain/outbox";
import type { MessageKind } from "../domain/processing";

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
    | "status"]?: string | number | boolean;
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

export interface MessagingChannel {
  /** False when credentials are missing: nothing is sent and the outbox keeps the message. */
  readonly configured: boolean;
  /** The longest text body the channel accepts, in UTF-16 code units. */
  readonly maxTextChars: number;
  sendText(message: OutgoingText): Promise<SendResult>;
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

export interface MemberMessageInput {
  readonly channelAccountId: string;
  readonly userId: string;
  readonly event: InboundMessageEvent;
  readonly receivedAtMs: number;
  /** The provider timestamp clamped around receivedAtMs; used only for ordering. */
  readonly orderTsS: number;
  /** Used only if the conversation, message or media asset doesn't exist yet. */
  readonly newConversationId: string;
  readonly newInboundId: string;
  readonly newMediaAssetId: string;
  readonly hourlyCap: number;
}

/** not_member: the membership stopped being active before the write; nothing was stored. */
export type MemberMessageOutcome = "new" | "duplicate" | "capped" | "not_member";

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
   * One batch: conversation, media asset, the message with its pending job, last-inbound time.
   * Every write in it checks admission itself: the membership is still active, the message isn't
   * stored yet, the conversation is under its hourly cap. A message that isn't admitted leaves no
   * row at all (no media asset either). conversationId is null only for not_member.
   */
  recordMemberMessage(
    tenant: Tenant,
    input: MemberMessageInput,
  ): Promise<{ readonly conversationId: string | null; readonly outcome: MemberMessageOutcome }>;
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
  /** The member's phone, or null when the membership is no longer active. */
  memberPhone(tenant: Tenant, conversationId: string): Promise<string | null>;
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
  /** Sweep housekeeping: expiries, stale sends, stopped groups, closed windows, old notices, retention. */
  maintain(nowMs: number): Promise<OutboxMaintenance>;
}

/** A logged-in console member, from a session. The store comes from here, never from the request. */
export interface ConsoleMember extends Tenant {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: "owner" | "staff";
  readonly canApproveFiado: boolean;
}

export interface InvitePreview {
  readonly storeName: string;
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
  acceptInvite(
    tokenHash: string,
    session: { readonly id: string; readonly tokenHash: string; readonly nowMs: number; readonly expiresAtMs: number },
  ): Promise<ConsoleMember | null>;
  /** The session's member while the session is open and the membership active; checked on every request. */
  findSession(tokenHash: string, nowMs: number): Promise<ConsoleMember | null>;
  /** Ends every open session of the member. Returns how many were open. */
  revokeSessions(tenant: Tenant, userId: string, nowMs: number): Promise<number>;
  listMembers(tenant: Tenant): Promise<MemberSummary[]>;
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
  readonly doorbell: Doorbell;
  readonly channel: MessagingChannel;
  readonly mediaSource: MediaSource;
  readonly mediaStore: MediaStore;
  readonly jobHandler: JobHandler;
}
