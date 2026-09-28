import "server-only";
import type { Query } from "firebase-admin/firestore";
import { fromDoc, fromDocs, store } from "@/db";
import type { Conversation, Customer, Message, Order } from "@/db/schema";
import { OPEN_STATUSES, ORDER_STATUSES, type OrderStatus } from "@/lib/order-status";
import { audit, type AuditActor } from "../audit";
import { customerOrders } from "../commerce/orders";
import { publish } from "../events";
import { notFound } from "../http";

export type OrderFilter = { status?: OrderStatus | "ALL" | "OPEN"; q?: string; page?: number; limit?: number; includeTest?: boolean };

const SEARCH_WINDOW = 500;

function filtered(base: Query, filter: OrderFilter) {
  let query = base;
  if (!filter.includeTest) query = query.where("isTest", "==", false);
  if (filter.status === "OPEN") query = query.where("status", "in", OPEN_STATUSES.filter((s) => s !== "PENDING"));
  else if (filter.status && filter.status !== "ALL") query = query.where("status", "==", filter.status);
  return query;
}

/**
 * Newest first, paginated in Firestore. Text search (order number, name, phone)
 * scans the most recent orders in memory — Firestore has no substring search.
 */
export async function listOrders(businessId: string, filter: OrderFilter = {}) {
  const s = await store();
  const limit = filter.limit ?? 25;
  const page = Math.max(1, filter.page ?? 1);
  const query = filtered(s.orders(businessId), filter);
  const q = filter.q?.trim().toLowerCase();

  let rows: Order[];
  let total: number;
  if (q) {
    const recent = fromDocs<Order>(await query.orderBy("createdAt", "desc").limit(SEARCH_WINDOW).get());
    const matches = recent.filter((o) => `${o.orderNumber} ${o.customerName} ${o.customerPhone}`.toLowerCase().includes(q));
    total = matches.length;
    rows = matches.slice((page - 1) * limit, page * limit);
  } else {
    const [countSnap, pageSnap] = await Promise.all([
      query.count().get(),
      query.orderBy("createdAt", "desc").offset((page - 1) * limit).limit(limit).get(),
    ]);
    total = countSnap.data().count;
    rows = fromDocs<Order>(pageSnap);
  }

  const customerIds = [...new Set(rows.map((o) => o.customerId))];
  const customers = customerIds.length ? await s.db.getAll(...customerIds.map((id) => s.customers(businessId).doc(id))) : [];
  const byId = new Map(customers.map((snap) => [snap.id, fromDoc<Customer>(snap)]));
  return {
    total,
    page,
    limit,
    orders: rows.map((order) => {
      const customer = byId.get(order.customerId);
      return {
        ...order,
        customer: { id: order.customerId, displayName: customer?.displayName ?? "", profileName: customer?.profileName ?? "", phone: customer?.phone ?? "" },
        items: order.items.map(({ name, quantity }) => ({ name, quantity })),
      };
    }),
  };
}

export async function statusCounts(businessId: string, includeTest = false) {
  const s = await store();
  const entries = await Promise.all(
    ORDER_STATUSES.map(async (status) => {
      let query = s.orders(businessId).where("status", "==", status);
      if (!includeTest) query = query.where("isTest", "==", false);
      return [status, (await query.count().get()).data().count] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<OrderStatus, number>;
}

export async function orderDetail(businessId: string, orderId: string) {
  const s = await store();
  const order = fromDoc<Order>(await s.orders(businessId).doc(orderId).get());
  if (!order) throw notFound("Order not found");
  const customer = fromDoc<Customer>(await s.customers(businessId).doc(order.customerId).get());
  if (!customer) throw notFound("Order not found");
  const otherOrders = (await customerOrders(businessId, customer.id, 10)).map(({ id, orderNumber, status, total, createdAt }) => ({
    id,
    orderNumber,
    status,
    total,
    createdAt,
  }));
  let conversation: { id: string; aiEnabled: boolean; status: string } | null = null;
  let recentMessages: Message[] = [];
  if (order.conversationId) {
    const conv = fromDoc<Conversation>(await s.conversations(businessId).doc(order.conversationId).get());
    if (conv) {
      conversation = { id: conv.id, aiEnabled: conv.aiEnabled, status: conv.status };
      recentMessages = fromDocs<Message>(await s.messages(businessId, conv.id).orderBy("createdAt", "desc").limit(12).get()).reverse();
    }
  }
  return {
    order,
    customer,
    items: order.items,
    customFields: order.customFields,
    history: [...order.history].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    otherOrders,
    conversation,
    recentMessages,
  };
}

export async function updateOrderNotes(
  businessId: string,
  orderId: string,
  input: { internalNotes?: string; trackingNumber?: string },
  actor: AuditActor,
) {
  const s = await store();
  const ref = s.orders(businessId).doc(orderId);
  const current = fromDoc<Order>(await ref.get());
  if (!current) throw notFound("Order not found");
  const patch = { ...input, updatedAt: new Date() };
  await ref.update(patch);
  await audit(businessId, actor, "order.updated", { type: "order", id: orderId }, { fields: Object.keys(input) });
  publish(businessId, { type: "order.updated", orderId, orderNumber: current.orderNumber, status: current.status });
  return { ...current, ...patch };
}
