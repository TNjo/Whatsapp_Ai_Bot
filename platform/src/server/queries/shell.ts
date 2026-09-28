import "server-only";
import { fromDoc, fromDocs, store } from "@/db";
import type { Notification, WhatsAppConnection } from "@/db/schema";

/** Badge counts for the sidebar and header (Firestore count() aggregations). */
export async function shellCounts(businessId: string) {
  const s = await store();
  const [pending, handoff, unread, connection] = await Promise.all([
    s.orders(businessId).where("status", "==", "PENDING").where("isTest", "==", false).count().get(),
    s.conversations(businessId).where("status", "==", "human_required").where("isTest", "==", false).count().get(),
    s.notifications(businessId).where("readAt", "==", null).count().get(),
    s.whatsapp(businessId).get(),
  ]);
  return {
    pendingOrders: pending.data().count,
    humanRequired: handoff.data().count,
    unreadNotifications: unread.data().count,
    whatsappStatus: fromDoc<WhatsAppConnection & { id: string }>(connection)?.status ?? "disconnected",
  };
}

export async function listNotifications(businessId: string, limit = 30) {
  const s = await store();
  return fromDocs<Notification>(await s.notifications(businessId).orderBy("createdAt", "desc").limit(limit).get());
}
