import "server-only";
import { store } from "@/db";
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
  const s = await store();
  const businessId = auth.business.id;
  const messages = await s.messages(businessId, conversation.id).limit(500).get();
  const batch = s.db.batch();
  messages.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(s.carts(businessId).doc(conversation.id));
  batch.update(s.conversations(businessId).doc(conversation.id), {
    aiEnabled: true,
    status: "active",
    handoffReason: null,
    unreadCount: 0,
    lastMessagePreview: "",
    updatedAt: new Date(),
  });
  await batch.commit();
  await audit(auth.business.id, auth.actor, "bot.test_reset", { type: "conversation", id: conversation.id });
  return conversationDetail(auth.business.id, conversation.id);
}
