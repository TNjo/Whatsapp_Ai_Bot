import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, type MessageStatus } from "@/db/schema";
import { publish } from "../events";
import { log } from "../logger";
import { notify } from "../notifications";

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };

/**
 * Moves an outgoing message forward (sent → delivered → read) or marks it failed.
 * Shared by Cloud API webhooks and linked-device acks. Never downgrades.
 */
export async function applyMessageStatus(
  businessId: string,
  waMessageId: string,
  status: "sent" | "delivered" | "read" | "failed",
  failure?: string,
) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.waMessageId, waMessageId), eq(messages.businessId, businessId)));
  if (!row) return;
  let next: MessageStatus | null = null;
  let errorMessage: string | null = row.errorMessage;
  if (status === "failed") {
    next = "failed";
    errorMessage = failure ?? "WhatsApp could not deliver this message.";
  } else if (STATUS_RANK[status] > (STATUS_RANK[row.status] ?? -1) && row.status !== "failed") {
    next = status;
  }
  if (!next) return;
  await db
    .update(messages)
    .set({ status: next, errorMessage, statusUpdatedAt: new Date() })
    .where(eq(messages.id, row.id));
  publish(businessId, { type: "message.status", conversationId: row.conversationId, messageId: row.id, status: next });
  if (next === "failed") {
    log.warn("whatsapp.delivery_failed", { businessId, messageId: row.id });
    await notify(businessId, {
      type: "message_failed",
      title: "A WhatsApp message could not be delivered",
      body: errorMessage ?? "",
      link: `/dashboard/conversations?c=${row.conversationId}`,
    });
  }
}

