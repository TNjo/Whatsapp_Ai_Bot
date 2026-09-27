import "server-only";
import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { conversations, customers, orderItems, orders } from "@/db/schema";
import { REVENUE_STATUSES } from "@/lib/order-status";
import { audit, type AuditActor } from "../audit";
import { cleanText, notFound } from "../http";

export const CUSTOMERS_PAGE_SIZE = 25;

const optionalEmail = cleanText(200).pipe(z.union([z.literal(""), z.email("Enter a valid email")]));

export const CustomerInput = z.object({
  displayName: cleanText(120).default(""),
  email: optionalEmail.default(""),
  address: cleanText(500).default(""),
  city: cleanText(120).default(""),
  notes: cleanText(5000).default(""),
});

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** Escapes LIKE wildcards so a search for "50%" matches literally. */
const likeTerm = (value: string) => `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listCustomers(businessId: string, options: { query?: string; page?: number } = {}) {
  const db = await getDb();
  const q = (options.query ?? "").trim().slice(0, 100);
  const page = Math.max(1, Math.floor(options.page ?? 1) || 1);
  const digits = q.replace(/\D/g, "");

  const search = q
    ? or(
        ilike(customers.displayName, likeTerm(q)),
        ilike(customers.profileName, likeTerm(q)),
        ilike(customers.phone, likeTerm(q)),
        digits.length >= 3 ? ilike(customers.waId, likeTerm(digits)) : undefined,
      )
    : undefined;
  const where = and(eq(customers.businessId, businessId), eq(customers.isTest, false), search);

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: customers.id,
        phone: customers.phone,
        profileName: customers.profileName,
        displayName: customers.displayName,
        totalOrders: customers.totalOrders,
        totalSpent: customers.totalSpent,
        firstInteractionAt: customers.firstInteractionAt,
        lastInteractionAt: customers.lastInteractionAt,
      })
      .from(customers)
      .where(where)
      .orderBy(desc(customers.lastInteractionAt), desc(customers.id))
      .limit(CUSTOMERS_PAGE_SIZE)
      .offset((page - 1) * CUSTOMERS_PAGE_SIZE),
    db.select({ total: count() }).from(customers).where(where),
  ]);

  return { customers: rows, total, page, pageSize: CUSTOMERS_PAGE_SIZE };
}

export type CustomerListRow = Awaited<ReturnType<typeof listCustomers>>["customers"][number];

export async function getCustomer(businessId: string, id: string) {
  if (!isUuid(id)) return null;
  const db = await getDb();
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), eq(customers.businessId, businessId)))
    .limit(1);
  if (!customer) return null;

  const itemCounts = db
    .select({ orderId: orderItems.orderId, items: sql<number>`coalesce(sum(${orderItems.quantity}), 0)::int`.as("items") })
    .from(orderItems)
    .where(eq(orderItems.businessId, businessId))
    .groupBy(orderItems.orderId)
    .as("item_counts");

  const [history, [conversation]] = await Promise.all([
    db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        total: orders.total,
        currency: orders.currency,
        isTest: orders.isTest,
        createdAt: orders.createdAt,
        items: sql<number>`coalesce(${itemCounts.items}, 0)`,
      })
      .from(orders)
      .leftJoin(itemCounts, eq(itemCounts.orderId, orders.id))
      .where(and(eq(orders.businessId, businessId), eq(orders.customerId, id)))
      .orderBy(desc(orders.createdAt)),
    db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.businessId, businessId), eq(conversations.customerId, id)))
      .limit(1),
  ]);

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
    conversationId: conversation?.id ?? null,
    orders: history.map((o) => ({ ...o, items: Number(o.items) })),
    stats,
  };
}

export type CustomerDetail = NonNullable<Awaited<ReturnType<typeof getCustomer>>>;

export async function updateCustomer(businessId: string, id: string, input: Partial<z.infer<typeof CustomerInput>>, actor: AuditActor) {
  if (!isUuid(id)) throw notFound("Customer not found");
  const db = await getDb();
  if (!Object.keys(input).length) {
    const [row] = await db.select().from(customers).where(and(eq(customers.id, id), eq(customers.businessId, businessId)));
    if (!row) throw notFound("Customer not found");
    return row;
  }
  const [row] = await db
    .update(customers)
    .set(input)
    .where(and(eq(customers.id, id), eq(customers.businessId, businessId)))
    .returning();
  if (!row) throw notFound("Customer not found");
  await audit(businessId, actor, "customer.updated", { type: "customer", id }, { fields: Object.keys(input) });
  return row;
}
