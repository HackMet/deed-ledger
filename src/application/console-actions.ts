/**
 * A staff tap on the console, saved with the customer messages it causes ("Tu pedido ya está
 * listo"). The engine decides and returns `{ outcome, notices, commits }`; this saves the commits
 * and one outbox row per notice part, in the customer's conversation, as one guarded batch: all of
 * it or nothing. The rows have no job; the operation key groups them, and with the store it makes
 * the dedupe key, so a double tap queues one message.
 */
import type { ActionEnvelope, ConsoleAction } from "../domain/contract/actions";
import type { CustomerNotice, EngineOutcome } from "../domain/contract/outcomes";
import { OUTBOX_BODY_MAX_CHARS } from "../domain/outbox";
import { splitText } from "../domain/text";
import type { Engine, MemberContext } from "./engine";
import type { ConsoleNoticeDraft, ConversationRef, Deps } from "./ports";
import { replyForNotice } from "./replies";

export interface ConsoleActionResult {
  readonly outcome: EngineOutcome;
  /** Conversations with a notice ready to send now: the caller dispatches them. */
  readonly dispatch: readonly ConversationRef[];
}

type ConsoleActionDeps = Pick<Deps, "clock" | "ids" | "log" | "pendientes" | "outbox" | "channel">;

/** The dedupe key of one part of one notice: the store and the operation key name the tap. */
export function consoleNoticeDedupeKey(businessId: string, operationKey: string, notice: number, part: number): string {
  return `console_notice:${businessId}:${operationKey}:${notice}:${part}`;
}

/**
 * Runs the action through the engine and saves what it decided. The member, and so the store, come
 * from the session; every ID in the action is the engine's to resolve inside that store, and every
 * notice's customer is looked up inside it too. Throws when the save is refused (a guard that
 * doesn't hold): then nothing was saved and no message queued.
 */
export async function runConsoleAction(
  deps: ConsoleActionDeps,
  engine: Engine,
  member: MemberContext,
  envelope: ActionEnvelope<ConsoleAction>,
): Promise<ConsoleActionResult> {
  const tenant = { businessId: member.businessId };
  const { outcome, notices, commits } = await engine.onConsoleAction(member, envelope);
  const drafts = await noticeDrafts(deps, member, envelope.operationKey, notices);
  if (commits.length === 0 && drafts.length === 0) return { outcome, dispatch: [] };

  const queued = await deps.outbox.saveConsoleAction(tenant, envelope.operationKey, commits, drafts, deps.clock.now());

  for (const row of queued) {
    deps.log.info("console_notice_queued", {
      businessId: member.businessId,
      conversationId: row.conversationId,
      outboxId: row.outboxId,
      status: row.status,
    });
    // One Pendientes item per notice, not per part.
    if (row.status === "waiting_window" && row.partIndex === 0) {
      await deps.pendientes.raise(tenant, {
        kind: "notice_waiting_window",
        conversationId: row.conversationId,
        outboxId: row.outboxId,
        notice: notices[row.replyIndex]?.notice.type ?? "unknown",
      });
    }
  }
  const ready = new Set(queued.filter((row) => row.status === "pending").map((row) => row.conversationId));
  return { outcome, dispatch: [...ready].map((conversationId) => ({ ...tenant, conversationId })) };
}

/**
 * Renders each notice with the replies templates (with the claim check's first pass) and splits it
 * for the channel. A customer with no conversation in this store (known only by name) can't be
 * written to: logged, and left out.
 */
async function noticeDrafts(
  deps: ConsoleActionDeps,
  member: MemberContext,
  operationKey: string,
  notices: readonly CustomerNotice[],
): Promise<ConsoleNoticeDraft[]> {
  const tenant = { businessId: member.businessId };
  const now = deps.clock.now();
  const maxChars = Math.min(deps.channel.maxTextChars, OUTBOX_BODY_MAX_CHARS);
  const drafts: ConsoleNoticeDraft[] = [];
  for (const [n, notice] of notices.entries()) {
    const conversationId = await deps.outbox.conversationOfCustomer(tenant, notice.customerId);
    if (conversationId === null) {
      deps.log.warn("console_notice_no_conversation", { businessId: member.businessId, reason: notice.notice.type });
      continue;
    }
    const reply = await replyForNotice(deps, { ...tenant, customerId: notice.customerId, conversationId }, notice);
    const parts = splitText(reply.body, maxChars);
    parts.forEach((body, part) => {
      drafts.push({
        id: deps.ids.newId(),
        kind: "notice",
        body,
        conversationId,
        dedupeKey: consoleNoticeDedupeKey(member.businessId, operationKey, n, part),
        replyIndex: n,
        partIndex: part,
        expiresAtMs: now + reply.ttlMs,
        ...(reply.claims === undefined ? {} : { claims: reply.claims }),
        ...(reply.buttons === undefined || part !== parts.length - 1 ? {} : { buttons: reply.buttons }),
      });
    });
  }
  return drafts;
}
