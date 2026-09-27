import "server-only";
import { getDb } from "@/db";
import { conversations, messages } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import {
  getOrCreateConversation,
  loadConversation,
  requestHumanSupport,
  saveInboundMessage,
  upsertCustomer,
  type InboundInput,
} from "../conversations";
import { abandonCart, CartError, getOpenCart, markReviewSent, reviewText, viewCart } from "../commerce/cart";
import { getProduct } from "../commerce/catalog";
import { OrderError } from "../commerce/orders";
import { log } from "../logger";
import { notify } from "../notifications";
import { deliver } from "../outbound";
import { getChannel } from "../whatsapp/channel";
import type { OutboundMessage } from "../whatsapp/messaging";
import { runAgent } from "./agent";
import { loadBotContext } from "./settings";
import { orderPlacedText, placeOrder, productCard, type ToolRuntime } from "./tools";

const AI_FAILURE_MESSAGE = "I'm having trouble processing your request right now.\n\nI'll connect you with our team.";
const GREETING = /^(hi+|hello+|hey+|hii+|good\s+(morning|afternoon|evening)|ayubowan|vanakkam|hola|salam|start)[\s!.👋🙂😊]*$/i;

/* One turn at a time per conversation, so rapid messages don't race each other. */
const locks = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  locks.set(key, next);
  void next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
  return next;
}

export type IncomingInput = {
  businessId: string;
  waId: string;
  /** Linked-device chat id to reply to ("…@c.us" / "…@lid"). */
  waChatId?: string;
  profileName?: string;
  message: InboundInput;
  isTest?: boolean;
};

/**
 * Incoming message flow (spec §8): identify customer → save message → load
 * conversation, bot configuration and business context → AI → send → save.
 */
export async function handleIncoming(input: IncomingInput) {
  const { businessId } = input;
  const { customer, created: newCustomer } = await upsertCustomer(businessId, {
    waId: input.waId,
    waChatId: input.waChatId,
    profileName: input.profileName,
    isTest: input.isTest,
  });
  const { conversation, created: newConversation } = await getOrCreateConversation(businessId, customer.id, Boolean(input.isTest));
  const hadUnread = conversation.unreadCount > 0;

  const choice = await resolveTextChoice(businessId, conversation.id, input.message);
  const saved = await saveInboundMessage(businessId, conversation.id, await enrichReply(businessId, choice));
  if (!saved) return { conversationId: conversation.id, duplicate: true as const };

  if (newCustomer && !input.isTest) {
    await notify(businessId, {
      type: "new_customer",
      title: `New customer: ${customer.displayName || customer.phone}`,
      body: saved.message.content.slice(0, 120),
      link: `/dashboard/conversations?c=${conversation.id}`,
    });
  }

  // Blue ticks: best effort.
  if (!input.isTest) {
    const channel = await getChannel(businessId, conversation);
    channel?.markRead(customer, input.message.waMessageId ?? null).catch(() => undefined);
  }

  await serialize(conversation.id, () =>
    respond({
      businessId,
      conversationId: conversation.id,
      inbound: saved.message,
      isNewConversation: newConversation,
      hadUnread,
      isTest: Boolean(input.isTest),
    }),
  );
  return { conversationId: conversation.id, duplicate: false as const };
}

async function respond(args: {
  businessId: string;
  conversationId: string;
  inbound: { content: string; type: string; payload: InboundInput["payload"]; createdAt: Date };
  isNewConversation: boolean;
  hadUnread: boolean;
  isTest: boolean;
}) {
  const { businessId, conversationId, inbound } = args;
  const db = await getDb();
  const bot = await loadBotContext(businessId);
  const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  const { customer } = await loadConversation(businessId, conversationId);

  // AI off (globally, for this chat, or waiting for a human): store only, and tell the team.
  if (!bot.settings.aiEnabled || !conversation.aiEnabled || conversation.status === "human_required") {
    if (!args.hadUnread && !args.isTest) {
      await notify(businessId, {
        type: "new_message",
        title: `New message from ${customer.displayName || customer.phone}`,
        body: inbound.content.slice(0, 140),
        link: `/dashboard/conversations?c=${conversationId}`,
      });
    }
    return;
  }

  const rt: ToolRuntime = { businessId, conversation, customer, bot, isTest: args.isTest, inboundAt: inbound.createdAt };
  const send = async (replies: OutboundMessage[], sender: "ai" | "system" = "ai", toolsUsed: string[] = []) => {
    for (const reply of replies) {
      await deliver({ businessId, conversationId, message: reply, sender, extraPayload: toolsUsed.length ? { aiTools: toolsUsed } : undefined });
    }
  };

  // Welcome message for a first "hi" (spec §59).
  if (args.isNewConversation && bot.settings.welcomeMessage && inbound.type === "text" && GREETING.test(inbound.content.trim())) {
    await send([{ kind: "text", text: bot.settings.welcomeMessage }]);
    return;
  }

  // Interactive replies we can answer without the model.
  const replyId = inbound.payload?.interactive?.replyId;
  if (replyId) {
    const handled = await handleReplyId(rt, replyId, send);
    if (handled) return;
  }

  const result = await runAgent(rt);
  if (result.ok) {
    await send(result.replies, "ai", result.toolsUsed);
    return;
  }

  // AI failure (spec §53): apologise, hand over, alert the owner.
  log.warn("bot.fallback", { businessId, conversationId, error: result.error });
  await send([{ kind: "text", text: AI_FAILURE_MESSAGE }], "system");
  await requestHumanSupport(businessId, conversationId, `AI could not reply: ${result.error}`);
}

async function handleReplyId(
  rt: ToolRuntime,
  replyId: string,
  send: (replies: OutboundMessage[], sender?: "ai" | "system") => Promise<void>,
): Promise<boolean> {
  if (replyId === "confirm_order") {
    const cart = await getOpenCart(rt.businessId, rt.conversation.id);
    if (!cart?.reviewSentAt) return false;
    try {
      const order = await placeOrder(rt);
      await send([{ kind: "text", text: orderPlacedText(rt, order) }], "system");
      return true;
    } catch (err) {
      if (err instanceof OrderError || err instanceof CartError) {
        log.info("bot.confirm_rejected", { businessId: rt.businessId, reason: err.message });
        // The draft changed after the review: show the up-to-date summary instead of placing a stale order.
        const view = await viewCart(rt.businessId, cart);
        if (!view.readyForReview) return false; // let the AI ask for what's missing
        await markReviewSent(cart.id, view.reviewHash);
        const labels = new Map(rt.bot.orderFields.map((field) => [field.key, field.label]));
        await send(
          [
            {
              kind: "buttons",
              text: `Your order was updated — please check the new summary.\n\n${reviewText(view, labels)}`,
              buttons: [
                { id: "confirm_order", title: "Confirm Order" },
                { id: "edit_order", title: "Edit" },
                { id: "cancel_order", title: "Cancel" },
              ],
            },
          ],
          "system",
        );
        return true;
      }
      throw err;
    }
  }
  if (replyId === "cancel_order") {
    const cart = await getOpenCart(rt.businessId, rt.conversation.id);
    if (cart) await abandonCart(rt.businessId, cart);
    await send([{ kind: "text", text: "No problem — your order has been cancelled. Let me know if there's anything else I can help with." }], "system");
    return true;
  }
  const view = /^(?:view_)?product:([0-9a-f-]{36})$/.exec(replyId);
  if (view) {
    const card = await productCard(rt, view[1]);
    if (!card) return false;
    await send(card, "system");
    return true;
  }
  // order_product:<id> and other choices go to the model, which sees the enriched text.
  return false;
}

/** Adds the product behind a tapped button to the stored text so the model (and the inbox) know what was chosen. */
async function enrichReply(businessId: string, message: InboundInput): Promise<InboundInput> {
  const replyId = message.payload?.interactive?.replyId;
  const match = replyId ? /^(?:order_|view_)?product:([0-9a-f-]{36})$/.exec(replyId) : null;
  if (!match) return message;
  const found = await getProduct(businessId, match[1]);
  if (!found) return message;
  const verb = replyId!.startsWith("order_") ? "I want to order" : "Show me";
  return { ...message, content: `${verb}: ${found.product.name} (productId ${found.product.id})` };
}

/**
 * Where buttons can't be shown (linked devices, or the Cloud API's text fallback),
 * options are sent as a numbered list. A reply of "1" or the option's title is
 * treated exactly like tapping that button.
 */
async function resolveTextChoice(businessId: string, conversationId: string, message: InboundInput): Promise<InboundInput> {
  if (message.type !== "text" || message.payload?.interactive) return message;
  const text = message.content.trim().replace(/[.)!]+$/, "").toLowerCase();
  if (!text || text.length > 40) return message;
  const db = await getDb();
  const [last] = await db
    .select({ payload: messages.payload })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.businessId, businessId), eq(messages.direction, "outbound")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const interactive = last?.payload.interactive;
  const options =
    interactive?.kind === "buttons"
      ? (interactive.buttons ?? [])
      : interactive?.kind === "list"
        ? (interactive.sections ?? []).flatMap((section) => section.rows)
        : [];
  if (!options.length) return message;
  const index = /^\d{1,2}$/.test(text) ? Number(text) - 1 : -1;
  const option = options[index] ?? options.find((o) => o.title.toLowerCase() === text);
  if (!option) return message;
  return { ...message, type: "interactive", content: option.title, payload: { ...message.payload, interactive: { kind: "reply", replyId: option.id } } };
}
