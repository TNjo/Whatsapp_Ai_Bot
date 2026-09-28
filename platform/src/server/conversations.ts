import "server-only";
import { fromDoc, keyId, newId, store } from "@/db";
import type { Conversation, Customer, Message, MessagePayload, MessageSender, MessageType } from "@/db/schema";
import { audit, type AuditActor } from "./audit";
import { publish } from "./events";
import { notFound } from "./http";
import { notify } from "./notifications";

export const WINDOW_MS = 24 * 3600 * 1000;

/** WhatsApp's customer service window: free-form messages only within 24h of the customer's last message. */
export function isWindowOpen(lastInboundAt: Date | null | undefined, now = Date.now()) {
  return Boolean(lastInboundAt && now - lastInboundAt.getTime() < WINDOW_MS - 60_000);
}

/** customers/{waId}: the WhatsApp id is the document id, so a customer can't be created twice. */
export async function upsertCustomer(
  businessId: string,
  input: { waId: string; profileName?: string; isTest?: boolean },
): Promise<{ customer: Customer; created: boolean }> {
  const s = await store();
  const ref = s.customers(businessId).doc(input.waId);
  return s.db.runTransaction(async (tx) => {
    const existing = fromDoc<Customer>(await tx.get(ref));
    const now = new Date();
    if (existing) {
      const patch = {
        lastInteractionAt: now,
        profileName: input.profileName || existing.profileName,
        displayName: existing.displayName || input.profileName || "",
        updatedAt: now,
      };
      tx.update(ref, patch);
      return { customer: { ...existing, ...patch }, created: false };
    }
    const customer: Customer = {
      id: input.waId,
      businessId,
      waId: input.waId,
      // Only real numbers become a phone; test chats have none.
      phone: /^\d+$/.test(input.waId) ? `+${input.waId}` : "",
      profileName: input.profileName ?? "",
      displayName: input.profileName ?? "",
      email: "",
      address: "",
      city: "",
      notes: "",
      isTest: Boolean(input.isTest),
      totalOrders: 0,
      totalSpent: 0,
      firstInteractionAt: now,
      lastInteractionAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const { id: _id, ...doc } = customer;
    void _id;
    tx.create(ref, doc);
    return { customer, created: true };
  });
}

/** conversations/{customerId}: one conversation per customer. */
export async function getOrCreateConversation(businessId: string, customerId: string, isTest = false) {
  const s = await store();
  const ref = s.conversations(businessId).doc(customerId);
  return s.db.runTransaction(async (tx) => {
    const existing = fromDoc<Conversation>(await tx.get(ref));
    if (existing) return { conversation: existing, created: false };
    const now = new Date();
    const conversation: Conversation = {
      id: customerId,
      businessId,
      customerId,
      status: "active",
      aiEnabled: true,
      handoffReason: null,
      topic: "",
      isTest,
      unreadCount: 0,
      lastMessageAt: now,
      lastMessagePreview: "",
      lastInboundAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const { id: _id, ...doc } = conversation;
    void _id;
    tx.create(ref, doc);
    return { conversation, created: true };
  });
}

export type InboundInput = {
  waMessageId?: string | null;
  type: MessageType;
  content: string;
  payload?: MessagePayload;
  timestamp?: Date;
};

export function preview(content: string, type: MessageType = "text") {
  const text = content.replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 140);
  return type === "text" ? "" : `[${type}]`;
}

/**
 * Stores a customer message. Returns null for duplicates (WhatsApp retries
 * webhooks): the WhatsApp id is claimed in the same transaction as the write.
 */
export async function saveInboundMessage(businessId: string, conversationId: string, input: InboundInput) {
  const s = await store();
  const at = input.timestamp ?? new Date();
  const messageId = newId();
  const conversationRef = s.conversations(businessId).doc(conversationId);
  const indexRef = input.waMessageId ? s.waMessages(businessId).doc(keyId(input.waMessageId)) : null;
  const message: Message = {
    id: messageId,
    businessId,
    conversationId,
    direction: "inbound",
    sender: "customer",
    type: input.type,
    content: input.content,
    payload: input.payload ?? {},
    waMessageId: input.waMessageId ?? null,
    status: "received",
    errorMessage: null,
    sentByUserId: null,
    statusUpdatedAt: null,
    createdAt: at,
  };
  const conversation = await s.db.runTransaction(async (tx) => {
    const [conversationSnap, indexSnap] = indexRef ? await tx.getAll(conversationRef, indexRef) : [await tx.get(conversationRef), null];
    if (indexSnap?.exists) return null;
    const current = fromDoc<Conversation>(conversationSnap);
    if (!current) throw notFound("Conversation not found");
    const next: Conversation = {
      ...current,
      lastInboundAt: at,
      lastMessageAt: at,
      lastMessagePreview: preview(input.content, input.type),
      unreadCount: current.unreadCount + 1,
      status: current.status === "resolved" ? "active" : current.status,
      updatedAt: new Date(),
    };
    if (indexRef) tx.create(indexRef, { conversationId, messageId, createdAt: at });
    const { id: _id, ...doc } = message;
    void _id;
    tx.set(s.messages(businessId, conversationId).doc(messageId), doc);
    tx.update(conversationRef, {
      lastInboundAt: next.lastInboundAt,
      lastMessageAt: next.lastMessageAt,
      lastMessagePreview: next.lastMessagePreview,
      unreadCount: next.unreadCount,
      status: next.status,
      updatedAt: next.updatedAt,
    });
    return next;
  });
  if (!conversation) return null;
  publish(businessId, { type: "message.created", conversationId, messageId, direction: "inbound" });
  publish(businessId, { type: "conversation.updated", conversationId });
  return { message, conversation };
}

export async function insertOutboundRecord(
  businessId: string,
  conversationId: string,
  input: { sender: MessageSender; type: MessageType; content: string; payload?: MessagePayload; sentByUserId?: string | null },
): Promise<Message> {
  const s = await store();
  const message: Message = {
    id: newId(),
    businessId,
    conversationId,
    direction: "outbound",
    sender: input.sender,
    type: input.type,
    content: input.content,
    payload: input.payload ?? {},
    waMessageId: null,
    status: "pending",
    errorMessage: null,
    sentByUserId: input.sentByUserId ?? null,
    statusUpdatedAt: null,
    createdAt: new Date(),
  };
  const { id, ...doc } = message;
  const batch = s.db.batch();
  batch.set(s.messages(businessId, conversationId).doc(id), doc);
  batch.update(s.conversations(businessId).doc(conversationId), {
    lastMessageAt: message.createdAt,
    lastMessagePreview: preview(input.content, input.type),
    updatedAt: new Date(),
  });
  await batch.commit();
  return message;
}

/** Records the WhatsApp id of a message we sent, so delivery/read webhooks can find it. */
export async function recordWaMessageId(businessId: string, conversationId: string, messageId: string, waMessageId: string) {
  const s = await store();
  await s.waMessages(businessId).doc(keyId(waMessageId)).set({ conversationId, messageId, createdAt: new Date() });
}

export async function loadConversation(businessId: string, conversationId: string) {
  const s = await store();
  const conversation = fromDoc<Conversation>(await s.conversations(businessId).doc(conversationId).get());
  if (!conversation) throw notFound("Conversation not found");
  const customer = fromDoc<Customer>(await s.customers(businessId).doc(conversation.customerId).get());
  if (!customer) throw notFound("Conversation not found");
  return { conversation, customer };
}

async function patchConversation(businessId: string, conversationId: string, patch: Partial<Conversation>) {
  const s = await store();
  const ref = s.conversations(businessId).doc(conversationId);
  const current = fromDoc<Conversation>(await ref.get());
  if (!current) throw notFound("Conversation not found");
  await ref.update({ ...patch, updatedAt: new Date() });
  return { ...current, ...patch };
}

export async function setConversationAI(businessId: string, conversationId: string, enabled: boolean, actor: AuditActor) {
  const row = await patchConversation(
    businessId,
    conversationId,
    enabled ? { aiEnabled: true, status: "active", handoffReason: null } : { aiEnabled: false },
  );
  await audit(businessId, actor, enabled ? "conversation.ai_resumed" : "conversation.ai_paused", { type: "conversation", id: conversationId });
  publish(businessId, { type: "conversation.updated", conversationId });
  return row;
}

export async function setConversationStatus(businessId: string, conversationId: string, status: "active" | "resolved", actor: AuditActor) {
  const row = await patchConversation(businessId, conversationId, status === "resolved" ? { status, unreadCount: 0, handoffReason: null } : { status });
  await audit(businessId, actor, `conversation.${status}`, { type: "conversation", id: conversationId });
  publish(businessId, { type: "conversation.updated", conversationId });
  return row;
}

export async function markConversationRead(businessId: string, conversationId: string) {
  const s = await store();
  await s.conversations(businessId).doc(conversationId).update({ unreadCount: 0 }).catch(() => undefined);
}

/** Human handoff (spec §31): flags the conversation, pauses the AI and alerts the owner. */
export async function requestHumanSupport(businessId: string, conversationId: string, reason: string) {
  const { customer } = await loadConversation(businessId, conversationId).catch(() => ({ customer: null }));
  if (!customer) return;
  await patchConversation(businessId, conversationId, { status: "human_required", aiEnabled: false, handoffReason: reason.slice(0, 300) });
  publish(businessId, { type: "conversation.updated", conversationId });
  await notify(businessId, {
    type: "human_support",
    title: `${customer.displayName || customer.phone || "A customer"} needs a team member`,
    body: reason.slice(0, 200),
    link: `/dashboard/conversations?c=${conversationId}`,
  });
  await audit(businessId, { name: "ai" }, "conversation.handoff", { type: "conversation", id: conversationId }, { reason });
}
