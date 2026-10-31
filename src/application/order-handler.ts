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
 */
import { BURST_LOOKBACK_MS, parseReadbackButton, type ReadbackAnswer, readbackOperationKey, typedReadbackWord } from "../domain/burst";
import type { CustomerAction } from "../domain/contract/actions";
import type { BurstReading } from "../domain/contract/observation";
import type { EngineOutcome } from "../domain/contract/outcomes";
import { RECEIVED_PLACEHOLDER } from "../domain/copy";
import { ANSWER_NEW_READBACK, readbackShown, renderOrderOutcome } from "../domain/order-copy";
import { PLACEHOLDER_TTL_MS } from "../domain/outbox";
import type { CustomerContext, Engine, EngineResult } from "./engine";
import type {
  Clock,
  Commit,
  ConversationCustomer,
  CustomerRepository,
  Job,
  JobHandler,
  JobInput,
  JobOutcome,
  JobRepository,
  Lease,
  Logger,
  ReplyDraft,
} from "./ports";

/** A reply about an order is worth sending for an hour, like the placeholder. */
export const ORDER_REPLY_TTL_MS = PLACEHOLDER_TTL_MS;

/**
 * The customer context with the name and whether it was asked, so the engine asks once, at a point
 * that doesn't block the order (#5 gap d). Local until the contract's CustomerContext carries them.
 */
export type CustomerContextWithName = CustomerContext & {
  readonly customerName: string | null;
  readonly customerNameAsked: boolean;
};

/** What perception (#17) is given: the burst's messages, oldest first. Their content is untrusted. */
export interface BurstReaderInput {
  readonly lease: Lease;
  readonly messages: readonly Job[];
}

/** Perception's seam. Not built yet: without a reader, a burst gets the placeholder. */
export interface BurstReader {
  read(input: BurstReaderInput): Promise<BurstReading>;
}

export interface OrderHandlerDeps {
  readonly engine: Engine;
  readonly jobs: JobRepository;
  readonly customers: CustomerRepository;
  readonly clock: Clock;
  readonly log: Logger;
  readonly reader?: BurstReader | null;
}

const ACTION_TYPES = {
  confirm: "confirm_order",
  correct: "correct_order",
  cancel: "cancel_order",
} as const satisfies Record<ReadbackAnswer["word"], CustomerAction["type"]>;

export function createOrderHandler(deps: OrderHandlerDeps): JobHandler {
  return { handle: (input) => handleJob(deps, input) };
}

async function handleJob(deps: OrderHandlerDeps, { lease, job, isNewestOfBurst }: JobInput): Promise<JobOutcome> {
  const customer = await deps.customers.ofConversation(lease);
  // Every conversation has a customer (0004): missing means the lease is for another store's ID.
  if (customer === null) throw new Error("no customer for the leased conversation");

  const answer = readbackAnswer(job, customer);
  if (answer === "unseen_readback") return handleUnseenReadback(deps, lease, job);
  if (answer !== null) return handleAnswer(deps, lease, job, customer, answer);

  if (!isNewestOfBurst) {
    // Read now only when the next message is an answer, so the answer sees this reading saved.
    const next = await deps.jobs.nextOpenJob(lease, job.id);
    if (next !== null && readbackAnswer(next, customer) === null) return { replies: [] };
  }
  return handleBurst(deps, lease, job, customer, isNewestOfBurst);
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
  answer: ReadbackAnswer,
): Promise<JobOutcome> {
  const nowMs = deps.clock.now();
  // The button and the typed word share the key, so whichever comes second is a duplicate.
  const result = await deps.engine.onCustomerAction(context(lease, job, customer, nowMs), {
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
  return complete(deps, lease, job, customer, [job], result, answer.word, false, nowMs);
}

async function handleBurst(
  deps: OrderHandlerDeps,
  lease: Lease,
  job: Job,
  customer: ConversationCustomer,
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

  const reading = await deps.reader.read({ lease, messages });
  // Catalog matches come from perception's side (#17); none on this path.
  const result = await deps.engine.onBurst(context(lease, job, customer, nowMs), reading, []);
  deps.log.info("burst_read", {
    businessId: lease.businessId,
    conversationId: lease.conversationId,
    inboundId: job.id,
    count: messages.length,
    outcome: result.outcome.type,
  });
  const named = reading.observations.find((observation) => observation.kind === "customer_name");
  const nameCommits =
    named?.kind === "customer_name" && customer.name === null
      ? [deps.customers.saveNameCommit(lease, customer.id, named.name, nowMs)]
      : [];
  return complete(deps, lease, job, customer, messages, result, null, closesBurst, nowMs, nameCommits);
}

/** Replies and commits for the job: what was read, the engine's facts, and the channel records. */
function complete(
  deps: OrderHandlerDeps,
  lease: Lease,
  job: Job,
  customer: ConversationCustomer,
  read: readonly Job[],
  result: EngineResult,
  answered: ReadbackAnswer["word"] | null,
  closesBurst: boolean,
  nowMs: number,
  extra: readonly Commit[] = [],
): JobOutcome {
  const body = renderOrderOutcome(result.outcome, answered);
  const commits: Commit[] = [
    deps.jobs.markReadCommit(lease, job.id, read.map((message) => message.id), nowMs),
    ...result.commits,
    ...extra,
  ];
  if (body !== null) {
    commits.push(...channelCommits(deps, lease, job, customer, result.outcome, closesBurst, nowMs));
  }
  const replies: ReplyDraft[] = body === null ? [] : [{ body, ttlMs: ORDER_REPLY_TTL_MS, closesBurst }];
  // Notices for other customers (staff actions) don't arise from a customer's own message here.
  if (result.notices.length > 0) {
    deps.log.warn("customer_notices_dropped", { businessId: lease.businessId, count: result.notices.length });
  }
  return { replies, commits };
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
    commits.push(
      deps.customers.rememberReadbackCommit(
        lease,
        { orderId: shown.orderId, version: shown.version },
        nowMs,
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

function context(lease: Lease, job: Job, customer: ConversationCustomer, nowMs: number): CustomerContextWithName {
  return {
    businessId: lease.businessId,
    conversationId: lease.conversationId,
    customerId: customer.id,
    jobId: job.id,
    nowMs,
    customerName: customer.name,
    customerNameAsked: customer.nameAskedAtMs !== null,
  };
}
