import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { whatsappConnections, type conversations, type customers } from "@/db/schema";
import { isWindowOpen } from "../conversations";
import { getMessagingService } from "./connection";
import type { OutboundMessage } from "./messaging";
import { webMarkRead, webSend } from "./web";

type Customer = typeof customers.$inferSelect;
type Conversation = typeof conversations.$inferSelect;

/**
 * Where a conversation's messages go: the official Cloud API, a linked device
 * (QR), or nowhere for Test-bot chats. Only the Cloud API has the 24-hour
 * window and needs templates outside it.
 */
export type Channel = {
  kind: "cloud" | "web" | "test";
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

export async function connectionMode(businessId: string): Promise<"cloud" | "web" | null> {
  const db = await getDb();
  const [row] = await db
    .select({ via: whatsappConnections.connectedVia, status: whatsappConnections.status })
    .from(whatsappConnections)
    .where(eq(whatsappConnections.businessId, businessId));
  if (!row || row.status === "disconnected" || !row.via) return null;
  return row.via === "qr" ? "web" : "cloud";
}

export async function getChannel(businessId: string, conversation: Pick<Conversation, "isTest">): Promise<Channel | null> {
  if (conversation.isTest) return testChannel;
  const mode = await connectionMode(businessId);
  if (mode === "web") {
    return {
      kind: "web",
      needsWindow: false,
      send: async (customer, message) => ({ waMessageId: await webSend(businessId, customer, message) }),
      markRead: (customer) => webMarkRead(businessId, customer),
    };
  }
  if (mode === "cloud") {
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
  return null;
}

/** Whether a normal (non-template) message can be sent right now. */
export async function canSendFreeform(businessId: string, conversation: Pick<Conversation, "isTest" | "lastInboundAt">) {
  if (conversation.isTest) return true;
  if ((await connectionMode(businessId)) === "web") return true;
  return isWindowOpen(conversation.lastInboundAt);
}
