/**
 * The customer gate (#30): runs before the order handler on every customer job and decides, by
 * code from the typed text, whatever a model would read:
 *
 * - ALTO stops the customer: dispatch skips their queued automated rows, and later messages get no
 *   automated answer (one reminder per stop says SEGUIR resumes). SEGUIR resumes. Writing again
 *   does not: the customer said stop, so only the word they were told to use undoes it.
 * - "Quiero hablar con Johan" raises a Pendientes item and sends one fixed line, stopped or not.
 * - An explicit deletion request ("borren mis datos") stops the customer and marks them for the
 *   purge (customer-deletion.ts), which runs once the confirmation is out. It is never inferred.
 * - A new customer's first reply opens with a one-line greeting and ends with ALTO and the privacy
 *   notice, in the same message as the real reply. With nothing to answer yet ("hola"), it asks
 *   what to send, with Horario and Hablar con buttons (their taps are routed by ID, never read by a
 *   model). A control word as the first message (ALTO, deletion, handoff) gets the greeting too.
 *
 * The control word's own message, and for ALTO and deletion every unread message before it, are
 * marked read, so a later reading never acts on them. Direct answers to control words carry
 * CONTROL_REPLY_KIND: the only rows dispatch still sends to a stopped customer.
 */
import { BURST_LOOKBACK_MS } from "../domain/burst";
import {
  CONTROL_REPLY_KIND,
  type ControlWord,
  controlWord,
  DELETION_CONFIRMED,
  handoffLine,
  asksToStop,
  INTRO_BUTTON_IDS,
  introButtons,
  introduceControl,
  introduceReply,
  introduction,
  RESUMED,
  STOP_ASK,
  STOP_BUTTON_ID,
  STOP_BUTTONS,
  STOPPED_REMINDER,
  type StoreVoice,
  stopConfirmed,
} from "../domain/customer-controls";
import { PLACEHOLDER_TTL_MS } from "../domain/outbox";
import { WHAT_TO_ORDER } from "../domain/replies";
import { BurstTooLargeError } from "./errors";
import type {
  Clock,
  Commit,
  CustomerControlRepository,
  CustomerControlState,
  Deps,
  JobHandler,
  JobInput,
  JobOutcome,
  JobRepository,
  Logger,
  OutboxMessage,
  Pendientes,
  ReplyDraft,
  Tenant,
} from "./ports";

/** Control answers and the introduction stay worth sending for an hour, like other replies. */
export const CONTROL_REPLY_TTL_MS = PLACEHOLDER_TTL_MS;

export interface CustomerGateDeps {
  readonly controls: CustomerControlRepository;
  readonly jobs: JobRepository;
  readonly pendientes: Pendientes;
  readonly clock: Clock;
  readonly log: Logger;
  /** The public privacy notice; null when PUBLIC_BASE_URL isn't set (the link is left out). */
  readonly privacyUrl: string | null;
}

/**
 * The one entry point: handles the job itself when it's a control word or the customer is stopped
 * or being deleted; otherwise runs `next` (the order handler) and puts the introduction first if
 * the customer hasn't had it. Without a gate, just `next`.
 */
export async function gateCustomerJob(
  gate: CustomerGateDeps | null | undefined,
  input: JobInput,
  next: () => Promise<JobOutcome>,
): Promise<JobOutcome> {
  if (gate === null || gate === undefined) return next();
  const { lease, job } = input;
  const state = await gate.controls.stateOf(lease);
  // No customer for the leased conversation: the handler fails loudly on its own.
  if (state === null) return next();

  const word = jobControlWord(job);
  const decided = await decide(gate, input, state, word);
  if (decided !== null) {
    gate.log.info("customer_control_handled", {
      businessId: lease.businessId,
      conversationId: lease.conversationId,
      inboundId: job.id,
      outcome: decided.label,
    });
    return decided.outcome;
  }

  const outcome = await next();
  if (state.introducedAtMs !== null) return outcome;
  return withIntroduction(gate, input, state, outcome);
}

/**
 * A typed control word, the first message's Hablar con button, or the "¿Pauso los mensajes?"
 * button (by their IDs, whatever their titles).
 */
function jobControlWord(job: JobInput["job"]): ControlWord | null {
  if (job.kind === "text") return controlWord(job.textBody);
  if (job.kind === "interactive" && job.replyId === INTRO_BUTTON_IDS.handoff) return "handoff";
  if (job.kind === "interactive" && job.replyId === STOP_BUTTON_ID) return "stop";
  return null;
}

/** Any handler behind the gate: the order handler wraps itself; the placeholder is wrapped here. */
export function gatedHandler(gate: CustomerGateDeps, handler: JobHandler): JobHandler {
  return { handle: (input) => gateCustomerJob(gate, input, () => handler.handle(input)) };
}

type Decision = { readonly label: string; readonly outcome: JobOutcome } | null;

async function decide(
  gate: CustomerGateDeps,
  { lease, job }: JobInput,
  state: CustomerControlState,
  word: ControlWord | null,
): Promise<Decision> {
  const nowMs = gate.clock.now();
  const voice = storeVoice(gate, state);
  const readThis = gate.jobs.markReadCommit(lease, job.id, [job.id], nowMs);

  if (state.deletionRequestedAtMs !== null) {
    // Their data is on its way out: nothing more is answered or read.
    return { label: "deletion_pending", outcome: { replies: [], commits: [readThis] } };
  }
  // A control word as the very first message still gets the greeting (#30), in its answer's
  // message. It goes out as a control answer, so dispatch sends it though ALTO or deletion stops.
  const first = state.introducedAtMs === null;
  const answer = (w: ControlWord, body: string): ReplyDraft => control(first ? introduceControl(voice, w, body) : body);
  const introduced = first ? [gate.controls.markIntroducedCommit(lease, state.customerId, nowMs, null)] : [];

  if (word === "delete") {
    return {
      label: "deletion_requested",
      outcome: {
        replies: [answer("delete", DELETION_CONFIRMED)],
        commits: [
          gate.controls.requestDeletionCommit(lease, state.customerId, nowMs),
          await readEverythingUnread(gate, { lease, job }, nowMs),
          ...introduced,
        ],
      },
    };
  }
  if (word === "handoff") {
    // Raised before the save: a retried job can raise it twice, never zero times.
    await gate.pendientes.raise(lease, {
      kind: "customer_handoff",
      conversationId: lease.conversationId,
      customerId: state.customerId,
      inboundId: job.id,
    });
    return {
      label: "handoff",
      outcome: { replies: [answer("handoff", handoffLine(voice))], commits: [readThis, ...introduced] },
    };
  }
  if (state.stoppedAtMs !== null) {
    if (word === "resume") {
      return {
        label: "resumed",
        outcome: { replies: [control(RESUMED)], commits: [readThis, gate.controls.resumeCommit(lease, state.customerId)] },
      };
    }
    if (word === "stop" || state.stopRemindedAtMs !== null) {
      return { label: "stopped_silent", outcome: { replies: [], commits: [readThis] } };
    }
    return {
      label: "stopped_reminded",
      outcome: {
        replies: [control(STOPPED_REMINDER)],
        commits: [readThis, gate.controls.markStopRemindedCommit(lease, state.customerId, nowMs)],
      },
    };
  }
  if (word === null && job.kind === "text" && asksToStop(job.textBody)) {
    // Stop in other words: asked, with one tap that is the real ALTO. Nothing stops yet.
    return {
      label: "stop_asked",
      outcome: {
        replies: [{ ...answer("stop", STOP_ASK), buttons: STOP_BUTTONS }],
        commits: [readThis, ...introduced],
      },
    };
  }
  if (word === "stop") {
    return {
      label: "stopped",
      outcome: {
        replies: [answer("stop", stopConfirmed(voice))],
        commits: [
          gate.controls.stopCommit(lease, state.customerId, nowMs),
          await readEverythingUnread(gate, { lease, job }, nowMs),
          ...introduced,
        ],
      },
    };
  }
  // SEGUIR while not stopped, and everything else, goes to the order handler.
  return null;
}

function withIntroduction(
  gate: CustomerGateDeps,
  { lease, job, isNewestOfBurst }: JobInput,
  state: CustomerControlState,
  outcome: JobOutcome,
): JobOutcome {
  const voice = storeVoice(gate, state);
  const [first, ...rest] = outcome.replies;
  if (first === undefined) {
    // An earlier message of a burst: the burst's later job answers, and carries the introduction.
    if (!isNewestOfBurst) return outcome;
    return {
      replies: [{ body: introduction(voice), ttlMs: CONTROL_REPLY_TTL_MS, buttons: introButtons(voice) }],
      commits: [...(outcome.commits ?? []), gate.controls.markIntroducedCommit(lease, state.customerId, gate.clock.now(), null)],
    };
  }
  // The job's replies are written together or not at all: when they close the burst, the
  // introduction is remembered only if they are written.
  const closes = outcome.replies.some((reply) => reply.closesBurst === true);
  return {
    replies: [introduced(voice, first), ...rest],
    commits: [
      ...(outcome.commits ?? []),
      gate.controls.markIntroducedCommit(lease, state.customerId, gate.clock.now(), closes ? job.id : null),
    ],
  };
}

/**
 * The first real reply with the introduction in the same message. Its claims, kind and burst
 * flag stay as they were; "¿Qué te mando?" with no order becomes the welcome, with its buttons.
 */
function introduced(voice: StoreVoice, reply: ReplyDraft): ReplyDraft {
  if (reply.body === WHAT_TO_ORDER && (reply.buttons ?? []).length === 0) {
    return { ...reply, body: introduction(voice), buttons: introButtons(voice) };
  }
  return { ...reply, body: introduceReply(voice, reply.body) };
}

/** ALTO and deletion: the control message and every unread one before it, so none is acted on later. */
async function readEverythingUnread(gate: CustomerGateDeps, { lease, job }: Pick<JobInput, "lease" | "job">, nowMs: number): Promise<Commit> {
  try {
    const unread = await gate.jobs.unreadBurst(lease, job.id, job.receivedAtMs - BURST_LOOKBACK_MS);
    const ids = new Set([job.id, ...unread.map((message) => message.id)]);
    return gate.jobs.markReadCommit(lease, job.id, [...ids], nowMs);
  } catch (error) {
    if (!(error instanceof BurstTooLargeError)) throw error;
    return gate.jobs.markReadCommit(lease, job.id, [job.id], nowMs);
  }
}

function storeVoice(gate: CustomerGateDeps, state: CustomerControlState): StoreVoice {
  return { storeName: state.storeName, ownerName: state.ownerName, privacyUrl: gate.privacyUrl };
}

function control(body: string): ReplyDraft {
  return { body, ttlMs: CONTROL_REPLY_TTL_MS, kind: CONTROL_REPLY_KIND };
}

/**
 * Dispatch's check: a row for a customer who typed ALTO (or asked for deletion) goes out only if
 * it is a direct answer to a control word.
 */
export async function isStoppedRecipient(deps: Pick<Deps, "customerControls">, tenant: Tenant, message: OutboxMessage): Promise<boolean> {
  if (message.conversationId === null || message.kind === CONTROL_REPLY_KIND) return false;
  return deps.customerControls.isStopped(tenant, message.conversationId);
}
