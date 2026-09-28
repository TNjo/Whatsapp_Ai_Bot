import "server-only";
import { fromDoc, fromDocs, isAlreadyExists, store } from "@/db";
import type { BotRule, BotSettings, Business, Faq, KnowledgeNote } from "@/db/schema";
import { resolveAIConfig } from "../ai/service";
import { getOrderFields } from "../commerce/order-form";

export const DEFAULT_RULES: BotRule[] = [
  { id: "no-discounts", text: "Never give discounts unless they are configured.", enabled: true },
  { id: "check-stock", text: "Never confirm stock without checking the database.", enabled: true },
  { id: "no-delivery-promise", text: "Never promise a delivery date unless one is configured.", enabled: true },
  { id: "confirm-orders", text: "Never create an order without customer confirmation.", enabled: true },
  { id: "no-internal-info", text: "Never expose internal business information.", enabled: true },
  { id: "handoff-uncertain", text: "If uncertain, transfer the conversation to a human.", enabled: true },
];

export function defaultBotSettings(businessName: string) {
  return {
    botName: `${businessName} Assistant`,
    welcomeMessage: `Hi 👋 Welcome to ${businessName}!\n\nHow can I help you today?`,
    instructions: [
      `You are the official WhatsApp assistant for ${businessName}.`,
      "",
      "Help customers find products, answer questions, collect orders and provide accurate information.",
      "",
      "Never invent products, prices or stock information.",
      "",
      "If you do not know something, tell the customer that a team member can assist them.",
    ].join("\n"),
    rules: DEFAULT_RULES,
    handoffMessage: "I'm not able to provide an accurate answer to that.\n\nI'll connect you with our team.",
  };
}

export async function ensureBotSettings(businessId: string): Promise<BotSettings> {
  const s = await store();
  const ref = s.bot(businessId);
  const existing = fromDoc<BotSettings & { id: string }>(await ref.get());
  if (existing) return existing;
  const business = fromDoc<Business>(await s.businesses.doc(businessId).get());
  const created: BotSettings = {
    businessId,
    ...defaultBotSettings(business?.name ?? "our store"),
    aiEnabled: true,
    humanHandoffEnabled: true,
    aiProvider: null,
    aiModel: "",
    aiBaseUrl: "",
    aiApiKeyEnc: null,
    temperature: 30,
    testModeCreatesOrders: false,
    statusMessages: {},
    updatedAt: new Date(),
  };
  try {
    await ref.create(created);
    return created;
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    return fromDoc<BotSettings & { id: string }>(await ref.get())!;
  }
}

/** Everything the bot needs about a business for one turn. */
export async function loadBotContext(businessId: string) {
  const s = await store();
  const [settings, business, faqRows, knowledge, orderFields] = await Promise.all([
    ensureBotSettings(businessId),
    s.businesses.doc(businessId).get().then((snap) => fromDoc<Business>(snap)!),
    s.faqs(businessId).orderBy("sortOrder").get().then((snap) => fromDocs<Faq>(snap).filter((f) => f.enabled)),
    s.knowledge(businessId).orderBy("createdAt").get().then((snap) => fromDocs<KnowledgeNote>(snap).filter((k) => k.enabled)),
    getOrderFields(businessId),
  ]);
  return { business, settings, faqs: faqRows, knowledge, orderFields, aiConfig: resolveAIConfig(settings) };
}

export type BotContext = Awaited<ReturnType<typeof loadBotContext>>;
