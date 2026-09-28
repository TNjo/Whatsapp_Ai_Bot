import "server-only";
import { fromDoc, fromDocs, store } from "@/db";
import type { Conversation, Customer, Message, WhatsAppTemplate } from "@/db/schema";
import { getOpenCart, viewCart } from "../commerce/cart";
import { customerOrders } from "../commerce/orders";
import { isWindowOpen, loadConversation, markConversationRead, setConversationAI, WINDOW_MS } from "../conversations";
import { ApiError } from "../http";
import { deliver } from "../outbound";
import { canSendFreeform } from "../whatsapp/channel";
import type { AuthContext } from "../auth";
import { audit } from "../audit";

export type InboxFilter = "all" | "human" | "unread" | "active" | "resolved";

const INBOX_WINDOW = 200;

/**
 * The most recent conversations (one indexed query), with status, unread and
 * text filters applied in memory — Firestore has no substring search.
 */
export async function listConversations(businessId: string, opts: { filter?: InboxFilter; q?: string; includeTest?: boolean; limit?: number } = {}) {
  const s = await store();
  let query = s.conversations(businessId).orderBy("lastMessageAt", "desc");
  if (!opts.includeTest) query = s.conversations(businessId).where("isTest", "==", false).orderBy("lastMessageAt", "desc");
  const conversations = fromDocs<Conversation>(await query.limit(INBOX_WINDOW).get());
  const customers = conversations.length ? await s.db.getAll(...conversations.map((c) => s.customers(businessId).doc(c.customerId))) : [];
  const byId = new Map(customers.map((snap) => [snap.id, fromDoc<Customer>(snap)]));
  const q = opts.q?.trim().toLowerCase();

  return conversations
    .map((c) => {
      const customer = byId.get(c.customerId);
      const name = customer?.displayName ?? "";
      const profileName = customer?.profileName ?? "";
      const phone = customer?.phone ?? "";
      return {
        id: c.id,
        status: c.status,
        aiEnabled: c.aiEnabled,
        unreadCount: c.unreadCount,
        lastMessageAt: c.lastMessageAt,
        lastMessagePreview: c.lastMessagePreview,
        lastInboundAt: c.lastInboundAt,
        handoffReason: c.handoffReason,
        isTest: c.isTest,
        customerId: c.customerId,
        name,
        profileName,
        phone,
        displayName: name || profileName || phone || "Customer",
        windowOpen: isWindowOpen(c.lastInboundAt),
      };
    })
    .filter((row) => {
      if (opts.filter === "human" && row.status !== "human_required") return false;
      if (opts.filter === "unread" && row.unreadCount === 0) return false;
      if (opts.filter === "active" && row.status !== "active") return false;
      if (opts.filter === "resolved" && row.status !== "resolved") return false;
      if (q && !`${row.name} ${row.profileName} ${row.phone} ${row.lastMessagePreview}`.toLowerCase().includes(q)) return false;
      return true;
    })
    .slice(0, opts.limit ?? 100);
}

export async function conversationMessages(businessId: string, conversationId: string, before?: Date, limit = 60) {
  const s = await store();
  let query = s.messages(businessId, conversationId).orderBy("createdAt", "desc");
  if (before) query = s.messages(businessId, conversationId).where("createdAt", "<", before).orderBy("createdAt", "desc");
  return fromDocs<Message>(await query.limit(limit).get()).reverse();
}

export async function conversationDetail(businessId: string, conversationId: string, { markRead = true } = {}) {
  const { conversation, customer } = await loadConversation(businessId, conversationId);
  if (markRead && conversation.unreadCount) await markConversationRead(businessId, conversationId);
  const s = await store();
  const [thread, recentOrders, cart, templates] = await Promise.all([
    conversationMessages(businessId, conversationId),
    customerOrders(businessId, customer.id, 5),
    getOpenCart(businessId, conversationId),
    s.templates(businessId).get().then((snap) => fromDocs<WhatsAppTemplate>(snap)),
  ]);
  const cartView = cart ? await viewCart(businessId, cart) : null;
  return {
    conversation: { ...conversation, unreadCount: 0 },
    customer,
    messages: thread,
    orders: recentOrders.map(({ id, orderNumber, status, total, currency, createdAt }) => ({ id, orderNumber, status, total, currency, createdAt })),
    draftOrder: cartView
      ? {
          stage: cartView.stage,
          items: cartView.items.map((i) => ({ name: i.name, quantity: i.quantity, options: i.options, lineTotal: i.lineTotal })),
          total: cartView.total,
          currency: cartView.currency,
          missing: cartView.missingFields.map((f) => f.label),
        }
      : null,
    windowOpen: await canSendFreeform(businessId, conversation),
    windowClosesAt: conversation.lastInboundAt ? new Date(conversation.lastInboundAt.getTime() + WINDOW_MS) : null,
    templates: templates
      .filter((t) => t.status === "APPROVED")
      .map(({ id, name, language, body, variables }) => ({ id, name, language, body, variables }))
      .sort((a, b) => a.name.localeCompare(b.name)),
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
    const s = await store();
    const template = fromDoc<WhatsAppTemplate>(await s.templates(businessId).doc(input.templateId).get());
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
