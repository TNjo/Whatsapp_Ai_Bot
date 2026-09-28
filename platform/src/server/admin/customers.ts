import "server-only";
import { z } from "zod";
import { fromDoc, fromDocs, store } from "@/db";
import type { Customer, Order } from "@/db/schema";
import { REVENUE_STATUSES } from "@/lib/order-status";
import { audit, type AuditActor } from "../audit";
import { cleanText, docId, notFound } from "../http";

export const CUSTOMERS_PAGE_SIZE = 25;

const optionalEmail = cleanText(200).pipe(z.union([z.literal(""), z.email("Enter a valid email")]));

export const CustomerInput = z.object({
  displayName: cleanText(120).default(""),
  email: optionalEmail.default(""),
  address: cleanText(500).default(""),
  city: cleanText(120).default(""),
  notes: cleanText(5000).default(""),
});

/** Customer ids are WhatsApp ids ("94771234567", or "test-…" for test chats). */
const isCustomerId = (value: string) => docId.safeParse(value).success;

/**
 * Customer lists per business are small enough to read in one query (ordered by
 * last interaction, so no composite index is needed); search and paging run in memory.
 */
export async function listCustomers(businessId: string, options: { query?: string; page?: number } = {}) {
  const s = await store();
  const q = (options.query ?? "").trim().slice(0, 100);
  const page = Math.max(1, Math.floor(options.page ?? 1) || 1);
  const needle = q.toLowerCase();
  const digits = q.replace(/\D/g, "");

  const all = fromDocs<Customer>(await s.customers(businessId).orderBy("lastInteractionAt", "desc").get());
  const matches = all
    .filter((c) => !c.isTest)
    .filter(
      (c) =>
        !needle ||
        [c.displayName, c.profileName, c.phone].some((text) => (text ?? "").toLowerCase().includes(needle)) ||
        (digits.length >= 3 && c.waId.includes(digits)),
    )
    .sort((a, b) => b.lastInteractionAt.getTime() - a.lastInteractionAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  const rows = matches.slice((page - 1) * CUSTOMERS_PAGE_SIZE, page * CUSTOMERS_PAGE_SIZE).map((c) => ({
    id: c.id,
    phone: c.phone,
    profileName: c.profileName,
    displayName: c.displayName,
    totalOrders: c.totalOrders,
    totalSpent: c.totalSpent,
    firstInteractionAt: c.firstInteractionAt,
    lastInteractionAt: c.lastInteractionAt,
  }));

  return { customers: rows, total: matches.length, page, pageSize: CUSTOMERS_PAGE_SIZE };
}

export type CustomerListRow = Awaited<ReturnType<typeof listCustomers>>["customers"][number];

export async function getCustomer(businessId: string, id: string) {
  if (!isCustomerId(id)) return null;
  const s = await store();
  const customer = fromDoc<Customer>(await s.customers(businessId).doc(id).get());
  if (!customer) return null;

  const [orderRows, conversation] = await Promise.all([
    // Composite index: orders (customerId, createdAt desc).
    s.orders(businessId).where("customerId", "==", id).orderBy("createdAt", "desc").get().then((snap) => fromDocs<Order>(snap)),
    // conversations/{customerId}: one conversation per customer.
    s.conversations(businessId).doc(id).get(),
  ]);

  const history = orderRows.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    total: o.total,
    currency: o.currency,
    isTest: o.isTest,
    createdAt: o.createdAt,
    items: (o.items ?? []).reduce((sum, item) => sum + item.quantity, 0),
  }));

  const real = history.filter((o) => !o.isTest);
  const stats = {
    totalOrders: real.length,
    completed: real.filter((o) => o.status === "COMPLETED").length,
    pending: real.filter((o) => o.status === "PENDING").length,
    cancelled: real.filter((o) => o.status === "CANCELLED" || o.status === "REJECTED").length,
    totalSpent: real.filter((o) => REVENUE_STATUSES.includes(o.status)).reduce((sum, o) => sum + o.total, 0),
  };

  return {
    customer,
    conversationId: conversation.exists ? conversation.id : null,
    orders: history,
    stats,
  };
}

export type CustomerDetail = NonNullable<Awaited<ReturnType<typeof getCustomer>>>;

export async function updateCustomer(businessId: string, id: string, input: Partial<z.infer<typeof CustomerInput>>, actor: AuditActor) {
  if (!isCustomerId(id)) throw notFound("Customer not found");
  const s = await store();
  const ref = s.customers(businessId).doc(id);
  const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const row = await s.db.runTransaction(async (tx) => {
    const current = fromDoc<Customer>(await tx.get(ref));
    if (!current) throw notFound("Customer not found");
    if (!Object.keys(fields).length) return current;
    const patch = { ...fields, updatedAt: new Date() };
    tx.update(ref, patch);
    return { ...current, ...patch } as Customer;
  });
  if (Object.keys(fields).length) {
    await audit(businessId, actor, "customer.updated", { type: "customer", id }, { fields: Object.keys(fields) });
  }
  return row;
}
