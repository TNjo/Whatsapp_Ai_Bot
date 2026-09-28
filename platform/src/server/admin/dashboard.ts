import "server-only";
import { fromDoc, fromDocs, store } from "@/db";
import type { BotSettings, Conversation, Customer, Order, WhatsAppConnection } from "@/db/schema";
import { REVENUE_STATUSES } from "@/lib/order-status";
import { resolveAIConfig } from "../ai/service";
import { WINDOW_MS } from "../conversations";
import { listNotifications } from "../queries/shell";
import { statusCounts } from "./orders";

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
  const s = await store();
  const today = startOfDay(timeZone);
  const real = s.orders(businessId).where("isTest", "==", false);

  const [todayOrders, counts, customerCount, recentConversations, pending, recent, handoffRows, notificationsList, connection, settings, productCount, serviceCount, testChats] =
    await Promise.all([
      real.where("createdAt", ">=", today).orderBy("createdAt", "desc").get().then((snap) => fromDocs<Order>(snap)),
      statusCounts(businessId),
      s.customers(businessId).where("isTest", "==", false).count().get(),
      s.conversations(businessId)
        .where("isTest", "==", false)
        .where("lastMessageAt", ">=", new Date(Date.now() - WINDOW_MS))
        .orderBy("lastMessageAt", "desc")
        .limit(500)
        .get()
        .then((snap) => fromDocs<Conversation>(snap)),
      real.where("status", "==", "PENDING").orderBy("createdAt", "desc").limit(6).get().then((snap) => fromDocs<Order>(snap)),
      real.orderBy("createdAt", "desc").limit(8).get().then((snap) => fromDocs<Order>(snap)),
      s.conversations(businessId)
        .where("status", "==", "human_required")
        .where("isTest", "==", false)
        .get()
        .then((snap) => fromDocs<Conversation>(snap)),
      listNotifications(businessId, 8),
      s.whatsapp(businessId).get().then((snap) => fromDoc<WhatsAppConnection & { id: string }>(snap)),
      s.bot(businessId).get().then((snap) => fromDoc<BotSettings & { id: string }>(snap)),
      s.products(businessId).count().get(),
      s.services(businessId).count().get(),
      s.conversations(businessId).where("isTest", "==", true).get().then((snap) => fromDocs<Conversation>(snap)),
    ]);

  const handoffs = handoffRows.sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime()).slice(0, 5);
  const customerIds = [...new Set([...pending, ...recent].map((o) => o.customerId).concat(handoffs.map((h) => h.customerId)))];
  const customerSnaps = customerIds.length ? await s.db.getAll(...customerIds.map((id) => s.customers(businessId).doc(id))) : [];
  const customers = new Map(customerSnaps.map((snap) => [snap.id, fromDoc<Customer>(snap)]));
  const nameOf = (order: Order) => {
    const c = customers.get(order.customerId);
    return order.customerName || c?.displayName || c?.profileName || order.customerPhone;
  };

  const setup = [
    { key: "whatsapp", label: "Connect WhatsApp", done: connection?.status === "connected", href: "/dashboard/whatsapp" },
    { key: "ai", label: "Add an AI key and review bot settings", done: Boolean(settings && resolveAIConfig(settings)), href: "/dashboard/bot" },
    { key: "catalog", label: "Add products or services", done: productCount.data().count + serviceCount.data().count > 0, href: "/dashboard/products" },
    { key: "test", label: "Try the bot in Test mode", done: testChats.some((c) => c.lastMessagePreview), href: "/dashboard/bot/test" },
  ];

  return {
    stats: {
      todayOrders: todayOrders.length,
      pending: counts.PENDING,
      confirmed: counts.CONFIRMED + counts.PROCESSING + counts.READY + counts.DISPATCHED,
      completed: counts.COMPLETED + counts.DELIVERED,
      todayRevenue: todayOrders.filter((o) => REVENUE_STATUSES.includes(o.status)).reduce((sum, o) => sum + o.total, 0),
      customers: customerCount.data().count,
      activeConversations: recentConversations.filter((c) => c.status !== "resolved").length,
    },
    pending: pending.map((order) => ({ ...order, displayName: nameOf(order), items: order.items.map(({ name, quantity }) => ({ name, quantity })) })),
    recent: recent.map((order) => ({ ...order, displayName: nameOf(order) })),
    handoffs: handoffs.map((h) => {
      const c = customers.get(h.customerId);
      return {
        id: h.id,
        reason: h.handoffReason,
        lastMessageAt: h.lastMessageAt,
        name: c?.displayName ?? "",
        profileName: c?.profileName ?? "",
        phone: c?.phone ?? "",
        displayName: c?.displayName || c?.profileName || c?.phone || "Customer",
      };
    }),
    notifications: notificationsList,
    whatsapp: { status: connection?.status ?? "disconnected" },
    setup: setup.every((step) => step.done) ? null : setup,
  };
}
