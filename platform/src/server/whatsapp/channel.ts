import "server-only";
import { fromDoc, store } from "@/db";
import type { Conversation, Customer, WhatsAppConnection } from "@/db/schema";
import { isWindowOpen } from "../conversations";
import { getMessagingService } from "./connection";
import type { OutboundMessage } from "./messaging";

/**
 * Where a conversation's messages go: the WhatsApp Cloud API, or nowhere for
 * Test-bot chats. The 24-hour window only applies to real WhatsApp chats.
 */
export type Channel = {
  kind: "cloud" | "test";
  needsWindow: boolean;
  send(customer: Customer, message: OutboundMessage): Promise<{ waMessageId: string | null; fellBackToText?: boolean }>;
  markRead(customer: Customer, waMessageId: string | null): Promise<void>;
};

const testChannel: Channel = {
  kind: "test",
  needsWindow: false,
  send: async () => ({ waMessageId: null }),
  markRead: async () => undefined,
};

export async function getChannel(businessId: string, conversation: Pick<Conversation, "isTest">): Promise<Channel | null> {
  if (conversation.isTest) return testChannel;
  const service = await getMessagingService(businessId);
  if (!service) return null;
  return {
    kind: "cloud",
    needsWindow: true,
    send: (customer, message) => service.send(customer.waId, message),
    markRead: async (_customer, waMessageId) => {
      if (waMessageId) await service.markRead(waMessageId).catch(() => undefined);
    },
  };
}

/** Whether a normal (non-template) message can be sent right now. */
export async function canSendFreeform(_businessId: string, conversation: Pick<Conversation, "isTest" | "lastInboundAt">) {
  return conversation.isTest || isWindowOpen(conversation.lastInboundAt);
}

export async function connectionStatus(businessId: string) {
  const s = await store();
  return fromDoc<WhatsAppConnection & { id: string }>(await s.whatsapp(businessId).get())?.status ?? "disconnected";
}
