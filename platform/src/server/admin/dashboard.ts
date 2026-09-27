import "server-only";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { botSettings, conversations, customers, orderItems, orders, products, services, whatsappConnections } from "@/db/schema";
import { REVENUE_STATUSES } from "@/lib/order-status";
import { resolveAIConfig } from "../ai/service";
import { WINDOW_MS } from "../conversations";
import { listNotifications } from "../queries/shell";

/** The UTC instant of today's local midnight in a timezone. */
export function startOfDay(timeZone: string, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, Number(p.value)]),
  );
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - offset);
}

export async function dashboardData(businessId: string, timeZone: string) {
  const db = await getDb();
  const today = startOfDay(timeZone);
  const real = and(eq(orders.businessId, businessId), eq(orders.isTest, false));

  const [
    [todayOrders],
    statusRows,
    [todayRevenue],
    [customerCount],
    [activeConversations],
    pending,
    recent,
    handoffs,
    notificationsList,
    [connection],
    [settings],
    [productCount],
    [serviceCount],
    [testChats],
  ] = await Promise.all([
    db.select({ n: count() }).from(orders).where(and(real, gte(orders.createdAt, today))),
    db.select({ status: orders.status, n: count() }).from(orders).where(real).groupBy(orders.status),
    db
      .select({ sum: sql<number>`coalesce(sum(${orders.total}), 0)::int` })
      .from(orders)
      .where(and(real, gte(orders.createdAt, today), inArray(orders.status, REVENUE_STATUSES))),
    db.select({ n: count() }).from(customers).where(and(eq(customers.businessId, businessId), eq(customers.isTest, false))),
    db
      .select({ n: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.businessId, businessId),
          eq(conversations.isTest, false),
          sql`${conversations.status} <> 'resolved'`,
          gte(conversations.lastMessageAt, new Date(Date.now() - WINDOW_MS)),
        ),
      ),
    db
      .select({ order: orders, customerName: customers.displayName, profileName: customers.profileName })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(and(real, eq(orders.status, "PENDING")))
      .orderBy(desc(orders.createdAt))
      .limit(6),
    db
      .select({ order: orders, customerName: customers.displayName, profileName: customers.profileName })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(real)
      .orderBy(desc(orders.createdAt))
      .limit(8),
    db
      .select({ id: conversations.id, reason: conversations.handoffReason, lastMessageAt: conversations.lastMessageAt, name: customers.displayName, profileName: customers.profileName, phone: customers.phone })
      .from(conversations)
      .innerJoin(customers, eq(customers.id, conversations.customerId))
      .where(and(eq(conversations.businessId, businessId), eq(conversations.status, "human_required"), eq(conversations.isTest, false)))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(5),
    listNotifications(businessId, 8),
    db.select().from(whatsappConnections).where(eq(whatsappConnections.businessId, businessId)),
    db.select().from(botSettings).where(eq(botSettings.businessId, businessId)),
    db.select({ n: count() }).from(products).where(eq(products.businessId, businessId)),
    db.select({ n: count() }).from(services).where(eq(services.businessId, businessId)),
    db
      .select({ n: count() })
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.isTest, true), sql`${conversations.lastMessagePreview} <> ''`)),
  ]);

  const pendingIds = pending.map((p) => p.order.id);
  const pendingItems = pendingIds.length
    ? await db.select({ orderId: orderItems.orderId, name: orderItems.name, quantity: orderItems.quantity }).from(orderItems).where(inArray(orderItems.orderId, pendingIds))
    : [];
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.n])) as Record<string, number>;

  const setup = [
    { key: "whatsapp", label: "Connect WhatsApp", done: connection?.status === "connected", href: "/dashboard/whatsapp" },
    { key: "ai", label: "Add an AI key and review bot settings", done: Boolean(settings && resolveAIConfig(settings)), href: "/dashboard/bot" },
    { key: "catalog", label: "Add products or services", done: (productCount?.n ?? 0) + (serviceCount?.n ?? 0) > 0, href: "/dashboard/products" },
    { key: "test", label: "Try the bot in Test mode", done: (testChats?.n ?? 0) > 0, href: "/dashboard/bot/test" },
  ];

  return {
    stats: {
      todayOrders: todayOrders?.n ?? 0,
      pending: byStatus.PENDING ?? 0,
      confirmed: (byStatus.CONFIRMED ?? 0) + (byStatus.PROCESSING ?? 0) + (byStatus.READY ?? 0) + (byStatus.DISPATCHED ?? 0),
      completed: (byStatus.COMPLETED ?? 0) + (byStatus.DELIVERED ?? 0),
      todayRevenue: todayRevenue?.sum ?? 0,
      customers: customerCount?.n ?? 0,
      activeConversations: activeConversations?.n ?? 0,
    },
    pending: pending.map(({ order, customerName, profileName }) => ({
      ...order,
      displayName: order.customerName || customerName || profileName || order.customerPhone,
      items: pendingItems.filter((i) => i.orderId === order.id),
    })),
    recent: recent.map(({ order, customerName, profileName }) => ({ ...order, displayName: order.customerName || customerName || profileName || order.customerPhone })),
    handoffs: handoffs.map((h) => ({ ...h, displayName: h.name || h.profileName || h.phone })),
    notifications: notificationsList,
    whatsapp: { status: connection?.status ?? "disconnected" },
    setup: setup.every((step) => step.done) ? null : setup,
  };
}
