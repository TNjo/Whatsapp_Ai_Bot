import "server-only";
import { store } from "@/db";
import type { MessagePayload, MessageSender, MessageType } from "@/db/schema";
import { insertOutboundRecord, isWindowOpen, loadConversation, recordWaMessageId } from "./conversations";
import { publish } from "./events";
import { log } from "./logger";
import { notify } from "./notifications";
import { getChannel } from "./whatsapp/channel";
import { GraphError } from "./whatsapp/graph";
import { toPlainText, type OutboundMessage } from "./whatsapp/messaging";

export type DeliveryResult =
  | { ok: true; messageId: string; simulated: boolean }
  | { ok: false; messageId: string; reason: "window_closed" | "not_connected" | "send_failed"; error: string };

function recordShape(message: OutboundMessage): { type: MessageType; payload: MessagePayload } {
  switch (message.kind) {
    case "text":
      return { type: "text", payload: {} };
    case "image":
      return { type: "image", payload: { media: { id: "", link: message.url, caption: message.text } } };
    case "document":
      return { type: "document", payload: { media: { id: "", link: message.url, filename: message.filename, caption: message.text } } };
    case "buttons":
      return {
        type: "interactive",
        payload: { interactive: { kind: "buttons", buttons: message.buttons, header: message.header, footer: message.footer } },
      };
    case "list":
      return {
        type: "interactive",
        payload: {
          interactive: { kind: "list", sections: message.sections, buttonText: message.buttonText, header: message.header, footer: message.footer },
        },
      };
    case "template":
      return { type: "template", payload: { template: { name: message.name, language: message.language, variables: message.variables } } };
  }
}

/**
 * The single path every outgoing message takes: it is stored first (so it is
 * traceable even if sending fails), checked against the 24-hour window, sent,
 * and its status updated. Test conversations never touch WhatsApp.
 */
export async function deliver(input: {
  businessId: string;
  conversationId: string;
  message: OutboundMessage;
  sender: MessageSender;
  userId?: string | null;
  extraPayload?: MessagePayload;
}): Promise<DeliveryResult> {
  const { businessId, conversationId, message } = input;
  const { conversation, customer } = await loadConversation(businessId, conversationId);
  const shape = recordShape(message);
  const record = await insertOutboundRecord(businessId, conversationId, {
    sender: input.sender,
    type: shape.type,
    content: toPlainText(message),
    payload: { ...shape.payload, ...input.extraPayload },
    sentByUserId: input.userId,
  });
  const s = await store();

  const finish = async (status: "sent" | "failed", extra: { waMessageId?: string; errorMessage?: string } = {}) => {
    await s
      .messages(businessId, conversationId)
      .doc(record.id)
      .update({ status, statusUpdatedAt: new Date(), waMessageId: extra.waMessageId ?? null, errorMessage: extra.errorMessage ?? null });
    if (extra.waMessageId) await recordWaMessageId(businessId, conversationId, record.id, extra.waMessageId);
    publish(businessId, { type: "message.created", conversationId, messageId: record.id, direction: "outbound" });
    publish(businessId, { type: "conversation.updated", conversationId });
  };

  const channel = await getChannel(businessId, conversation);
  if (channel?.kind === "test") {
    await finish("sent");
    return { ok: true, messageId: record.id, simulated: true };
  }

  if (channel?.needsWindow && message.kind !== "template" && !isWindowOpen(conversation.lastInboundAt)) {
    const error = "More than 24 hours have passed since the customer's last message. Only approved templates can be sent.";
    await finish("failed", { errorMessage: error });
    return { ok: false, messageId: record.id, reason: "window_closed", error };
  }

  if (!channel) {
    const error = "WhatsApp is not connected.";
    await finish("failed", { errorMessage: error });
    return { ok: false, messageId: record.id, reason: "not_connected", error };
  }

  try {
    const result = await channel.send(customer, message);
    await finish("sent", { waMessageId: result.waMessageId ?? undefined });
    log.info("whatsapp.send", {
      businessId,
      conversationId,
      channel: channel.kind,
      kind: message.kind,
      sender: input.sender,
      fellBackToText: result.fellBackToText,
      waMessageId: result.waMessageId,
    });
    return { ok: true, messageId: record.id, simulated: false };
  } catch (err) {
    const error = err instanceof GraphError ? err.friendly : "Unable to send the message. Please try again.";
    await finish("failed", { errorMessage: error });
    log.error("whatsapp.send.failed", { businessId, conversationId, kind: message.kind, code: err instanceof GraphError ? err.code : undefined, err });
    await notify(businessId, {
      type: "message_failed",
      title: `Message to ${customer.displayName || customer.phone} failed`,
      body: error,
      link: `/dashboard/conversations?c=${conversationId}`,
    });
    return {
      ok: false,
      messageId: record.id,
      reason: err instanceof GraphError && err.windowClosed ? "window_closed" : "send_failed",
      error,
    };
  }
}
