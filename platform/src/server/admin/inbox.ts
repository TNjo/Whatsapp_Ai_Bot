import "server-only";
import { and, asc, desc, eq, gt, ilike, lt, or, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { conversations, customers, messages, orders, whatsappTemplates } from "@/db/schema";
import { getOpenCart, viewCart } from "../commerce/cart";
import { isWindowOpen, loadConversation, markConversationRead, setConversationAI, WINDOW_MS } from "../conversations";
import { ApiError } from "../http";
import { deliver } from "../outbound";
import type { AuthContext } from "../auth";
import { audit } from "../audit";

export type InboxFilter = "all" | "human" | "unread" | "active" | "resolved";

export async function listConversations(businessId: string, opts: { filter?: InboxFilter; q?: string; includeTest?: boolean; limit?: number } = {}) {
  const db = await getDb();
  const where: SQL[] = [eq(conversations.businessId, businessId)];
  if (!opts.includeTest) where.push(eq(conversations.isTest, false));
  if (opts.filter === "human") where.push(eq(conversations.status, "human_required"));
  if (opts.filter === "unread") where.push(gt(conversations.unreadCount, 0));
  if (opts.filter === "active") where.push(eq(conversations.status, "active"));
  if (opts.filter === "resolved") where.push(eq(conversations.status, "resolved"));
  const q = opts.q?.trim();
  if (q) {
    where.push(
      or(
        ilike(customers.displayName, `%${q}%`),
        ilike(customers.profileName, `%${q}%`),
        ilike(customers.phone, `%${q}%`),
        ilike(conversations.lastMessagePreview, `%${q}%`),
      )!,
    );
  }
  const rows = await db
    .select({
      id: conversations.id,
      status: conversations.status,
      aiEnabled: conversations.aiEnabled,
      unreadCount: conversations.unreadCount,
      lastMessageAt: conversations.lastMessageAt,
      lastMessagePreview: conversations.lastMessagePreview,
      lastInboundAt: conversations.lastInboundAt,
      handoffReason: conversations.handoffReason,
      isTest: conversations.isTest,
      customerId: customers.id,
      name: customers.displayName,
      profileName: customers.profileName,
      phone: customers.phone,
    })
    .from(conversations)
    .innerJoin(customers, eq(customers.id, conversations.customerId))
    .where(and(...where))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(opts.limit ?? 100);
  return rows.map((row) => ({
    ...row,
    displayName: row.name || row.profileName || row.phone || "Customer",
    windowOpen: isWindowOpen(row.lastInboundAt),
  }));
}

export async function conversationMessages(businessId: string, conversationId: string, before?: Date, limit = 60) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.businessId, businessId), before ? lt(messages.createdAt, before) : undefined))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function conversationDetail(businessId: string, conversationId: string, { markRead = true } = {}) {
  const { conversation, customer } = await loadConversation(businessId, conversationId);
  if (markRead && conversation.unreadCount) await markConversationRead(businessId, conversationId);
  const db = await getDb();
  const [thread, recentOrders, cart, templates] = await Promise.all([
    conversationMessages(businessId, conversationId),
    db
      .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, total: orders.total, currency: orders.currency, createdAt: orders.createdAt })
      .from(orders)
      .where(and(eq(orders.businessId, businessId), eq(orders.customerId, customer.id)))
      .orderBy(desc(orders.createdAt))
      .limit(5),
    getOpenCart(businessId, conversationId),
    db
      .select({ id: whatsappTemplates.id, name: whatsappTemplates.name, language: whatsappTemplates.language, body: whatsappTemplates.body, variables: whatsappTemplates.variables })
      .from(whatsappTemplates)
      .where(and(eq(whatsappTemplates.businessId, businessId), eq(whatsappTemplates.status, "APPROVED")))
      .orderBy(asc(whatsappTemplates.name)),
  ]);
  const cartView = cart ? await viewCart(businessId, cart) : null;
  return {
    conversation: { ...conversation, unreadCount: 0 },
    customer,
    messages: thread,
    orders: recentOrders,
    draftOrder: cartView
      ? {
          stage: cartView.stage,
          items: cartView.items.map((i) => ({ name: i.name, quantity: i.quantity, options: i.options, lineTotal: i.lineTotal })),
          total: cartView.total,
          currency: cartView.currency,
          missing: cartView.missingFields.map((f) => f.label),
        }
      : null,
    windowOpen: conversation.isTest || isWindowOpen(conversation.lastInboundAt),
    windowClosesAt: conversation.lastInboundAt ? new Date(conversation.lastInboundAt.getTime() + WINDOW_MS) : null,
    templates,
  };
}

/**
 * Manual reply from the team (spec §30/31). Taking over pauses the AI for this
 * conversation so it doesn't talk over the human.
 */
export async function sendManualReply(
  auth: AuthContext,
  conversationId: string,
  input: { text?: string; templateId?: string; variables?: string[] },
) {
  const businessId = auth.business.id;
  const { conversation } = await loadConversation(businessId, conversationId);
  let aiPaused = false;
  if (conversation.aiEnabled) {
    await setConversationAI(businessId, conversationId, false, auth.actor);
    aiPaused = true;
  }

  if (input.templateId) {
    const db = await getDb();
    const [template] = await db
      .select()
      .from(whatsappTemplates)
      .where(and(eq(whatsappTemplates.id, input.templateId), eq(whatsappTemplates.businessId, businessId)));
    if (!template || template.status !== "APPROVED") throw new ApiError(400, "Choose an approved template.");
    const variables = template.variables.map((_, i) => input.variables?.[i] ?? "");
    let preview = template.body;
    variables.forEach((value, i) => (preview = preview.replaceAll(`{{${i + 1}}}`, value)));
    const result = await deliver({
      businessId,
      conversationId,
      message: { kind: "template", name: template.name, language: template.language, variables, preview },
      sender: "agent",
      userId: auth.user.id,
    });
    await audit(businessId, auth.actor, "message.sent_template", { type: "conversation", id: conversationId }, { template: template.name, ok: result.ok });
    return { result, aiPaused };
  }

  const text = input.text?.trim();
  if (!text) throw new ApiError(400, "Write a message first.");
  const result = await deliver({ businessId, conversationId, message: { kind: "text", text }, sender: "agent", userId: auth.user.id });
  await audit(businessId, auth.actor, "message.sent_manual", { type: "conversation", id: conversationId }, { ok: result.ok });
  return { result, aiPaused };
}
