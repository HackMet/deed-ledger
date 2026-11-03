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
 * - The first message's Horario button is its own step too, routed by its ID: the store-hours
 *   question goes to the engine as if read, with no model call.
 *
 * Conversation rules (Oct 31), decided here by code:
 * - Never silent: a job that closes a burst and would send nothing sends the current step again.
 * - "1", "2" or "3" typed alone right after a message with buttons is that button.
 * - A typed yes ("sí", "dale", "ok", "👍"…) under a readback the customer was last shown, with its
 *   buttons, is Confirmar for that version, sharing the button's operation key.
 * - A greeting, a thanks or an "ok" alone isn't read by the model: the engine gets an empty reading
 *   and restates where the order stands; "¡Buenas, Carla! 👋" or "¡A la orden! 🙌" goes with it.
 * - A name is saved only when it can be one (customer-name.ts), and the engine is told it in the
 *   context, so a Confirmar held for the name completes with it.
 * - A question answered beside the order's next step is said first, in the same message.
 */
import { BURST_LOOKBACK_MS, parseReadbackButton, type ReadbackAnswer, readbackOperationKey, typedReadbackWord } from "../domain/burst";
import { nameFrom } from "../domain/customer-name";
import { foldShortText, isTypedYes, type SmallTalk, smallTalk, typedButtonNumber } from "../domain/small-talk";
import type { CustomerAction } from "../domain/contract/actions";
import type { BurstReading, Observation } from "../domain/contract/observation";
import type { EngineOutcome, OrderView, QuestionCode } from "../domain/contract/outcomes";
import { couldNotProcess, RECEIVED_PLACEHOLDER } from "../domain/copy";
import { ANSWER_NEW_READBACK, WHAT_TO_CORRECT } from "../domain/order-copy";
import { FAILURE_REPLY_TTL_MS, PLACEHOLDER_TTL_MS } from "../domain/outbox";
import { attemptsExhausted } from "../domain/processing";
import type { SavedPlace } from "../domain/place";
import type { TurnPlan } from "../domain/planner/types";
import { INTRO_BUTTON_IDS } from "../domain/customer-controls";
import {
  actionFromButtonId,
  COPY,
  confirmNudge,
  decisionKey,
  greetingLine,
  questionText,
  type RenderedReply,
  safeReply,
  unansweredCount,
  WHAT_TO_ORDER,
} from "../domain/replies";
import { type CustomerGateDeps, gateCustomerJob } from "./customer-gate";
import type { AnsweredQuestion, CustomerContext, Engine, EngineResult, LineMatch } from "./engine";
import { BurstMediaUnreadableError, describeError } from "./errors";
import { type AliasBook, aliasProposalCommits } from "./learned-aliases";
import { readingSourceOf } from "./order-reading";
import { plannerSourceOf } from "./planner/source";
import { CUSTOMER_REPLY_TTL_MS, type ReplyContext, replyForOutcome } from "./replies";
import type {
  ButtonsShown,
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
  /** The planner's validated plan for this burst (D-45); absent: the classic path. */
  readonly plan?: TurnPlan | null;
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
  /** The last message's buttons, for typed numbers and a typed yes. Without it, both are read. */
  readonly buttonsShown?: ButtonsShown | null;
  /**
   * Planner path (D-49): where a confirmed order's planner picks propose learned aliases. Without
   * it (classic), nothing is proposed.
   */
  readonly aliases?: AliasBook | null;
}

const ACTION_TYPES = {
  confirm: "confirm_order",
  correct: "correct_order",
  cancel: "cancel_order",
} as const satisfies Record<ReadbackAnswer["word"], CustomerAction["type"]>;

export function createOrderHandler(deps: OrderHandlerDeps): JobHandler {
  return {
    handle: async (input) => {
      // A number typed after buttons is that button, before anything else looks at it (the
      // gate routes the welcome's Hablar con by its ID).
      const resolved = { ...input, job: await asTappedNumber(deps, input.lease, input.job) };
      return gateCustomerJob(deps.gate, resolved, () => neverSilent(deps, resolved, () => handleJob(deps, resolved)));
    },
  };
}

/** A readback answer: the word, the version, and whether it was a typed yes ("dale", "👍"). */
type Answer = ReadbackAnswer & { readonly typedYes?: boolean };

/** What the handler knows about the store and the customer for one job, read once. */
interface JobFacts {
  readonly customer: ConversationCustomer;
  readonly savedPlace: SavedPlace | null;
  /** The store owner's first name, for the handoff line. */
  readonly ownerName: string | null;
  /** The customer already had the first message: a greeting gets its own line. */
  readonly introduced: boolean;
}

async function handleJob(deps: OrderHandlerDeps, { lease, job, isNewestOfBurst }: JobInput): Promise<JobOutcome> {
  const customer = await deps.customers.ofConversation(lease);
  // Every conversation has a customer (0004): missing means the lease is for another store's ID.
  if (customer === null) throw new Error("no customer for the leased conversation");
  const savedPlace = (await deps.places?.latest(lease, customer.id)) ?? null;
  const control = (await deps.gate?.controls.stateOf(lease)) ?? null;
  const facts: JobFacts = {
    customer,
    savedPlace,
    ownerName: control?.ownerName ?? null,
    introduced: control === null || control.introducedAtMs !== null,
  };

  if (isHoursTap(job)) return handleHoursTap(deps, lease, job, facts);
  const placeTap = placeAction(job);
  if (placeTap !== null) return handlePlaceTap(deps, lease, job, facts, placeTap);
  const answer = await readbackAnswer(deps, lease, job, customer);
  if (answer === "unseen_readback") return handleUnseenReadback(deps, lease, job);
  if (answer !== null) return handleAnswer(deps, lease, job, facts, answer);

  if (!isNewestOfBurst) {
    // Read now only when the next message is an answer, so the answer sees this reading saved.
    const found = await deps.jobs.nextOpenJob(lease, job.id);
    const next = found === null ? null : await asTappedNumber(deps, lease, found);
    if (next !== null && (await readbackAnswer(deps, lease, next, customer)) === null && placeAction(next) === null && !isHoursTap(next)) {
      return { replies: [] };
    }
  }
  return handleBurst(deps, lease, job, facts, isNewestOfBurst);
}

/**
 * "1", "2" or "3" typed alone, when the last message the customer was sent before writing it had
 * buttons: that button, as if tapped (its ID is the operation key, checked as any tap is). With no
 * buttons there, or no button at that place, the text is read as usual: never guessed.
 */
async function asTappedNumber(deps: OrderHandlerDeps, lease: Lease, job: Job): Promise<Job> {
  if (job.kind !== "text" || deps.buttonsShown == null) return job;
  const n = typedButtonNumber(job.textBody);
  if (n === null) return job;
  const button = (await deps.buttonsShown.lastButtons(lease, job.receivedAtMs))[n - 1];
  if (button === undefined) return job;
  return { ...job, kind: "interactive", replyId: button.id, textBody: button.title };
}

/**
 * Every message gets an answer: a job that closes the burst and would send nothing sends the
 * current step again. The pending question when the engine says one waits; "¡A la orden! 🙌" for a
 * tap already answered; "¿Qué más te mando?" with an order open; the what-to-order question with
 * none (a new customer's becomes the welcome).
 */
async function neverSilent(deps: OrderHandlerDeps, { lease, job, isNewestOfBurst }: JobInput, run: () => Promise<JobOutcome>): Promise<JobOutcome> {
  const outcome = await run();
  if (outcome.replies.length > 0 || !isNewestOfBurst) return outcome;
  const body = await fallbackLine(deps, lease, job);
  deps.log.info("silent_reply_filled", { businessId: lease.businessId, conversationId: lease.conversationId, inboundId: job.id });
  return { ...outcome, replies: [{ body, ttlMs: ORDER_REPLY_TTL_MS, closesBurst: true }] };
}

async function fallbackLine(deps: OrderHandlerDeps, lease: Lease, job: Job): Promise<string> {
  const source = readingSourceOf(deps.engine);
  const customer = source === null ? null : await deps.customers.ofConversation(lease);
  const perception =
    source === null || customer === null
      ? null
      : await source.perceptionContext({
          businessId: lease.businessId,
          conversationId: lease.conversationId,
          customerId: customer.id,
          jobId: job.id,
          nowMs: deps.clock.now(),
        });
  if (perception?.pendingQuestion != null) return questionText(perception.pendingQuestion);
  if (job.kind === "interactive") return COPY.welcome;
  return perception?.openOrder != null ? COPY.anythingElse : WHAT_TO_ORDER;
}

function isHoursTap(job: Job): boolean {
  return job.kind === "interactive" && job.replyId === INTRO_BUTTON_IDS.hours;
}

/**
 * A tap on the first message's Horario: the store-hours question, decided by code from the button
 * ID. Like a readback answer, its reply goes out even if more messages follow.
 */
async function handleHoursTap(deps: OrderHandlerDeps, lease: Lease, job: Job, facts: JobFacts): Promise<JobOutcome> {
  const { customer, savedPlace } = facts;
  const nowMs = deps.clock.now();
  const reading: BurstReading = {
    observations: [{ kind: "question", topic: "store_hours", products: [], issues: [] }],
    calls: [],
  };
  const result = await deps.engine.onBurst(context(lease, job, customer, savedPlace, nowMs), reading, []);
  deps.log.info("customer_action_handled", {
    businessId: lease.businessId,
    conversationId: lease.conversationId,
    inboundId: job.id,
    outcome: result.outcome.type,
  });
  return complete(deps, lease, job, facts, [job], result, null, false, nowMs);
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
async function handlePlaceTap(deps: OrderHandlerDeps, lease: Lease, job: Job, facts: JobFacts, action: PlaceAction): Promise<JobOutcome> {
  const { customer, savedPlace } = facts;
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
  // Tapped again: nothing changes, and the customer hears where the order stands (under a readback
  // that waits, "tocá Confirmar" with its buttons), like an "ok".
  if (result.outcome.type === "duplicate") return handleSmallTalk(deps, lease, job, facts, [job], "ack", false, nowMs);
  return complete(deps, lease, job, facts, [job], result, null, false, nowMs);
}

/**
 * A tap on a readback button (it names its version), or its word typed alone while a readback is
 * open. A typed word answers the last readback only if it arrived after that readback was queued:
 * one sent earlier answered a version the customer saw before, which may have changed since, so
 * it is `unseen_readback` and confirms nothing.
 *
 * A typed yes is Confirmar only when the last message the customer was sent before writing it
 * carried that readback's Confirmar button: after any other message (a question, an answer) the
 * yes may answer that one, so it's read instead.
 */
async function readbackAnswer(deps: OrderHandlerDeps, lease: Lease, job: Job, customer: ConversationCustomer): Promise<Answer | "unseen_readback" | null> {
  if (job.kind === "interactive") {
    const tapped = parseReadbackButton(job.replyId);
    if (tapped !== null) return tapped;
  }
  if (job.kind !== "text" || customer.lastReadback === null) return null;
  const { orderId, version, queuedAtMs } = customer.lastReadback;
  const word = typedReadbackWord(job.textBody);
  if (word !== null) return job.receivedAtMs <= queuedAtMs ? "unseen_readback" : { word, orderId, version };
  if (!isTypedYes(job.textBody) || job.receivedAtMs <= queuedAtMs || deps.buttonsShown == null) return null;
  const confirmId = decisionKey("confirm", { orderId, version });
  const shown = await deps.buttonsShown.lastButtons(lease, job.receivedAtMs);
  return confirmId !== null && shown.some((button) => button.id === confirmId)
    ? { word: "confirm", orderId, version, typedYes: true }
    : null;
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

async function handleAnswer(deps: OrderHandlerDeps, lease: Lease, job: Job, facts: JobFacts, answer: Answer): Promise<JobOutcome> {
  const { customer, savedPlace } = facts;
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
  // Already answered (a second tap, the word typed after the tap), or a typed yes that confirms
  // nothing (the order moved on): nothing changed, and it gets the house answer, not silence or a
  // refusal.
  const refusedYes = answer.typedYes === true && result.outcome.type === "rejected" && result.outcome.reason !== "stale_version";
  if (result.outcome.type === "duplicate" || refusedYes) {
    return { replies: [{ body: COPY.welcome, ttlMs: ORDER_REPLY_TTL_MS }], commits: [deps.jobs.markReadCommit(lease, job.id, [job.id], nowMs), ...result.commits] };
  }
  // The answer's own reply goes out even if more messages follow: it is never a burst-closing one.
  return complete(deps, lease, job, facts, [job], result, answer.word, false, nowMs);
}

async function handleBurst(deps: OrderHandlerDeps, lease: Lease, job: Job, facts: JobFacts, closesBurst: boolean): Promise<JobOutcome> {
  const { customer, savedPlace } = facts;
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
  const talk = await smallTalkOf(deps, messages, customerContext);
  if (talk !== null) return handleSmallTalk(deps, lease, job, facts, messages, talk, closesBurst, nowMs);

  let read: BurstRead;
  try {
    read = (await typedNameAnswer(deps, lease, customer, messages, customerContext)) ?? (await deps.reader.read({ lease, messages, context: customerContext }));
  } catch (error) {
    if (!(error instanceof BurstMediaUnreadableError) || !givesUpOnMedia(job, error)) throw error;
    return unreadableMediaOutcome(deps, lease, job, error, nowMs);
  }
  const products = await productWords(deps, lease);
  const { matches, pendingQuestion } = read;
  const reading = withNamesChecked(read.reading, products);
  // The name, when this burst gave one that can be a name: saved here, and told to the engine so a
  // Confirmar held for it completes now.
  const name = customer.name === null ? givenName(reading, pendingQuestion, products) : null;
  const engineContext: CustomerContextWithName = { ...customerContext, customerName: customer.name ?? name };
  const plan = read.plan ?? null;
  const result = plan === null ? await deps.engine.onBurst(engineContext, reading, matches) : await deps.engine.onBurst(engineContext, reading, matches, plan);
  deps.log.info("burst_read", {
    businessId: lease.businessId,
    conversationId: lease.conversationId,
    inboundId: job.id,
    count: messages.length,
    outcome: result.outcome.type,
  });
  const nameCommits = name === null ? [] : [deps.customers.saveNameCommit(lease, customer.id, name, nowMs)];
  const named: JobFacts = { ...facts, customer: { ...customer, name: customer.name ?? name } };
  // The planner's one connecting sentence (already checked: no facts) goes before the step.
  const say = plan === null || plan.say === "" ? null : plan.say;
  return complete(deps, lease, job, named, messages, result, null, closesBurst, nowMs, nameCommits, null, say);
}

/**
 * A burst of only greetings, thanks or "ok"s, decided by code: no model call. A yes word ("sí",
 * "dale") while the engine waits on a question isn't small talk: it may answer it, so it's read.
 */
async function smallTalkOf(deps: OrderHandlerDeps, messages: readonly Job[], customerContext: CustomerContextWithName): Promise<SmallTalk | null> {
  const kinds = messages.map((message) => (message.kind === "text" ? smallTalk(message.textBody) : null));
  if (kinds.some((kind) => kind === null)) return null;
  const source = readingSourceOf(deps.engine);
  if (source === null) return null;
  if (kinds.includes("ack") && (await source.perceptionContext(customerContext)).pendingQuestion !== null) return null;
  if (kinds.includes("greeting")) return "greeting";
  return kinds.includes("thanks") ? "thanks" : "ack";
}

/**
 * Small talk: the engine gets an empty reading and says where the order stands (the open
 * question, the readback, the status). A greeting puts "¡Buenas, Carla! 👋" before it. A thanks or
 * an "ok": under a readback that waits and was sent, "Para dejarlo listo, tocá Confirmar ✅" with
 * the buttons (one that was withheld goes out in full); with a question waiting, "¡A la orden! 🙌"
 * and the question; otherwise "¡A la orden! 🙌" alone.
 */
async function handleSmallTalk(
  deps: OrderHandlerDeps,
  lease: Lease,
  job: Job,
  facts: JobFacts,
  messages: readonly Job[],
  talk: SmallTalk,
  closesBurst: boolean,
  nowMs: number,
): Promise<JobOutcome> {
  const { customer, savedPlace } = facts;
  const result = await deps.engine.onBurst(context(lease, job, customer, savedPlace, nowMs), { observations: [], calls: [] }, []);
  deps.log.info("small_talk_handled", {
    businessId: lease.businessId,
    conversationId: lease.conversationId,
    inboundId: job.id,
    count: messages.length,
    outcome: result.outcome.type,
  });
  const outcome = result.outcome;
  // A readback that waits, and that the customer was sent (its reply wasn't withheld for a later
  // message), isn't sent again in full: a short nudge, with its buttons. Never sent: in full.
  const shownBefore =
    outcome.type === "readback" &&
    customer.lastReadback?.orderId === outcome.order.orderId &&
    customer.lastReadback.version === outcome.order.version;
  const nudge = shownBefore && outcome.order.state === "por_confirmar" ? confirmNudge(outcome.order) : null;
  if (talk === "greeting") {
    // A new customer's greeting comes from the first message itself (customer-gate.ts).
    const lead = facts.introduced ? greetingLine(customer.name) : null;
    return complete(deps, lease, job, facts, messages, result, null, closesBurst, nowMs, [], nudge, lead);
  }
  if (nudge !== null) return complete(deps, lease, job, facts, messages, result, null, closesBurst, nowMs, [], nudge);
  // A readback the customer was never sent goes out in full: there's nothing to nudge toward yet.
  if (outcome.type === "readback") return complete(deps, lease, job, facts, messages, result, null, closesBurst, nowMs);
  if (outcome.type === "ask" && outcome.question !== "what_to_order") {
    return complete(deps, lease, job, facts, messages, result, null, closesBurst, nowMs, [], null, COPY.welcome);
  }
  // Nothing waits on them: the house answer alone, claiming nothing.
  return {
    replies: [{ body: COPY.welcome, ttlMs: ORDER_REPLY_TTL_MS, closesBurst }],
    commits: [deps.jobs.markReadCommit(lease, job.id, messages.map((message) => message.id), nowMs), ...result.commits],
  };
}

/** Catalog names and aliases, folded: an answer that names a product isn't a name. */
async function productWords(deps: OrderHandlerDeps, lease: Lease): Promise<ReadonlySet<string>> {
  const source = readingSourceOf(deps.engine);
  if (source === null) return new Set();
  const catalog = await source.catalog({ businessId: lease.businessId });
  return new Set(catalog.flatMap((product) => [...product.names, ...product.aliases]).map(foldShortText));
}

/**
 * The name question asked last, answered with one typed message that can only be a name ("Luis",
 * "ta bien, Luis"): read by code, with no model call, like a typed yes. Anything else is null and
 * goes to perception as usual.
 */
async function typedNameAnswer(
  deps: OrderHandlerDeps,
  lease: Lease,
  customer: ConversationCustomer,
  messages: readonly Job[],
  customerContext: CustomerContextWithName,
): Promise<BurstRead | null> {
  if (customer.name !== null || messages.length !== 1 || messages[0]!.kind !== "text") return null;
  const text = messages[0]!.textBody ?? "";
  const source = readingSourceOf(deps.engine);
  if (source === null) return null;
  const { pendingQuestion } = await source.perceptionContext(customerContext);
  if (pendingQuestion !== "customer_name") return null;
  const name = nameFrom(text, await productWords(deps, lease));
  if (name === null) return null;
  const evidence = { source: "text", message: 0, start: 0, end: text.length } as const;
  return { reading: { observations: [{ kind: "customer_name", name, evidence, issues: [] }], calls: [] }, matches: [], pendingQuestion };
}

/** The reading with every `customer_name` that can't be a name dropped, and the rest tidied. */
function withNamesChecked(reading: BurstReading, products: ReadonlySet<string>): BurstReading {
  const observations = reading.observations.flatMap((observation): Observation[] => {
    if (observation.kind !== "customer_name") return [observation];
    const name = nameFrom(observation.name, products);
    return name === null ? [] : [{ ...observation, name }];
  });
  return observations.length === reading.observations.length && observations.every((o, i) => o === reading.observations[i])
    ? reading
    : { ...reading, observations };
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
 * question asked last ("Carla"), only when it can be a name (never "sí", "ok", a number, an emoji,
 * a product or a sentence). Saved through our own records (gap d), first answer wins.
 */
function givenName(reading: BurstReading, pendingQuestion: QuestionCode | null, products: ReadonlySet<string>): string | null {
  for (const observation of reading.observations) {
    if (observation.kind === "customer_name") return nameFrom(observation.name, products);
  }
  if (pendingQuestion !== "customer_name") return null;
  for (const observation of reading.observations) {
    if (observation.kind === "clarification") return nameFrom(observation.answer, products);
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
  facts: JobFacts,
  read: readonly Job[],
  result: EngineResult,
  answered: ReadbackAnswer["word"] | null,
  closesBurst: boolean,
  nowMs: number,
  extra: readonly Commit[] = [],
  instead: RenderedReply | null = null,
  lead: string | null = null,
): Promise<JobOutcome> {
  const { customer } = facts;
  const step = await repliesFor(deps, lease, facts, result.outcome, answered, closesBurst, instead);
  // What the reply showed is remembered only if it went out as rendered, not as the safe reply.
  const shownAsRendered = step.length > 0 && step[0]!.body !== safeReply().body;
  const before = await answeredFirst(deps, lease, facts, result.answered ?? null);
  const replies = joined(before, lead, step, closesBurst);
  const commits: Commit[] = [
    deps.jobs.markReadCommit(lease, job.id, read.map((message) => message.id), nowMs),
    ...result.commits,
    ...extra,
    ...placeCommits(deps, lease, customer, result.outcome, nowMs),
  ];
  if (shownAsRendered) {
    commits.push(...channelCommits(deps, lease, job, customer, result.outcome, closesBurst, nowMs));
    await raiseUnanswered(deps, lease, job, customer, result.outcome);
    await raiseHandoff(deps, lease, job, customer, result.outcome);
  }
  if (result.answered != null && before.length > 0 && before[0]!.body !== safeReply().body) {
    await raiseUnanswered(deps, lease, job, customer, result.answered);
  }
  // After the confirmation's own statements, in the same batch: a proposal lands only with it.
  commits.push(...(await aliasCommits(deps, lease, job, customer, result.outcome, nowMs)));
  // Notices for other customers (staff actions) don't arise from a customer's own message here.
  if (result.notices.length > 0) {
    deps.log.warn("customer_notices_dropped", { businessId: lease.businessId, count: result.notices.length });
  }
  return { replies, commits };
}

/**
 * A confirmed order teaches the store (D-49): each line the planner matched proposes the customer's
 * words for it as an alias, for the owner to approve in Pendientes. The proposals are commits in the
 * job's completion batch, after the confirmation's (review finding 5, Nov 2): they land only if the
 * confirmation saves, and each refuses itself when the customer asked to delete their data. A
 * retried job proposes the same words again, which adds nothing. Never throws.
 */
async function aliasCommits(
  deps: OrderHandlerDeps,
  lease: Lease,
  job: Job,
  customer: ConversationCustomer,
  outcome: EngineOutcome,
  nowMs: number,
): Promise<Commit[]> {
  const source = plannerSourceOf(deps.engine);
  if (deps.aliases == null || source === null || outcome.type !== "order_confirmed") return [];
  try {
    const known = await source.plannerContext({ businessId: lease.businessId, conversationId: lease.conversationId, customerId: customer.id, jobId: job.id, nowMs });
    if (known.order?.orderId !== outcome.order.orderId) return [];
    const lines = outcome.order.lines.map((line) => ({
      said: known.said[line.lineId] ?? line.text,
      productId: line.productId,
      how: known.picked.includes(line.lineId) ? "planner_pick" : null,
    }));
    return await aliasProposalCommits(deps.aliases, deps.log, lease, { orderId: outcome.order.orderId, customerId: customer.id, lines }, nowMs);
  } catch (error) {
    deps.log.error("alias_proposal_failed", { businessId: lease.businessId, conversationId: lease.conversationId, reason: describeError(error) });
    return [];
  }
}

/**
 * The reply to the outcome. A readback answer's reply never closes the burst: it goes out even if
 * more messages follow. "Corregir" leaves the order as it is, so the engine has nothing to say and
 * the customer is asked what to change.
 */
async function repliesFor(
  deps: OrderHandlerDeps,
  lease: Lease,
  facts: JobFacts,
  outcome: EngineOutcome,
  answered: ReadbackAnswer["word"] | null,
  closesBurst: boolean,
  instead: RenderedReply | null = null,
): Promise<ReplyDraft[]> {
  if (outcome.type === "nothing" && answered === "correct") {
    return [{ body: WHAT_TO_CORRECT, ttlMs: ORDER_REPLY_TTL_MS }];
  }
  const drafts = await replyForOutcome(deps, replyContext(lease, facts), outcome, instead);
  return drafts.map(({ closesBurst: _closes, ...draft }) => (closesBurst ? { ...draft, closesBurst } : draft));
}

function replyContext(lease: Lease, facts: JobFacts): ReplyContext {
  return {
    ...lease,
    customerId: facts.customer.id,
    savedPlace: facts.savedPlace,
    ownerName: facts.ownerName,
    customerName: facts.customer.name,
    nameAsked: facts.customer.nameAskedAtMs !== null,
  };
}

/** A question the burst asked, answered from records, rendered to go before the order's next step. */
async function answeredFirst(deps: OrderHandlerDeps, lease: Lease, facts: JobFacts, answered: AnsweredQuestion | null): Promise<ReplyDraft[]> {
  return answered === null ? [] : replyForOutcome(deps, replyContext(lease, facts), answered);
}

/**
 * One message: the answer first, then a lead line ("¡Buenas, Carla! 👋"), then the step. Claims of
 * every part go with it; the buttons are the step's, the message's last part.
 */
function joined(before: readonly ReplyDraft[], lead: string | null, step: readonly ReplyDraft[], closesBurst: boolean): ReplyDraft[] {
  const [main, ...rest] = step;
  if (main === undefined) return [...before];
  const first = before[0];
  const body = [first?.body, lead, main.body].filter((part): part is string => part != null).join("\n");
  if (body === main.body) return [...step];
  const claims = [...(first?.claims ?? []), ...(main.claims ?? [])];
  const merged: ReplyDraft = {
    ...main,
    body,
    ...(claims.length === 0 ? {} : { claims }),
    ...(closesBurst ? { closesBurst } : {}),
  };
  return [merged, ...rest];
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
  const topic = outcome.type === "answer" ? outcome.topic : outcome.type === "order_confirmed" ? "order_prices" : "store_hours";
  await deps.pendientes.raise(lease, {
    kind: "customer_question",
    conversationId: lease.conversationId,
    customerId: customer.id,
    inboundId: job.id,
    topic,
    unknown,
  });
}

/**
 * "Se lo dejo anotado a Johan" is only true if someone sees it: an engine handoff (a payment, the
 * balance) raises a Pendientes item, like the typed handoff does. Raised before the save.
 */
async function raiseHandoff(deps: OrderHandlerDeps, lease: Lease, job: Job, customer: ConversationCustomer, outcome: EngineOutcome): Promise<void> {
  if (outcome.type !== "handoff") return;
  await deps.pendientes.raise(lease, {
    kind: "customer_handoff",
    conversationId: lease.conversationId,
    customerId: customer.id,
    inboundId: job.id,
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
