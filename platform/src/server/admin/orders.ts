import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { conversations, customers, messages, orderCustomFields, orderItems, orders, orderStatusHistory } from "@/db/schema";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/order-status";
import { audit, type AuditActor } from "../audit";
import { notFound } from "../http";
import { publish } from "../events";

export type OrderFilter = { status?: OrderStatus | "ALL" | "OPEN"; q?: string; page?: number; limit?: number; includeTest?: boolean };

export async function listOrders(businessId: string, filter: OrderFilter = {}) {
  const db = await getDb();
  const limit = filter.limit ?? 25;
  const page = Math.max(1, filter.page ?? 1);
  const where: SQL[] = [eq(orders.businessId, businessId)];
  if (!filter.includeTest) where.push(eq(orders.isTest, false));
  if (filter.status === "OPEN") where.push(inArray(orders.status, ["CONFIRMED", "PROCESSING", "READY", "DISPATCHED"]));
  else if (filter.status && filter.status !== "ALL") where.push(eq(orders.status, filter.status));
  const q = filter.q?.trim();
  if (q) {
    where.push(
      or(ilike(orders.orderNumber, `%${q}%`), ilike(orders.customerName, `%${q}%`), ilike(orders.customerPhone, `%${q}%`), ilike(customers.phone, `%${q}%`))!,
    );
  }
  const condition = and(...where);
  const rows = await db
    .select({ order: orders, customer: { id: customers.id, displayName: customers.displayName, profileName: customers.profileName, phone: customers.phone } })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(condition)
    .orderBy(desc(orders.createdAt))
    .limit(limit)
    .offset((page - 1) * limit);
  const [{ total }] = await db.select({ total: count() }).from(orders).innerJoin(customers, eq(customers.id, orders.customerId)).where(condition);

  const ids = rows.map((row) => row.order.id);
  const items = ids.length
    ? await db
        .select({ orderId: orderItems.orderId, name: orderItems.name, quantity: orderItems.quantity })
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids))
    : [];
  return {
    total,
    page,
    limit,
    orders: rows.map(({ order, customer }) => ({
      ...order,
      customer,
      items: items.filter((item) => item.orderId === order.id).map(({ name, quantity }) => ({ name, quantity })),
    })),
  };
}

export async function statusCounts(businessId: string, includeTest = false) {
  const db = await getDb();
  const rows = await db
    .select({ status: orders.status, n: count() })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), includeTest ? undefined : eq(orders.isTest, false)))
    .groupBy(orders.status);
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

export async function orderDetail(businessId: string, orderId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ order: orders, customer: customers })
    .from(orders)
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(and(eq(orders.id, orderId), eq(orders.businessId, businessId)));
  if (!row) throw notFound("Order not found");
  const [items, customFields, history, otherOrders] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    db.select().from(orderCustomFields).where(eq(orderCustomFields.orderId, orderId)),
    db.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId)).orderBy(asc(orderStatusHistory.createdAt)),
    db
      .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, total: orders.total, createdAt: orders.createdAt })
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.customerId, row.customer.id)))
      .orderBy(desc(orders.createdAt))
      .limit(10),
  ]);
  let conversation: { id: string; aiEnabled: boolean; status: string } | null = null;
  let recentMessages: (typeof messages.$inferSelect)[] = [];
  if (row.order.conversationId) {
    const [conv] = await db
      .select({ id: conversations.id, aiEnabled: conversations.aiEnabled, status: conversations.status })
      .from(conversations)
      .where(and(eq(conversations.id, row.order.conversationId), eq(conversations.businessId, businessId)));
    conversation = conv ?? null;
    if (conv) {
      recentMessages = (
        await db.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(desc(messages.createdAt)).limit(12)
      ).reverse();
    }
  }
  return { ...row, items, customFields, history, otherOrders, conversation, recentMessages };
}

export async function updateOrderNotes(
  businessId: string,
  orderId: string,
  input: { internalNotes?: string; trackingNumber?: string },
  actor: AuditActor,
) {
  const db = await getDb();
  const [row] = await db
    .update(orders)
    .set(input)
    .where(and(eq(orders.id, orderId), eq(orders.businessId, businessId)))
    .returning();
  if (!row) throw notFound("Order not found");
  await audit(businessId, actor, "order.updated", { type: "order", id: orderId }, { fields: Object.keys(input) });
  publish(businessId, { type: "order.updated", orderId, orderNumber: row.orderNumber, status: row.status });
  return row;
}
