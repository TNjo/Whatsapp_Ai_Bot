import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  conversations,
  customers,
  messages,
  type MessagePayload,
  type MessageSender,
  type MessageType,
} from "@/db/schema";
import { audit, type AuditActor } from "./audit";
import { publish } from "./events";
import { notFound } from "./http";
import { notify } from "./notifications";

export const WINDOW_MS = 24 * 3600 * 1000;

/** WhatsApp's customer service window: free-form messages only within 24h of the customer's last message. */
export function isWindowOpen(lastInboundAt: Date | null | undefined, now = Date.now()) {
  return Boolean(lastInboundAt && now - lastInboundAt.getTime() < WINDOW_MS - 60_000);
}

export async function upsertCustomer(
  businessId: string,
  input: { waId: string; waChatId?: string; profileName?: string; isTest?: boolean },
): Promise<{ customer: typeof customers.$inferSelect; created: boolean }> {
  const db = await getDb();
  const now = new Date();
  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.waId, input.waId)));
  if (existing) {
    const [customer] = await db
      .update(customers)
      .set({
        lastInteractionAt: now,
        profileName: input.profileName || existing.profileName,
        displayName: existing.displayName || input.profileName || "",
        ...(input.waChatId && input.waChatId !== existing.waChatId ? { waChatId: input.waChatId } : {}),
      })
      .where(eq(customers.id, existing.id))
      .returning();
    return { customer, created: false };
  }
  const [customer] = await db
    .insert(customers)
    .values({
      businessId,
      waId: input.waId,
      waChatId: input.waChatId ?? null,
      // Only real numbers become a phone; test chats and hidden (@lid) contacts have none.
      phone: /^\d+$/.test(input.waId) ? `+${input.waId}` : "",
      profileName: input.profileName ?? "",
      displayName: input.profileName ?? "",
      isTest: Boolean(input.isTest),
      firstInteractionAt: now,
      lastInteractionAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!customer) return upsertCustomer(businessId, input); // lost a race; read the winner
  return { customer, created: true };
}

export async function getOrCreateConversation(businessId: string, customerId: string, isTest = false) {
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.customerId, customerId)));
  if (existing) return { conversation: existing, created: false };
  const [conversation] = await db
    .insert(conversations)
    .values({ businessId, customerId, isTest })
    .onConflictDoNothing()
    .returning();
  if (!conversation) return getOrCreateConversation(businessId, customerId, isTest);
  return { conversation, created: true };
}

export type InboundInput = {
  waMessageId?: string | null;
  type: MessageType;
  content: string;
  payload?: MessagePayload;
  timestamp?: Date;
};

/**
 * Stores a customer message. Returns null for duplicates (WhatsApp retries
 * webhooks), so callers never process the same message twice.
 */
export async function saveInboundMessage(businessId: string, conversationId: string, input: InboundInput) {
  const db = await getDb();
  const at = input.timestamp ?? new Date();
  const [message] = await db
    .insert(messages)
    .values({
      businessId,
      conversationId,
      direction: "inbound",
      sender: "customer",
      type: input.type,
      content: input.content,
      payload: input.payload ?? {},
      waMessageId: input.waMessageId ?? null,
      status: "received",
      createdAt: at,
    })
    .onConflictDoNothing()
    .returning();
  if (!message) return null;
  const [conversation] = await db
    .update(conversations)
    .set({
      lastInboundAt: at,
      lastMessageAt: at,
      lastMessagePreview: preview(input.content, input.type),
      unreadCount: sql`${conversations.unreadCount} + 1`,
      status: sql`case when ${conversations.status} = 'resolved' then 'active' else ${conversations.status} end`,
    })
    .where(eq(conversations.id, conversationId))
    .returning();
  publish(businessId, { type: "message.created", conversationId, messageId: message.id, direction: "inbound" });
  publish(businessId, { type: "conversation.updated", conversationId });
  return { message, conversation };
}

export function preview(content: string, type: MessageType = "text") {
  const text = content.replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 140);
  return type === "text" ? "" : `[${type}]`;
}

export async function insertOutboundRecord(
  businessId: string,
  conversationId: string,
  input: { sender: MessageSender; type: MessageType; content: string; payload?: MessagePayload; sentByUserId?: string | null },
) {
  const db = await getDb();
  const [message] = await db
    .insert(messages)
    .values({
      businessId,
      conversationId,
      direction: "outbound",
      sender: input.sender,
      type: input.type,
      content: input.content,
      payload: input.payload ?? {},
      status: "pending",
      sentByUserId: input.sentByUserId ?? null,
    })
    .returning();
  await db
    .update(conversations)
    .set({ lastMessageAt: message.createdAt, lastMessagePreview: preview(input.content, input.type) })
    .where(eq(conversations.id, conversationId));
  return message;
}

export async function loadConversation(businessId: string, conversationId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ conversation: conversations, customer: customers })
    .from(conversations)
    .innerJoin(customers, eq(customers.id, conversations.customerId))
    .where(and(eq(conversations.id, conversationId), eq(conversations.businessId, businessId)));
  if (!row) throw notFound("Conversation not found");
  return row;
}

export async function setConversationAI(businessId: string, conversationId: string, enabled: boolean, actor: AuditActor) {
  const db = await getDb();
  const [row] = await db
    .update(conversations)
    .set(
      enabled
        ? { aiEnabled: true, status: "active", handoffReason: null }
        : { aiEnabled: false },
    )
    .where(and(eq(conversations.id, conversationId), eq(conversations.businessId, businessId)))
    .returning();
  if (!row) throw notFound("Conversation not found");
  await audit(businessId, actor, enabled ? "conversation.ai_resumed" : "conversation.ai_paused", { type: "conversation", id: conversationId });
  publish(businessId, { type: "conversation.updated", conversationId });
  return row;
}

export async function setConversationStatus(
  businessId: string,
  conversationId: string,
  status: "active" | "resolved",
  actor: AuditActor,
) {
  const db = await getDb();
  const [row] = await db
    .update(conversations)
    .set(status === "resolved" ? { status, unreadCount: 0, handoffReason: null } : { status })
    .where(and(eq(conversations.id, conversationId), eq(conversations.businessId, businessId)))
    .returning();
  if (!row) throw notFound("Conversation not found");
  await audit(businessId, actor, `conversation.${status}`, { type: "conversation", id: conversationId });
  publish(businessId, { type: "conversation.updated", conversationId });
  return row;
}

export async function markConversationRead(businessId: string, conversationId: string) {
  const db = await getDb();
  await db
    .update(conversations)
    .set({ unreadCount: 0 })
    .where(and(eq(conversations.id, conversationId), eq(conversations.businessId, businessId)));
}

/** Human handoff (spec §31): flags the conversation, pauses the AI and alerts the owner. */
export async function requestHumanSupport(businessId: string, conversationId: string, reason: string) {
  const db = await getDb();
  const [row] = await db
    .update(conversations)
    .set({ status: "human_required", aiEnabled: false, handoffReason: reason.slice(0, 300) })
    .where(and(eq(conversations.id, conversationId), eq(conversations.businessId, businessId)))
    .returning();
  if (!row) return;
  const { customer } = await loadConversation(businessId, conversationId);
  publish(businessId, { type: "conversation.updated", conversationId });
  await notify(businessId, {
    type: "human_support",
    title: `${customer.displayName || customer.phone || "A customer"} needs a team member`,
    body: reason.slice(0, 200),
    link: `/dashboard/conversations?c=${conversationId}`,
  });
  await audit(businessId, { name: "ai" }, "conversation.handoff", { type: "conversation", id: conversationId }, { reason });
}
