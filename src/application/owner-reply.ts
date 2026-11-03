/**
 * The owner answers a customer from Pendientes ("Sí hay, a L 65 la de 3 litros"). This is how every
 * "te confirmo" gets its answer. His words go to the customer's conversation as he wrote them,
 * signed with his first name, and the item leaves the list. The store comes from the session and
 * the item is looked up inside it, so another store's item finds nothing. The dedupe key names the
 * item: a second tap of the same answer queues nothing.
 *
 * The owner is the store's authority, so his words carry no claim check. They are still customer
 * data in the outbox: never logged.
 */
import { OUTBOX_BODY_MAX_CHARS } from "../domain/outbox";
import { firstName } from "../domain/replies";
import { splitText } from "../domain/text";
import type { ConsoleMember, ConversationRef, Deps } from "./ports";
import { CUSTOMER_NOTICE_TTL_MS } from "./replies";

/** The longest answer the owner can send from a card. */
export const OWNER_REPLY_MAX_CHARS = 500;

export type OwnerReplyResult =
  | { readonly status: "sent" | "waiting_window"; readonly conversation: ConversationRef }
  | { readonly status: "not_found" | "empty" | "too_long" };

type OwnerReplyDeps = Pick<Deps, "clock" | "ids" | "log" | "outbox" | "channel" | "pendientesBoard">;

export async function replyFromPendientes(
  deps: OwnerReplyDeps,
  member: ConsoleMember,
  pendienteId: string,
  text: string,
): Promise<OwnerReplyResult> {
  const body = text.replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === "\n" ? "\n" : " ")).replace(/[ \t]+/g, " ").trim();
  if (body === "") return { status: "empty" };
  if ([...body].length > OWNER_REPLY_MAX_CHARS) return { status: "too_long" };
  const item = (await deps.pendientesBoard.listOpen(member)).find((open) => open.id === pendienteId);
  const conversationId = item?.conversationId ?? null;
  if (item === undefined || conversationId === null) return { status: "not_found" };

  const signer = member.displayName === null ? null : firstName(member.displayName);
  const message = `*${signer ?? "De la tienda"}:* ${body}`;
  const nowMs = deps.clock.now();
  const parts = splitText(message, Math.min(deps.channel.maxTextChars, OUTBOX_BODY_MAX_CHARS));
  const drafts = parts.map((part, partIndex) => ({
    id: deps.ids.newId(),
    kind: "notice",
    body: part,
    conversationId,
    dedupeKey: `owner_reply:${member.businessId}:${item.id}:${partIndex}`,
    replyIndex: 0,
    partIndex,
    expiresAtMs: nowMs + CUSTOMER_NOTICE_TTL_MS,
  }));
  const queued = await deps.outbox.saveConsoleAction(member, `owner_reply:${item.id}`, [], drafts, nowMs);
  await deps.pendientesBoard.markDone(member, item.id, member.userId, nowMs);
  const waiting = queued.some((row) => row.status === "waiting_window");
  deps.log.info("owner_reply_queued", { businessId: member.businessId, conversationId, outcome: waiting ? "waiting_window" : "pending" });
  return { status: waiting ? "waiting_window" : "sent", conversation: { businessId: member.businessId, conversationId } };
}
