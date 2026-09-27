import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/db";
import { botKnowledge, botSettings, businesses, faqs, type BotRule } from "@/db/schema";
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

export async function ensureBotSettings(businessId: string, tx?: DbOrTx) {
  const db = tx ?? (await getDb());
  const [existing] = await db.select().from(botSettings).where(eq(botSettings.businessId, businessId));
  if (existing) return existing;
  const [business] = await db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, businessId));
  const [created] = await db
    .insert(botSettings)
    .values({ businessId, ...defaultBotSettings(business?.name ?? "our store") })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [raced] = await db.select().from(botSettings).where(eq(botSettings.businessId, businessId));
  return raced;
}

/** Everything the bot needs about a business for one turn. */
export async function loadBotContext(businessId: string) {
  const db = await getDb();
  const settings = await ensureBotSettings(businessId);
  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  const faqRows = await db
    .select()
    .from(faqs)
    .where(and(eq(faqs.businessId, businessId), eq(faqs.enabled, true)))
    .orderBy(asc(faqs.sortOrder), asc(faqs.createdAt));
  const knowledge = await db
    .select()
    .from(botKnowledge)
    .where(and(eq(botKnowledge.businessId, businessId), eq(botKnowledge.enabled, true)))
    .orderBy(asc(botKnowledge.createdAt));
  const orderFields = await getOrderFields(businessId);
  return { business, settings, faqs: faqRows, knowledge, orderFields, aiConfig: resolveAIConfig(settings) };
}

export type BotContext = Awaited<ReturnType<typeof loadBotContext>>;
