/**
 * The customer's side of a conversation: turns a job into engine calls and the commits and replies
 * that complete it. The store comes from the lease and the customer from the leased conversation;
 * no ID is ever taken from message text, a button or the model.
 *
 * - A readback answer (a button tap, or "confirmar", "corregir", "cancelar" typed alone) is its own
 *   step: it goes to `Engine.onCustomerAction` at its own job, so it sees every earlier save.
 * - Other messages are read together as a burst, at the last job before an answer or at the burst's
 *   newest job. Earlier jobs complete with no reply. The reading's job saves which messages it used
 *   in the same batch as the engine's commits: a crash before the save leaves them unread for the
 *   retry, and a saved reading can't use them again.
 * - Delivery (#29): the customer's saved place goes to the engine in the context, the same-place
 *   question's Sí / Otro lugar taps are their own step like readback answers, and a confirmed
 *   delivery order's place is saved in the same batch as the confirmation.
 */
import { BURST_LOOKBACK_MS, parseReadbackButton, type ReadbackAnswer, readbackOperationKey, typedReadbackWord } from "../domain/burst";
import type { CustomerAction } from "../domain/contract/actions";
import type { BurstReading } from "../domain/contract/observation";
import type { EngineOutcome, OrderView, QuestionCode } from "../domain/contract/outcomes";
import { couldNotProcess, RECEIVED_PLACEHOLDER } from "../domain/copy";
import { ANSWER_NEW_READBACK, WHAT_TO_CORRECT } from "../domain/order-copy";
import { FAILURE_REPLY_TTL_MS, PLACEHOLDER_TTL_MS } from "../domain/outbox";
import { attemptsExhausted } from "../domain/processing";
import type { SavedPlace } from "../domain/place";
import { actionFromButtonId, safeReply, unansweredCount } from "../domain/replies";
import { type CustomerGateDeps, gateCustomerJob } from "./customer-gate";
import type { CustomerContext, Engine, EngineResult, LineMatch } from "./engine";
import { BurstMediaUnreadableError } from "./errors";
import { CUSTOMER_REPLY_TTL_MS, replyForOutcome } from "./replies";
import type {
  Clock,
  Commit,
  ConversationCustomer,
  CustomerPlaceRepository,
  CustomerRepository,
  Job,
  JobHandler,
  JobInput,
  JobOutcome,
  JobRepository,
  Lease,
  Logger,
  Pendientes,
  ReplyDraft,
} from "./ports";

/** A reply about an order is worth sending for an hour, like the placeholder. */
export const ORDER_REPLY_TTL_MS = CUSTOMER_REPLY_TTL_MS;

/**
 * The customer context with the name and whether it was asked, so the engine asks once, at a point
 * that doesn't block the order (#5 gap d). Local until the contract's CustomerContext carries them.
 */
export type CustomerContextWithName = CustomerContext & {
  readonly customerName: string | null;
  readonly customerNameAsked: boolean;
  /**
   * The customer's saved delivery place, from our records (#29, proposed as
   * CustomerContext.savedPlace). The engine may offer it as "same_place"; it never applies it
   * without the customer's yes.
   */
  readonly savedPlace: SavedPlace | null;
};

/** The same-place question's answers, tapped. */
type PlaceAction = Extract<CustomerAction, { type: "accept_saved_place" | "decline_saved_place" }>;

/** What perception is given: the burst's messages, oldest first (content untrusted), and who asks. */
export interface BurstReaderInput {
  readonly lease: Lease;
  readonly messages: readonly Job[];
  /** The engine's context for this customer; perception's context is read with it (gap a). */
  readonly context: CustomerContextWithName;
}

/** A validated reading, with the catalog matches code found inside the store's scope. */
export interface BurstRead {
  readonly reading: BurstReading;
  readonly matches: readonly LineMatch[];
  /** The question the engine had asked last, as perception was told; null when none. */
  readonly pendingQuestion: QuestionCode | null;
}

/**
 * Perception's seam (`createOrderReading` in ./order-reading.ts). Throws ReadingFailedError when
 * the burst can't be read; without a reader, a burst gets the placeholder.
 */
export interface BurstReader {
  read(input: BurstReaderInput): Promise<BurstRead>;
}

export interface OrderHandlerDeps {
  readonly engine: Engine;
  readonly jobs: JobRepository;
  readonly customers: CustomerRepository;
  readonly clock: Clock;
  readonly log: Logger;
  /** Where a reply blocked by the claim check's first pass is raised. */
  readonly pendientes: Pendientes;
  readonly reader?: BurstReader | null;
  /** ALTO, SEGUIR, handoff, deletion and the first message (#30); none in tests that don't need it. */
  readonly gate?: CustomerGateDeps | null;
  /** Saved delivery places (#29). Without it, no place is offered or saved. */
  readonly places?: CustomerPlaceRepository | null;
}

const ACTION_TYPES = {
  confirm: "confirm_order",
  correct: "correct_order",
  cancel: "cancel_order",
} as const satisfies Record<ReadbackAnswer["word"], CustomerAction["type"]>;

export function createOrderHandler(deps: OrderHandlerDeps): JobHandler {
  return { handle: (input) => gateCustomerJob(deps.gate, input, () => handleJob(deps, input)) };
}

async function handleJob(deps: OrderHandlerDeps, { lease, job, isNewestOfBurst }: JobInput): Promise<JobOutcome> {
  const customer = await deps.customers.ofConversation(lease);
  // Every conversation has a customer (0004): missing means the lease is for another store's ID.
  if (customer === null) throw new Error("no customer for the leased conversation");
  const savedPlace = (await deps.places?.latest(lease, customer.id)) ?? null;

  const placeTap = placeAction(job);
  if (placeTap !== null) return handlePlaceTap(deps, lease, job, customer, savedPlace, placeTap);
  const answer = readbackAnswer(job, customer);
  if (answer === "unseen_readback") return handleUnseenReadback(deps, lease, job);
  if (answer !== null) return handleAnswer(deps, lease, job, customer, savedPlace, answer);

  if (!isNewestOfBurst) {
    // Read now only when the next message is an answer, so the answer sees this reading saved.
    const next = await deps.jobs.nextOpenJob(lease, job.id);
    if (next !== null && readbackAnswer(next, customer) === null && placeAction(next) === null) return { replies: [] };
  }
  return handleBurst(deps, lease, job, customer, savedPlace, isNewestOfBurst);
}

/** A tap on Sí or Otro lugar under "¿Te lo llevamos al mismo lugar de siempre?". Typed, it's read. */
function placeAction(job: Job): PlaceAction | null {
  if (job.kind !== "interactive" || job.replyId === null) return null;
  const action = actionFromButtonId(job.replyId);
  return action?.type === "accept_saved_place" || action?.type === "decline_saved_place" ? action : null;
}

/**
 * The same-place answer goes to the engine at its own job, keyed by the button ID: a second tap is
 * a duplicate. The saved place it names is resolved by the engine against the context's only.
 */
async function handlePlaceTap(
  deps: OrderHandlerDeps,
  lease: Lease,
  job: Job,
  customer: ConversationCustomer,
  savedPlace: SavedPlace | null,
  action: PlaceAction,
): Promise<JobOutcome> {
  const nowMs = deps.clock.now();
  const result = await deps.engine.onCustomerAction(context(lease, job, customer, savedPlace, nowMs), {
    operationKey: job.replyId!,
    actor: { type: "customer", customerId: customer.id },
    action,
  });
  deps.log.info("customer_action_handled", {
    businessId: lease.businessId,
    conversationId: lease.conversationId,
    inboundId: job.id,
    outcome: result.outcome.type,
  });
  return complete(deps, lease, job, customer, savedPlace, [job], result, null, false, nowMs);
}

/**
 * A tap on a readback button (it names its version), or its word typed alone while a readback is
 * open. A typed word answers the last readback only if it arrived after that readback was queued:
 * one sent earlier answered a version the customer saw before, which may have changed since, so
 * it is `unseen_readback` and confirms nothing.
 */
function readbackAnswer(job: Job, customer: ConversationCustomer): ReadbackAnswer | "unseen_readback" | null {
  if (job.kind === "interactive") {
    const tapped = parseReadbackButton(job.replyId);
    if (tapped !== null) return tapped;
  }
  if (job.kind !== "text" || customer.lastReadback === null) return null;
  const word = typedReadbackWord(job.textBody);
  if (word === null) return null;
  const { orderId, version, queuedAtMs } = customer.lastReadback;
  if (job.receivedAtMs <= queuedAtMs) return "unseen_readback";
  return { word, orderId, version };
}

/**
 * A typed answer that crossed a newer readback in flight. Nothing is decided: the customer is
 * asked to answer the readback just queued, which goes out before this reply.
 */
function handleUnseenReadback(deps: OrderHandlerDeps, lease: Lease, job: Job): JobOutcome {
  deps.log.info("customer_action_handled", {
    businessId: lease.businessId,
    conversationId: lease.conversationId,
    inboundId: job.id,
    outcome: "unseen_readback",
  });
  return {
    replies: [{ body: ANSWER_NEW_READBACK, ttlMs: ORDER_REPLY_TTL_MS }],
    commits: [deps.jobs.markReadCommit(lease, job.id, [job.id], deps.clock.now())],
  };
}

async function handleAnswer(
  deps: OrderHandlerDeps,
  lease: Lease,
  job: Job,
  customer: ConversationCustomer,
  savedPlace: SavedPlace | null,
  answer: ReadbackAnswer,
): Promise<JobOutcome> {
  const nowMs = deps.clock.now();
  // The button and the typed word share the key, so whichever comes second is a duplicate.
  const result = await deps.engine.onCustomerAction(context(lease, job, customer, savedPlace, nowMs), {
    operationKey: readbackOperationKey(answer),
    actor: { type: "customer", customerId: customer.id },
    action: { type: ACTION_TYPES[answer.word], orderId: answer.orderId, version: answer.version },
  });
  deps.log.info("customer_action_handled", {
    businessId: lease.businessId,
    conversationId: lease.conversationId,
    inboundId: job.id,
    outcome: result.outcome.type,
  });
  // The answer's own reply goes out even if more messages follow: it is never a burst-closing one.
  return complete(deps, lease, job, customer, savedPlace, [job], result, answer.word, false, nowMs);
}

async function handleBurst(
  deps: OrderHandlerDeps,
  lease: Lease,
  job: Job,
  customer: ConversationCustomer,
  savedPlace: SavedPlace | null,
  closesBurst: boolean,
): Promise<JobOutcome> {
  const messages = await deps.jobs.unreadBurst(lease, job.id, job.receivedAtMs - BURST_LOOKBACK_MS);
  if (messages.length === 0) return { replies: [] };
  const nowMs = deps.clock.now();

  if (deps.reader === undefined || deps.reader === null) {
    // No perception yet: acknowledge, and count the messages as read so they aren't read twice.
    return {
      replies: [{ body: RECEIVED_PLACEHOLDER, ttlMs: PLACEHOLDER_TTL_MS, closesBurst }],
      commits: [deps.jobs.markReadCommit(lease, job.id, messages.map((message) => message.id), nowMs)],
    };
  }

  const customerContext = context(lease, job, customer, savedPlace, nowMs);
  let read: BurstRead;
  try {
    read = await deps.reader.read({ lease, messages, context: customerContext });
  } catch (error) {
    if (!(error instanceof BurstMediaUnreadableError) || !givesUpOnMedia(job, error)) throw error;
    return unreadableMediaOutcome(deps, lease, job, error, nowMs);
  }
  const { reading, matches, pendingQuestion } = read;
  const result = await deps.engine.onBurst(customerContext, reading, matches);
  deps.log.info("burst_read", {
    businessId: lease.businessId,
    conversationId: lease.conversationId,
    inboundId: job.id,
    count: messages.length,
    outcome: result.outcome.type,
  });
  const name = customer.name === null ? givenName(reading, pendingQuestion) : null;
  const nameCommits = name === null ? [] : [deps.customers.saveNameCommit(lease, customer.id, name, nowMs)];
  return complete(deps, lease, job, customer, savedPlace, messages, result, null, closesBurst, nowMs, nameCommits);
}

/**
 * A photo or voice note we couldn't read is retried like any failed reading, except when no retry
 * can help: on the job's last attempt, or when every failure is permanent (a broken or over-long
 * voice note, a photo format the model doesn't take), so the customer doesn't wait for retries.
 */
function givesUpOnMedia(job: Job, error: BurstMediaUnreadableError): boolean {
  return attemptsExhausted(job.attempts + 1) || error.failures.every((failure) => failure.permanent);
}

/**
 * Giving up on unreadable media: the customer is asked to send it again, once per kind, and only
 * those messages count as read, so the resent one isn't read beside the old one. The rest of the
 * burst stays unread and is read with the customer's next message. Nothing goes to the engine.
 */
function unreadableMediaOutcome(
  deps: OrderHandlerDeps,
  lease: Lease,
  job: Job,
  error: BurstMediaUnreadableError,
  nowMs: number,
): JobOutcome {
  const kinds = [...new Set(error.failures.map((failure) => failure.kind))];
  deps.log.info("burst_media_given_up", {
    businessId: lease.businessId,
    conversationId: lease.conversationId,
    inboundId: job.id,
    count: error.failures.length,
  });
  return {
    // Never withheld as a burst-closing reply: a later reading won't see these messages again.
    replies: kinds.map((kind) => ({ body: couldNotProcess(kind), ttlMs: FAILURE_REPLY_TTL_MS })),
    commits: [deps.jobs.markReadCommit(lease, job.id, error.failures.map((failure) => failure.jobId), nowMs)],
  };
}

/**
 * The name the customer gave in this burst: said outright ("soy Carla"), or the answer to the name
 * question asked last ("Carla"). Saved through our own records (gap d), first answer wins.
 */
function givenName(reading: BurstReading, pendingQuestion: QuestionCode | null): string | null {
  for (const observation of reading.observations) {
    if (observation.kind === "customer_name") return observation.name;
  }
  if (pendingQuestion !== "customer_name") return null;
  for (const observation of reading.observations) {
    if (observation.kind === "clarification") return observation.answer;
  }
  return null;
}

/**
 * Replies and commits for the job: what was read, the engine's facts, and the channel records. The
 * reply comes from the replies templates after the claim check's first pass.
 */
async function complete(
  deps: OrderHandlerDeps,
  lease: Lease,
  job: Job,
  customer: ConversationCustomer,
  savedPlace: SavedPlace | null,
  read: readonly Job[],
  result: EngineResult,
  answered: ReadbackAnswer["word"] | null,
  closesBurst: boolean,
  nowMs: number,
  extra: readonly Commit[] = [],
): Promise<JobOutcome> {
  const replies = await repliesFor(deps, lease, customer, savedPlace, result.outcome, answered, closesBurst);
  const commits: Commit[] = [
    deps.jobs.markReadCommit(lease, job.id, read.map((message) => message.id), nowMs),
    ...result.commits,
    ...extra,
    ...placeCommits(deps, lease, customer, result.outcome, nowMs),
  ];
  // What the reply showed is remembered only if it went out as rendered, not as the safe reply.
  const shownAsRendered = replies.length > 0 && replies[0]!.body !== safeReply().body;
  if (shownAsRendered) {
    commits.push(...channelCommits(deps, lease, job, customer, result.outcome, closesBurst, nowMs));
    await raiseUnanswered(deps, lease, job, customer, result.outcome);
  }
  // Notices for other customers (staff actions) don't arise from a customer's own message here.
  if (result.notices.length > 0) {
    deps.log.warn("customer_notices_dropped", { businessId: lease.businessId, count: result.notices.length });
  }
  return { replies, commits };
}

/**
 * The reply to the outcome. A readback answer's reply never closes the burst: it goes out even if
 * more messages follow. "Corregir" leaves the order as it is, so the engine has nothing to say and
 * the customer is asked what to change.
 */
async function repliesFor(
  deps: OrderHandlerDeps,
  lease: Lease,
  customer: ConversationCustomer,
  savedPlace: SavedPlace | null,
  outcome: EngineOutcome,
  answered: ReadbackAnswer["word"] | null,
  closesBurst: boolean,
): Promise<ReplyDraft[]> {
  if (outcome.type === "nothing" && answered === "correct") {
    return [{ body: WHAT_TO_CORRECT, ttlMs: ORDER_REPLY_TTL_MS }];
  }
  const drafts = await replyForOutcome(deps, { ...lease, customerId: customer.id, savedPlace }, outcome);
  return drafts.map(({ closesBurst: _closes, ...draft }) => (closesBurst ? { ...draft, closesBurst } : draft));
}

/**
 * A confirmed delivery order's place is saved for next time (#29): a new place as the customer gave
 * it, or a saved place marked used again. Only on the confirmation itself (a duplicate saves
 * nothing), and only for delivery: a pickup or a cancelled order keeps no place.
 */
function placeCommits(
  deps: OrderHandlerDeps,
  lease: Lease,
  customer: ConversationCustomer,
  outcome: EngineOutcome,
  nowMs: number,
): Commit[] {
  if (deps.places == null || outcome.type !== "order_confirmed") return [];
  const fulfillment = outcome.order.fulfillment;
  if (fulfillment === null || fulfillment.mode !== "delivery") return [];
  if (fulfillment.placeId !== null) return [deps.places.markUsedCommit(lease, customer.id, fulfillment.placeId, nowMs)];
  const pin = fulfillment.pin ?? null;
  if (fulfillment.placeText === null && pin === null) return [];
  return [deps.places.saveForOrderCommit(lease, customer.id, outcome.order.orderId, { placeText: fulfillment.placeText, pin }, nowMs)];
}

/**
 * The order version a reply asks the customer to confirm, so a typed "confirmar" answers it: a
 * readback, or a refused tap or status answer for an order waiting on Confirmar.
 */
function readbackShown(outcome: EngineOutcome): OrderView | null {
  switch (outcome.type) {
    case "readback":
    case "order_changed":
    case "order_status":
    case "rejected":
      return outcome.order !== null && outcome.order.state === "por_confirmar" ? outcome.order : null;
    default:
      return null;
  }
}

/**
 * "Te lo anoto y te confirmo" is only honest if someone sees it: each answer that promised one
 * raises a Pendientes item. Raised before the save, like a handoff: a retried job can raise it
 * twice, never zero times.
 */
async function raiseUnanswered(
  deps: OrderHandlerDeps,
  lease: Lease,
  job: Job,
  customer: ConversationCustomer,
  outcome: EngineOutcome,
): Promise<void> {
  const unknown = unansweredCount(outcome);
  if (unknown === 0) return;
  const topic = outcome.type === "answer" ? outcome.topic : "store_hours";
  await deps.pendientes.raise(lease, {
    kind: "customer_question",
    conversationId: lease.conversationId,
    customerId: customer.id,
    inboundId: job.id,
    topic,
    unknown,
  });
}

/** What the reply shows, remembered with it: the readback version and that the name was asked. */
function channelCommits(
  deps: OrderHandlerDeps,
  lease: Lease,
  job: Job,
  customer: ConversationCustomer,
  outcome: EngineOutcome,
  closesBurst: boolean,
  nowMs: number,
): Commit[] {
  const commits: Commit[] = [];
  const shown = readbackShown(outcome);
  if (shown !== null) {
    // Stamped now, not when the reading began: a word typed while the model read this version
    // answered the one before it, so it must not count as an answer to this one.
    commits.push(
      deps.customers.rememberReadbackCommit(
        lease,
        { orderId: shown.orderId, version: shown.version },
        deps.clock.now(),
        closesBurst ? job.id : null,
      ),
    );
  }
  if (outcome.type === "ask" && outcome.question === "customer_name" && customer.nameAskedAtMs === null) {
    // Only when the reply with the question is written: a withheld question was never asked.
    commits.push(deps.customers.markNameAskedCommit(lease, customer.id, nowMs, closesBurst ? job.id : null));
  }
  return commits;
}

function context(
  lease: Lease,
  job: Job,
  customer: ConversationCustomer,
  savedPlace: SavedPlace | null,
  nowMs: number,
): CustomerContextWithName {
  return {
    businessId: lease.businessId,
    conversationId: lease.conversationId,
    customerId: customer.id,
    jobId: job.id,
    nowMs,
    customerName: customer.name,
    customerNameAsked: customer.nameAskedAtMs !== null,
    savedPlace,
  };
}
