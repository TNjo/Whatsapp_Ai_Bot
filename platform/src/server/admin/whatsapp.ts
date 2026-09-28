import "server-only";
import { z } from "zod";
import { fromDoc, fromDocs, store } from "@/db";
import type { StatusMessageKey, WhatsAppTemplate } from "@/db/schema";
import { audit, type AuditActor } from "../audit";
import { ensureBotSettings } from "../bot/settings";
import { DEFAULT_STATUS_MESSAGES, STATUS_MESSAGE_LABELS } from "../commerce/status-messages";
import { cleanText, notFound } from "../http";
import { connectionView, TEMPLATE_VARIABLES, templateId } from "../whatsapp/connection";

export async function whatsappOverview(businessId: string) {
  const s = await store();
  const [view, msgCount, orderCount, settings] = await Promise.all([
    connectionView(businessId),
    s.db.collectionGroup("messages").where("businessId", "==", businessId).count().get(),
    s.orders(businessId).where("isTest", "==", false).count().get(),
    ensureBotSettings(businessId),
  ]);
  return {
    ...view,
    stats: { messages: msgCount.data().count, orders: orderCount.data().count },
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
  const s = await store();
  return fromDocs<WhatsAppTemplate>(await s.templates(businessId).get()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Upserts by Meta template name + language. */
export async function saveTemplate(businessId: string, input: z.infer<typeof TemplateInput>, actor: AuditActor) {
  const s = await store();
  const id = templateId(input.name, input.language);
  const ref = s.templates(businessId).doc(id);
  const existing = fromDoc<WhatsAppTemplate>(await ref.get());
  const now = new Date();
  const row: WhatsAppTemplate = existing
    ? { ...existing, purpose: input.purpose, body: input.body, variables: input.variables, category: input.category, status: input.status, updatedAt: now }
    : { id, ...input, metaTemplateId: null, createdAt: now, updatedAt: now };
  const { id: _id, ...doc } = row;
  void _id;
  await ref.set(doc);
  await audit(businessId, actor, "template.saved", { type: "whatsapp_template", id }, { name: row.name, purpose: row.purpose });
  return row;
}

export async function updateTemplate(businessId: string, id: string, input: Partial<z.infer<typeof TemplateInput>>, actor: AuditActor) {
  const s = await store();
  const ref = s.templates(businessId).doc(id);
  const current = fromDoc<WhatsAppTemplate>(await ref.get());
  if (!current) throw notFound("Template not found");
  const patch = { ...input, updatedAt: new Date() };
  await ref.update(patch);
  await audit(businessId, actor, "template.updated", { type: "whatsapp_template", id }, { fields: Object.keys(input) });
  return { ...current, ...patch };
}

export async function deleteTemplate(businessId: string, id: string, actor: AuditActor) {
  const s = await store();
  const ref = s.templates(businessId).doc(id);
  const current = fromDoc<WhatsAppTemplate>(await ref.get());
  if (!current) throw notFound("Template not found");
  await ref.delete();
  await audit(businessId, actor, "template.deleted", { type: "whatsapp_template", id }, { name: current.name });
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
  const s = await store();
  const settings = await ensureBotSettings(businessId);
  const next = { ...settings.statusMessages };
  for (const [key, text] of Object.entries(values) as [StatusMessageKey, string][]) {
    const clean = text.trim();
    if (!clean || clean === DEFAULT_STATUS_MESSAGES[key]) delete next[key];
    else next[key] = clean.slice(0, 1000);
  }
  await s.bot(businessId).update({ statusMessages: next, updatedAt: new Date() });
  await audit(businessId, actor, "status_messages.updated", { type: "bot_settings" }, { keys: Object.keys(values) });
  return statusMessagesView(businessId);
}
