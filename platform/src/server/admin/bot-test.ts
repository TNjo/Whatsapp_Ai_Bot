import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { carts, conversations, messages } from "@/db/schema";
import { audit } from "../audit";
import type { AuthContext } from "../auth";
import { handleIncoming } from "../bot/engine";
import { getOrCreateConversation, upsertCustomer } from "../conversations";
import { conversationDetail } from "./inbox";

/** Each dashboard user gets their own private test chat. */
async function testConversation(auth: AuthContext) {
  const { customer } = await upsertCustomer(auth.business.id, {
    waId: `test-${auth.user.id}`,
    profileName: `${auth.user.name} (test)`,
    isTest: true,
  });
  const { conversation } = await getOrCreateConversation(auth.business.id, customer.id, true);
  return conversation;
}

export async function testChat(auth: AuthContext) {
  const conversation = await testConversation(auth);
  return conversationDetail(auth.business.id, conversation.id);
}

export async function sendTestMessage(auth: AuthContext, input: { text?: string; replyId?: string; replyTitle?: string }) {
  const conversation = await testConversation(auth);
  const isReply = Boolean(input.replyId);
  await handleIncoming({
    businessId: auth.business.id,
    waId: `test-${auth.user.id}`,
    profileName: `${auth.user.name} (test)`,
    isTest: true,
    message: {
      type: isReply ? "interactive" : "text",
      content: isReply ? (input.replyTitle ?? "") : (input.text ?? ""),
      payload: isReply ? { interactive: { kind: "reply", replyId: input.replyId } } : {},
    },
  });
  return conversationDetail(auth.business.id, conversation.id);
}

/** Clears the test chat and its draft order so the owner can start over. */
export async function resetTestChat(auth: AuthContext) {
  const conversation = await testConversation(auth);
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.delete(messages).where(eq(messages.conversationId, conversation.id));
    await tx.update(carts).set({ status: "abandoned" }).where(and(eq(carts.conversationId, conversation.id), eq(carts.status, "open")));
    await tx
      .update(conversations)
      .set({ aiEnabled: true, status: "active", handoffReason: null, unreadCount: 0, lastMessagePreview: "" })
      .where(eq(conversations.id, conversation.id));
  });
  await audit(auth.business.id, auth.actor, "bot.test_reset", { type: "conversation", id: conversation.id });
  return conversationDetail(auth.business.id, conversation.id);
}
