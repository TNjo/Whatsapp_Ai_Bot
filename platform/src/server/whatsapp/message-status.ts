import "server-only";
import { fromDoc, keyId, store } from "@/db";
import type { Message, MessageStatus, WaMessageIndex } from "@/db/schema";
import { publish } from "../events";
import { log } from "../logger";
import { notify } from "../notifications";

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };

/**
 * Moves an outgoing message forward (sent → delivered → read) or marks it failed.
 * Found through businesses/{b}/waMessages/{hash(waMessageId)}. Never downgrades.
 */
export async function applyMessageStatus(
  businessId: string,
  waMessageId: string,
  status: "sent" | "delivered" | "read" | "failed",
  failure?: string,
) {
  const s = await store();
  const index = (await s.waMessages(businessId).doc(keyId(waMessageId)).get()).data() as WaMessageIndex | undefined;
  if (!index) return;
  const ref = s.messages(businessId, index.conversationId).doc(index.messageId);
  const result = await s.db.runTransaction(async (tx) => {
    const row = fromDoc<Message>(await tx.get(ref));
    if (!row) return null;
    let next: MessageStatus | null = null;
    let errorMessage = row.errorMessage;
    if (status === "failed") {
      next = "failed";
      errorMessage = failure ?? "WhatsApp could not deliver this message.";
    } else if (STATUS_RANK[status] > (STATUS_RANK[row.status] ?? -1) && row.status !== "failed") {
      next = status;
    }
    if (!next) return null;
    tx.update(ref, { status: next, errorMessage, statusUpdatedAt: new Date() });
    return { row, next, errorMessage };
  });
  if (!result) return;
  publish(businessId, { type: "message.status", conversationId: result.row.conversationId, messageId: result.row.id, status: result.next });
  if (result.next === "failed") {
    log.warn("whatsapp.delivery_failed", { businessId, messageId: result.row.id });
    await notify(businessId, {
      type: "message_failed",
      title: "A WhatsApp message could not be delivered",
      body: result.errorMessage ?? "",
      link: `/dashboard/conversations?c=${result.row.conversationId}`,
    });
  }
}
