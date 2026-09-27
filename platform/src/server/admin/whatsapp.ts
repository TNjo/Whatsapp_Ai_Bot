import "server-only";
import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { botSettings, messages, orders, whatsappTemplates, type StatusMessageKey } from "@/db/schema";
import { audit, type AuditActor } from "../audit";
import { ensureBotSettings } from "../bot/settings";
import { DEFAULT_STATUS_MESSAGES, STATUS_MESSAGE_LABELS } from "../commerce/status-messages";
import { cleanText, notFound } from "../http";
import { connectionView, TEMPLATE_VARIABLES } from "../whatsapp/connection";

export async function whatsappOverview(businessId: string) {
  const db = await getDb();
  const [view, [msgCount], [orderCount], settings] = await Promise.all([
    connectionView(businessId),
    db.select({ n: count() }).from(messages).where(eq(messages.businessId, businessId)),
    db.select({ n: count() }).from(orders).where(and(eq(orders.businessId, businessId), eq(orders.isTest, false))),
    ensureBotSettings(businessId),
  ]);
  return {
    ...view,
    stats: { messages: msgCount?.n ?? 0, orders: orderCount?.n ?? 0 },
    bot: { aiEnabled: settings.aiEnabled, humanHandoffEnabled: settings.humanHandoffEnabled, botName: settings.botName },
  };
}

export const PURPOSES = [
  "order_confirmed",
  "order_processing",
  "order_ready",
  "order_dispatched",
  "order_delivered",
  "order_completed",
  "order_rejected",
  "order_cancelled",
  "payment_received",
  "other",
] as const;

export const TemplateInput = z.object({
  name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, "Use the exact template name from Meta (lowercase letters, numbers, underscores)"),
  language: z.string().trim().min(2).max(10).default("en"),
  category: z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]).default("UTILITY"),
  purpose: z.enum(PURPOSES).default("other"),
  body: cleanText(1024).default(""),
  variables: z.array(z.enum(TEMPLATE_VARIABLES)).max(10).default([]),
  status: z.enum(["APPROVED", "PENDING", "REJECTED", "PAUSED", "UNKNOWN"]).default("UNKNOWN"),
});

export async function listTemplates(businessId: string) {
  const db = await getDb();
  return db.select().from(whatsappTemplates).where(eq(whatsappTemplates.businessId, businessId)).orderBy(asc(whatsappTemplates.name));
}

export async function saveTemplate(businessId: string, input: z.infer<typeof TemplateInput>, actor: AuditActor) {
  const db = await getDb();
  const [row] = await db
    .insert(whatsappTemplates)
    .values({ businessId, ...input })
    .onConflictDoUpdate({
      target: [whatsappTemplates.businessId, whatsappTemplates.name, whatsappTemplates.language],
      set: { purpose: input.purpose, body: input.body, variables: input.variables, category: input.category, status: input.status },
    })
    .returning();
  await audit(businessId, actor, "template.saved", { type: "whatsapp_template", id: row.id }, { name: row.name, purpose: row.purpose });
  return row;
}

export async function updateTemplate(businessId: string, id: string, input: Partial<z.infer<typeof TemplateInput>>, actor: AuditActor) {
  const db = await getDb();
  const [row] = await db
    .update(whatsappTemplates)
    .set(input)
    .where(and(eq(whatsappTemplates.id, id), eq(whatsappTemplates.businessId, businessId)))
    .returning();
  if (!row) throw notFound("Template not found");
  await audit(businessId, actor, "template.updated", { type: "whatsapp_template", id }, { fields: Object.keys(input) });
  return row;
}

export async function deleteTemplate(businessId: string, id: string, actor: AuditActor) {
  const db = await getDb();
  const [row] = await db.delete(whatsappTemplates).where(and(eq(whatsappTemplates.id, id), eq(whatsappTemplates.businessId, businessId))).returning();
  if (!row) throw notFound("Template not found");
  await audit(businessId, actor, "template.deleted", { type: "whatsapp_template", id }, { name: row.name });
}

export async function statusMessagesView(businessId: string) {
  const settings = await ensureBotSettings(businessId);
  return (Object.keys(DEFAULT_STATUS_MESSAGES) as StatusMessageKey[]).map((key) => ({
    key,
    label: STATUS_MESSAGE_LABELS[key],
    text: settings.statusMessages[key] ?? DEFAULT_STATUS_MESSAGES[key],
    isDefault: !settings.statusMessages[key],
    defaultText: DEFAULT_STATUS_MESSAGES[key],
  }));
}

export async function saveStatusMessages(businessId: string, values: Partial<Record<StatusMessageKey, string>>, actor: AuditActor) {
  const db = await getDb();
  const settings = await ensureBotSettings(businessId);
  const next = { ...settings.statusMessages };
  for (const [key, text] of Object.entries(values) as [StatusMessageKey, string][]) {
    const clean = text.trim();
    if (!clean || clean === DEFAULT_STATUS_MESSAGES[key]) delete next[key];
    else next[key] = clean.slice(0, 1000);
  }
  await db.update(botSettings).set({ statusMessages: next }).where(eq(botSettings.businessId, businessId));
  await audit(businessId, actor, "status_messages.updated", { type: "bot_settings" }, { keys: Object.keys(values) });
  return statusMessagesView(businessId);
}
