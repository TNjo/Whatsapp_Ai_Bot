import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type Tx } from "@/db";
import {
  botSettings,
  businesses,
  carts,
  conversations,
  customers,
  orderCustomFields,
  orderItems,
  orders,
  orderStatusHistory,
  products,
  productVariants,
  whatsappTemplates,
} from "@/db/schema";
import { formatMoney } from "@/lib/format";
import { REVENUE_STATUSES, STATUS_LABEL, STATUS_TRANSITIONS, STOCK_RELEASING, type OrderStatus } from "@/lib/order-status";
import { audit, type AuditActor } from "../audit";
import { canSendFreeform } from "../whatsapp/channel";
import { publish } from "../events";
import { ApiError, notFound } from "../http";
import { log } from "../logger";
import { notify } from "../notifications";
import { deliver } from "../outbound";
import { viewCart, type Cart, type CartView } from "./cart";
import { getOrderFields, SYSTEM_KEYS } from "./order-form";
import { DEFAULT_STATUS_MESSAGES, renderMessage, statusMessageKey, type MessageVars } from "./status-messages";

export type Order = typeof orders.$inferSelect;

export class OrderError extends Error {}

/** Recomputes the stored totals on the customer record (spec §9). Test orders don't count. */
export async function refreshCustomerStats(customerId: string, tx?: Tx) {
  const db = tx ?? (await getDb());
  const [stats] = await db
    .select({
      count: sql<number>`count(*)::int`,
      spent: sql<number>`coalesce(sum(case when ${inArray(orders.status, REVENUE_STATUSES)} then ${orders.total} else 0 end), 0)::int`,
    })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), eq(orders.isTest, false)));
  await db
    .update(customers)
    .set({ totalOrders: stats?.count ?? 0, totalSpent: stats?.spent ?? 0 })
    .where(eq(customers.id, customerId));
}

async function adjustStock(tx: Tx, items: { productId: string | null; variantId: string | null; quantity: number }[], direction: -1 | 1) {
  const lowStock: { productId: string; stock: number }[] = [];
  for (const item of items) {
    if (!item.productId) continue;
    const [product] = await tx.select().from(products).where(eq(products.id, item.productId));
    if (!product?.trackStock) continue;
    const delta = direction * item.quantity;
    if (item.variantId) {
      const [variant] = await tx
        .update(productVariants)
        .set({ stock: sql`${productVariants.stock} + ${delta}` })
        .where(and(eq(productVariants.id, item.variantId), direction < 0 ? sql`${productVariants.stock} >= ${item.quantity}` : undefined))
        .returning();
      if (!variant) throw new OrderError(`Sorry, ${product.name} is now out of stock in that option.`);
      await tx
        .update(products)
        .set({ stock: sql`(select coalesce(sum(stock), 0) from product_variants where product_id = ${product.id})` })
        .where(eq(products.id, product.id));
      lowStock.push({ productId: product.id, stock: variant.stock });
    } else {
      const [updated] = await tx
        .update(products)
        .set({ stock: sql`${products.stock} + ${delta}` })
        .where(and(eq(products.id, product.id), direction < 0 ? sql`${products.stock} >= ${item.quantity}` : undefined))
        .returning();
      if (!updated) throw new OrderError(`Sorry, ${product.name} is now out of stock.`);
      lowStock.push({ productId: product.id, stock: updated.stock });
    }
  }
  return lowStock;
}

/**
 * Turns a confirmed draft order into a PENDING order (spec §22). The backend —
 * not the AI — enforces that the customer saw the exact review being confirmed.
 */
export async function createOrderFromCart(businessId: string, cart: Cart, opts: { isTest: boolean }) {
  const view: CartView = await viewCart(businessId, cart);
  if (!view.readyForReview) throw new OrderError("The order is missing information.");
  if (view.stage !== "CUSTOMER_CONFIRMATION" || cart.reviewHash !== view.reviewHash) {
    throw new OrderError("The order changed since the customer reviewed it. Show the review again before confirming.");
  }

  const db = await getDb();
  const fieldDefs = await getOrderFields(businessId);
  const labels = new Map(fieldDefs.map((field) => [field.key, field.label]));
  const f = view.fields;

  const result = await db.transaction(async (tx) => {
    // Test orders never consume the real ORD- sequence.
    const [business] = await tx
      .update(businesses)
      .set({ nextOrderNumber: opts.isTest ? businesses.nextOrderNumber : sql`${businesses.nextOrderNumber} + 1` })
      .where(eq(businesses.id, businessId))
      .returning({ next: businesses.nextOrderNumber, currency: businesses.currency, lowStockThreshold: businesses.lowStockThreshold });
    const orderNumber = opts.isTest
      ? `TEST-${Math.floor(10000 + Math.random() * 90000)}`
      : `ORD-${business.next - 1}`;

    const lowStock = opts.isTest
      ? []
      : await adjustStock(
          tx,
          view.items.map((item) => ({ productId: item.kind === "product" ? item.refId : null, variantId: item.variantId, quantity: item.quantity })),
          -1,
        );

    const [order] = await tx
      .insert(orders)
      .values({
        businessId,
        orderNumber,
        customerId: cart.customerId,
        conversationId: cart.conversationId,
        status: "PENDING",
        currency: business.currency,
        subtotal: view.subtotal,
        deliveryFee: view.deliveryFee,
        total: view.total,
        customerName: f.name ?? "",
        customerPhone: f.phone ?? "",
        deliveryAddress: f.address ?? "",
        city: f.city ?? "",
        paymentMethod: f.payment_method ?? "",
        customerNote: f.note ?? "",
        isTest: opts.isTest,
      })
      .returning();

    await tx.insert(orderItems).values(
      view.items.map((item) => ({
        businessId,
        orderId: order.id,
        productId: item.kind === "product" ? item.refId : null,
        serviceId: item.kind === "service" ? item.refId : null,
        variantId: item.variantId,
        name: item.name,
        optionValues: item.options,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
      })),
    );
    const custom = Object.entries(f).filter(([key, value]) => !SYSTEM_KEYS.has(key) && value);
    if (custom.length) {
      await tx.insert(orderCustomFields).values(
        custom.map(([key, value]) => ({ businessId, orderId: order.id, key, label: labels.get(key) ?? key, value })),
      );
    }
    await tx.insert(orderStatusHistory).values({
      businessId,
      orderId: order.id,
      fromStatus: null,
      toStatus: "PENDING",
      changedBy: "Customer (WhatsApp)",
      note: "Order placed after customer confirmation",
    });
    await tx.update(carts).set({ status: "converted", orderId: order.id }).where(eq(carts.id, cart.id));

    // Remember delivery details for next time.
    await tx
      .update(customers)
      .set({
        ...(f.name ? { displayName: f.name } : {}),
        ...(f.address ? { address: f.address } : {}),
        ...(f.city ? { city: f.city } : {}),
      })
      .where(eq(customers.id, cart.customerId));
    await refreshCustomerStats(cart.customerId, tx);
    return { order, lowStock: lowStock.filter((item) => item.stock <= business.lowStockThreshold) };
  });

  const { order } = result;
  log.info("order.created", { businessId, orderId: order.id, orderNumber: order.orderNumber, total: order.total, isTest: order.isTest });
  await audit(businessId, { name: "customer" }, "order.created", { type: "order", id: order.id }, { orderNumber: order.orderNumber, total: order.total });
  publish(businessId, { type: "order.created", orderId: order.id, orderNumber: order.orderNumber, total: order.total, currency: order.currency, isTest: order.isTest });
  if (!order.isTest) {
    await notify(businessId, {
      type: "new_order",
      title: `New order ${order.orderNumber}`,
      body: `${order.customerName || "Customer"} · ${formatMoney(order.total, order.currency)}`,
      link: `/dashboard/orders/${order.id}`,
    });
    for (const item of result.lowStock) {
      const [product] = await db.select({ name: products.name }).from(products).where(eq(products.id, item.productId));
      await notify(businessId, {
        type: "low_stock",
        title: item.stock <= 0 ? `${product?.name} is out of stock` : `${product?.name} is running low`,
        body: `${item.stock} left`,
        link: `/dashboard/products/${item.productId}`,
      });
    }
  }
  return order;
}

export async function getOrderForBusiness(businessId: string, orderId: string) {
  const db = await getDb();
  const [order] = await db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.businessId, businessId)));
  if (!order) throw notFound("Order not found");
  return order;
}

type NotifyResult = { notification: "sent" | "template" | "failed" | "skipped"; detail?: string };

/**
 * Tells the customer about a status change. Inside the 24-hour window a normal
 * message is sent; outside it, an approved template for that purpose is required.
 */
async function notifyCustomer(order: Order, status: OrderStatus): Promise<NotifyResult> {
  const key = statusMessageKey(status);
  if (!key || !order.conversationId) return { notification: "skipped" };
  const db = await getDb();
  const [conversation] = await db.select().from(conversations).where(eq(conversations.id, order.conversationId));
  const [customer] = await db.select().from(customers).where(eq(customers.id, order.customerId));
  const [business] = await db.select().from(businesses).where(eq(businesses.id, order.businessId));
  const [settings] = await db.select().from(botSettings).where(eq(botSettings.businessId, order.businessId));
  if (!conversation || !customer) return { notification: "skipped" };

  const vars: MessageVars = {
    customer_name: (order.customerName || customer.displayName || customer.profileName || "").split(" ")[0],
    order_id: order.orderNumber,
    total: formatMoney(order.total, order.currency),
    tracking: order.trackingNumber,
    business_name: business.name,
    status: STATUS_LABEL[status],
  };
  const body = renderMessage(settings?.statusMessages?.[key] || DEFAULT_STATUS_MESSAGES[key], vars);

  if (await canSendFreeform(order.businessId, conversation)) {
    const result = await deliver({
      businessId: order.businessId,
      conversationId: conversation.id,
      message: { kind: "text", text: body },
      sender: "system",
    });
    if (result.ok) return { notification: "sent" };
    if (result.reason !== "window_closed") return { notification: "failed", detail: result.error };
  }

  const [template] = await db
    .select()
    .from(whatsappTemplates)
    .where(and(eq(whatsappTemplates.businessId, order.businessId), eq(whatsappTemplates.purpose, key), eq(whatsappTemplates.status, "APPROVED")))
    .limit(1);
  if (!template) {
    const detail = `The customer's 24-hour window is closed and there is no approved "${key.replace("order_", "")}" template.`;
    await notify(order.businessId, {
      type: "message_failed",
      title: `Couldn't notify ${order.customerName || "the customer"} about ${order.orderNumber}`,
      body: detail,
      link: `/dashboard/whatsapp?tab=templates`,
    });
    return { notification: "failed", detail };
  }
  const variables = template.variables.map((name) => vars[name as keyof MessageVars] ?? "");
  const result = await deliver({
    businessId: order.businessId,
    conversationId: conversation.id,
    message: { kind: "template", name: template.name, language: template.language, variables, preview: body },
    sender: "system",
  });
  return result.ok ? { notification: "template" } : { notification: "failed", detail: result.error };
}

export async function changeOrderStatus(
  businessId: string,
  orderId: string,
  to: OrderStatus,
  actor: AuditActor,
  opts: { note?: string; trackingNumber?: string; notifyCustomer?: boolean } = {},
) {
  const order = await getOrderForBusiness(businessId, orderId);
  if (order.status === to) throw new ApiError(400, `The order is already ${STATUS_LABEL[to].toLowerCase()}.`);
  if (!STATUS_TRANSITIONS[order.status].includes(to)) {
    throw new ApiError(400, `An order can't go from ${STATUS_LABEL[order.status]} to ${STATUS_LABEL[to]}.`);
  }
  const db = await getDb();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(orders)
      .set({ status: to, ...(opts.trackingNumber !== undefined ? { trackingNumber: opts.trackingNumber.trim() } : {}) })
      .where(and(eq(orders.id, orderId), eq(orders.status, order.status)))
      .returning();
    if (!row) throw new ApiError(409, "The order was updated by someone else. Refresh and try again.");
    if (STOCK_RELEASING.includes(to) && !order.isTest) {
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
      await adjustStock(tx, items, 1);
    }
    await refreshCustomerStats(order.customerId, tx);
    return row;
  });

  const notification: NotifyResult =
    opts.notifyCustomer === false ? { notification: "skipped" } : await notifyCustomer(updated, to);
  await db.insert(orderStatusHistory).values({
    businessId,
    orderId,
    fromStatus: order.status,
    toStatus: to,
    changedByUserId: actor.userId ?? null,
    changedBy: actor.name,
    note: [opts.note?.trim(), notification.detail].filter(Boolean).join(" — "),
    notification: notification.notification,
  });

  log.info("order.status_changed", { businessId, orderId, from: order.status, to, notification: notification.notification });
  await audit(businessId, actor, "order.status_changed", { type: "order", id: orderId }, { from: order.status, to, notification: notification.notification });
  publish(businessId, { type: "order.updated", orderId, orderNumber: updated.orderNumber, status: to });
  return { order: updated, notification };
}

/** Latest orders for a customer — used by "Where is my order?" (spec §29). */
export async function customerOrders(businessId: string, customerId: string, limit = 5) {
  const db = await getDb();
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.businessId, businessId), eq(orders.customerId, customerId)))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}
