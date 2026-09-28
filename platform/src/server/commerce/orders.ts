import "server-only";
import type { Transaction } from "firebase-admin/firestore";
import { fromDoc, fromDocs, newId, store } from "@/db";
import type { BotSettings, Business, Conversation, Customer, Order, OrderItem, OrderStatusChange, Product, WhatsAppTemplate } from "@/db/schema";
import { formatMoney } from "@/lib/format";
import { REVENUE_STATUSES, STATUS_LABEL, STATUS_TRANSITIONS, STOCK_RELEASING, type OrderStatus } from "@/lib/order-status";
import { audit, type AuditActor } from "../audit";
import { publish } from "../events";
import { ApiError, notFound } from "../http";
import { log } from "../logger";
import { notify } from "../notifications";
import { deliver } from "../outbound";
import { canSendFreeform } from "../whatsapp/channel";
import { viewCart, type Cart, type CartView } from "./cart";
import { getOrderFields, SYSTEM_KEYS } from "./order-form";
import { DEFAULT_STATUS_MESSAGES, renderMessage, statusMessageKey, type MessageVars } from "./status-messages";

export type { Order };

export class OrderError extends Error {}

/** Recomputes the stored totals on the customer record (spec §9). Test orders don't count. */
export async function refreshCustomerStats(businessId: string, customerId: string) {
  const s = await store();
  const rows = fromDocs<Order>(await s.orders(businessId).where("customerId", "==", customerId).get()).filter((o) => !o.isTest);
  await s
    .customers(businessId)
    .doc(customerId)
    .update({
      totalOrders: rows.length,
      totalSpent: rows.filter((o) => REVENUE_STATUSES.includes(o.status)).reduce((sum, o) => sum + o.total, 0),
      updatedAt: new Date(),
    })
    .catch(() => undefined);
}

type StockLine = { productId: string | null; variantId: string | null; quantity: number };

/**
 * Reads the products for a stock change inside a transaction (Firestore needs all
 * reads before writes), returns the writes to apply and the resulting stock levels.
 */
async function planStock(tx: Transaction, businessId: string, lines: StockLine[], direction: -1 | 1) {
  const s = await store();
  const ids = [...new Set(lines.map((l) => l.productId).filter((id): id is string => Boolean(id)))];
  const snaps = ids.length ? await tx.getAll(...ids.map((id) => s.products(businessId).doc(id))) : [];
  const products = new Map(snaps.map((snap) => [snap.id, fromDoc<Product>(snap)]));
  const changed = new Map<string, Product>();
  const levels: { productId: string; name: string; stock: number }[] = [];

  for (const line of lines) {
    if (!line.productId) continue;
    const product = changed.get(line.productId) ?? products.get(line.productId);
    if (!product || !product.trackStock) continue;
    const delta = direction * line.quantity;
    let next: Product;
    if (line.variantId) {
      const variant = product.variants.find((v) => v.id === line.variantId);
      if (!variant || (direction < 0 && variant.stock < line.quantity)) {
        throw new OrderError(`Sorry, ${product.name} is now out of stock in that option.`);
      }
      const variants = product.variants.map((v) => (v.id === line.variantId ? { ...v, stock: v.stock + delta } : v));
      next = { ...product, variants, stock: variants.reduce((sum, v) => sum + v.stock, 0) };
      levels.push({ productId: product.id, name: product.name, stock: variant.stock + delta });
    } else {
      if (direction < 0 && product.stock < line.quantity) throw new OrderError(`Sorry, ${product.name} is now out of stock.`);
      next = { ...product, stock: product.stock + delta };
      levels.push({ productId: product.id, name: product.name, stock: next.stock });
    }
    changed.set(product.id, next);
  }
  const apply = () => {
    for (const product of changed.values()) {
      tx.update(s.products(businessId).doc(product.id), { variants: product.variants, stock: product.stock, updatedAt: new Date() });
    }
  };
  return { apply, levels };
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

  const s = await store();
  const fieldDefs = await getOrderFields(businessId);
  const labels = new Map(fieldDefs.map((field) => [field.key, field.label]));
  const f = view.fields;
  const orderId = newId();

  const { order, lowStock } = await s.db.runTransaction(async (tx) => {
    const businessRef = s.businesses.doc(businessId);
    const cartRef = s.carts(businessId).doc(cart.id);
    const [businessSnap, cartSnap] = await tx.getAll(businessRef, cartRef);
    const business = fromDoc<Business>(businessSnap)!;
    if (!cartSnap.exists) throw new OrderError("The order was already placed or cancelled.");
    const stock = opts.isTest
      ? { apply: () => undefined, levels: [] }
      : await planStock(
          tx,
          businessId,
          view.items.map((item) => ({ productId: item.kind === "product" ? item.refId : null, variantId: item.variantId, quantity: item.quantity })),
          -1,
        );

    // Test orders never consume the real ORD- sequence.
    const orderNumber = opts.isTest ? `TEST-${Math.floor(10000 + Math.random() * 90000)}` : `ORD-${business.nextOrderNumber}`;
    const now = new Date();
    const items: OrderItem[] = view.items.map((item) => ({
      id: newId(),
      productId: item.kind === "product" ? item.refId : null,
      serviceId: item.kind === "service" ? item.refId : null,
      variantId: item.variantId,
      name: item.name,
      optionValues: item.options,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    }));
    const created: Order = {
      id: orderId,
      businessId,
      orderNumber,
      customerId: cart.customerId,
      conversationId: cart.conversationId,
      status: "PENDING",
      currency: business.currency,
      subtotal: view.subtotal,
      deliveryFee: view.deliveryFee,
      discount: 0,
      total: view.total,
      customerName: f.name ?? "",
      customerPhone: f.phone ?? "",
      deliveryAddress: f.address ?? "",
      city: f.city ?? "",
      paymentMethod: f.payment_method ?? "",
      customerNote: f.note ?? "",
      internalNotes: "",
      trackingNumber: "",
      isTest: opts.isTest,
      items,
      customFields: Object.entries(f)
        .filter(([key, value]) => !SYSTEM_KEYS.has(key) && value)
        .map(([key, value]) => ({ key, label: labels.get(key) ?? key, value })),
      history: [
        {
          id: newId(),
          fromStatus: null,
          toStatus: "PENDING",
          changedByUserId: null,
          changedBy: "Customer (WhatsApp)",
          note: "Order placed after customer confirmation",
          notification: "skipped",
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    // Writes (after every read).
    stock.apply();
    if (!opts.isTest) tx.update(businessRef, { nextOrderNumber: business.nextOrderNumber + 1, updatedAt: now });
    const { id: _id, ...doc } = created;
    void _id;
    tx.create(s.orders(businessId).doc(orderId), doc);
    tx.delete(cartRef);
    // Remember delivery details for next time.
    tx.update(s.customers(businessId).doc(cart.customerId), {
      ...(f.name ? { displayName: f.name } : {}),
      ...(f.address ? { address: f.address } : {}),
      ...(f.city ? { city: f.city } : {}),
      updatedAt: now,
    });
    return { order: created, lowStock: stock.levels.filter((item) => item.stock <= business.lowStockThreshold) };
  });

  await refreshCustomerStats(businessId, cart.customerId);
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
    for (const item of lowStock) {
      await notify(businessId, {
        type: "low_stock",
        title: item.stock <= 0 ? `${item.name} is out of stock` : `${item.name} is running low`,
        body: `${item.stock} left`,
        link: `/dashboard/products/${item.productId}`,
      });
    }
  }
  return order;
}

export async function getOrderForBusiness(businessId: string, orderId: string) {
  const s = await store();
  const order = fromDoc<Order>(await s.orders(businessId).doc(orderId).get());
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
  const s = await store();
  const [conversationSnap, customerSnap, businessSnap, settingsSnap] = await s.db.getAll(
    s.conversations(order.businessId).doc(order.conversationId),
    s.customers(order.businessId).doc(order.customerId),
    s.businesses.doc(order.businessId),
    s.bot(order.businessId),
  );
  const conversation = fromDoc<Conversation>(conversationSnap);
  const customer = fromDoc<Customer>(customerSnap);
  const business = fromDoc<Business>(businessSnap)!;
  const settings = fromDoc<BotSettings & { id: string }>(settingsSnap);
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
    const result = await deliver({ businessId: order.businessId, conversationId: conversation.id, message: { kind: "text", text: body }, sender: "system" });
    if (result.ok) return { notification: "sent" };
    if (result.reason !== "window_closed") return { notification: "failed", detail: result.error };
  }

  const [template] = fromDocs<WhatsAppTemplate>(await s.templates(order.businessId).where("purpose", "==", key).get()).filter(
    (t) => t.status === "APPROVED",
  );
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
  const s = await store();
  const ref = s.orders(businessId).doc(orderId);
  const { before, updated } = await s.db.runTransaction(async (tx) => {
    const order = fromDoc<Order>(await tx.get(ref));
    if (!order) throw notFound("Order not found");
    if (order.status === to) throw new ApiError(400, `The order is already ${STATUS_LABEL[to].toLowerCase()}.`);
    if (!STATUS_TRANSITIONS[order.status].includes(to)) {
      throw new ApiError(400, `An order can't go from ${STATUS_LABEL[order.status]} to ${STATUS_LABEL[to]}.`);
    }
    const stock = STOCK_RELEASING.includes(to) && !order.isTest ? await planStock(tx, businessId, order.items, 1) : null;
    const next: Order = {
      ...order,
      status: to,
      ...(opts.trackingNumber !== undefined ? { trackingNumber: opts.trackingNumber.trim() } : {}),
      updatedAt: new Date(),
    };
    stock?.apply();
    tx.update(ref, { status: next.status, trackingNumber: next.trackingNumber, updatedAt: next.updatedAt });
    return { before: order, updated: next };
  });
  await refreshCustomerStats(businessId, before.customerId);

  const notification: NotifyResult = opts.notifyCustomer === false ? { notification: "skipped" } : await notifyCustomer(updated, to);
  const change: OrderStatusChange = {
    id: newId(),
    fromStatus: before.status,
    toStatus: to,
    changedByUserId: actor.userId ?? null,
    changedBy: actor.name,
    note: [opts.note?.trim(), notification.detail].filter(Boolean).join(" — "),
    notification: notification.notification,
    createdAt: new Date(),
  };
  await s.db.runTransaction(async (tx) => {
    const current = fromDoc<Order>(await tx.get(ref));
    if (current) tx.update(ref, { history: [...current.history, change] });
  });

  log.info("order.status_changed", { businessId, orderId, from: before.status, to, notification: notification.notification });
  await audit(businessId, actor, "order.status_changed", { type: "order", id: orderId }, { from: before.status, to, notification: notification.notification });
  publish(businessId, { type: "order.updated", orderId, orderNumber: updated.orderNumber, status: to });
  return { order: { ...updated, history: [...updated.history, change] }, notification };
}

/** Latest orders for a customer — used by "Where is my order?" (spec §29). */
export async function customerOrders(businessId: string, customerId: string, limit = 5) {
  const s = await store();
  return fromDocs<Order>(await s.orders(businessId).where("customerId", "==", customerId).orderBy("createdAt", "desc").limit(limit).get());
}
