import "server-only";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { conversations, notifications, orders, whatsappConnections } from "@/db/schema";

/** Badge counts for the sidebar and header. */
export async function shellCounts(businessId: string) {
  const db = await getDb();
  const [[pending], [handoff], [unread], [connection]] = await Promise.all([
    db.select({ n: count() }).from(orders).where(and(eq(orders.businessId, businessId), eq(orders.status, "PENDING"), eq(orders.isTest, false))),
    db
      .select({ n: count() })
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.status, "human_required"), eq(conversations.isTest, false))),
    db.select({ n: count() }).from(notifications).where(and(eq(notifications.businessId, businessId), isNull(notifications.readAt))),
    db.select({ status: whatsappConnections.status }).from(whatsappConnections).where(eq(whatsappConnections.businessId, businessId)),
  ]);
  return {
    pendingOrders: pending?.n ?? 0,
    humanRequired: handoff?.n ?? 0,
    unreadNotifications: unread?.n ?? 0,
    whatsappStatus: connection?.status ?? "disconnected",
  };
}

export async function listNotifications(businessId: string, limit = 30) {
  const db = await getDb();
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.businessId, businessId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}
