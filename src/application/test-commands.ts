/**
 * WhatsApp test commands, for testing as a brand-new customer from a real phone:
 *
 * - `/new` (`/nuevo`, `/reset`): the sender becomes a new customer of the store. Their open order is
 *   cancelled (no notice to anyone; the command's one reply is the only message), their data is
 *   erased the way a deletion request erases it (media, message text, what we sent them, saved
 *   places, Pendientes, readback pointers, proposed aliases), and their name and introduction are
 *   cleared, so their next message gets the first-message welcome. Their phone stays, so the
 *   reply reaches them. Sent again with nothing left to reset, it only replies.
 * - `/help` (`/ayuda`): the commands, one line each.
 *
 * Two locks, both required, checked here before the gate and before any model call: the Worker's
 * TEST_COMMANDS is "1" (`enabled`), and the sender's phone is an active member (owner or staff) of
 * the store that owns the receiving number. Otherwise the text is an ordinary customer message,
 * and nothing says commands exist. Logs carry IDs and the command name only.
 */
import { decisionKey } from "../domain/replies";
import { CONTROL_REPLY_TTL_MS } from "./customer-gate";
import type { CustomerContext, Engine } from "./engine";
import { plannerSourceOf } from "./planner/source";
import type { Clock, Commit, CustomerControlRepository, CustomerRepository, JobInput, JobOutcome, JobRepository, Logger, MediaEraser } from "./ports";

export const TEST_COMMAND_REPLIES = {
  reset: "Listo, empezás como cliente nuevo. Escribime como si fuera la primera vez.",
  help: ["Comandos de prueba:", "/new (o /nuevo, /reset): empezás como cliente nuevo.", "/help (o /ayuda): esta lista."].join("\n"),
} as const;

type TestCommand = "new" | "help";

const COMMANDS: Readonly<Record<string, TestCommand>> = { "/new": "new", "/nuevo": "new", "/reset": "new", "/help": "help", "/ayuda": "help" };

/** The command a text is, alone and in any case; null for anything else. */
export function testCommandOf(text: string | null): TestCommand | null {
  const word = (text ?? "").trim().toLowerCase();
  return Object.hasOwn(COMMANDS, word) ? COMMANDS[word]! : null;
}

export interface TestCommandDeps {
  /** TEST_COMMANDS is "1". */
  readonly enabled: boolean;
  readonly engine: Engine;
  readonly controls: CustomerControlRepository;
  readonly customers: CustomerRepository;
  readonly jobs: JobRepository;
  readonly mediaEraser: MediaEraser;
  readonly clock: Clock;
  readonly log: Logger;
}

/** The command's outcome when both locks hold; null, and nothing done, otherwise. */
export async function handleTestCommand(deps: TestCommandDeps | null | undefined, { lease, job }: JobInput): Promise<JobOutcome | null> {
  if (deps == null || !deps.enabled || job.kind !== "text") return null;
  const command = testCommandOf(job.textBody);
  if (command === null) return null;
  const customer = await deps.customers.ofConversation(lease);
  if (customer === null || !(await deps.controls.isStoreMember(lease, customer.id))) return null;

  const nowMs = deps.clock.now();
  const reply = (body: string) => [{ body, ttlMs: CONTROL_REPLY_TTL_MS }];
  const readThis = deps.jobs.markReadCommit(lease, job.id, [job.id], nowMs);
  const ids = { businessId: lease.businessId, conversationId: lease.conversationId, inboundId: job.id, reason: command };
  if (command === "help") {
    deps.log.info("test_command", { ...ids, outcome: "help" });
    return { replies: reply(TEST_COMMAND_REPLIES.help), commits: [readThis] };
  }

  const context: CustomerContext = { businessId: lease.businessId, conversationId: lease.conversationId, customerId: customer.id, jobId: job.id, nowMs };
  const order = (await plannerSourceOf(deps.engine)?.plannerContext(context))?.order ?? null;
  const state = await deps.controls.stateOf(lease);
  const alreadyNew = order === null && customer.name === null && state?.introducedAtMs == null && state?.stoppedAtMs == null;
  if (alreadyNew) {
    deps.log.info("test_command", { ...ids, outcome: "already_new" });
    return { replies: reply(TEST_COMMAND_REPLIES.reset), commits: [readThis] };
  }

  const commits: Commit[] = [readThis];
  if (order !== null) {
    // Cancelled as the customer's own Cancelar would: same key, so a retried job cancels once. Its
    // reply isn't sent; the command's is the only message.
    const key = decisionKey("cancel", order);
    if (key !== null) {
      const cancelled = await deps.engine.onCustomerAction(context, {
        operationKey: key,
        actor: { type: "customer", customerId: customer.id },
        action: { type: "cancel_order", orderId: order.orderId, version: order.version },
      });
      commits.push(...cancelled.commits);
    }
  }
  // Photos and voice notes first, as the deletion purge does; D1 forgets their references below.
  const { mediaPrefixes } = await deps.controls.deletionMedia(lease, customer.id);
  for (const prefix of mediaPrefixes) await deps.mediaEraser.erasePrefix(lease, prefix);
  commits.push(deps.controls.resetCommit(lease, customer.id, job.receivedAtMs, nowMs));
  deps.log.info("test_command", { ...ids, outcome: "reset" });
  return { replies: reply(TEST_COMMAND_REPLIES.reset), commits };
}
