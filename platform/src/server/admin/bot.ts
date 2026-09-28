import "server-only";
import { z } from "zod";
import { fromDoc, fromDocs, newId, store } from "@/db";
import type { AIProviderName, BotSettings, Business, Faq, KnowledgeNote, OrderFieldType, OrderForm, OrderFormField } from "@/db/schema";
import { AI_PROVIDERS, createProvider, resolveAIConfig } from "../ai/service";
import { listOpenAICompatibleModels, OPENAI_COMPATIBLE_DEFAULTS } from "../ai/openai-compatible";
import { AIProviderError } from "../ai/types";
import { audit, type AuditActor } from "../audit";
import { DEFAULT_RULES, ensureBotSettings } from "../bot/settings";
import { ensureOrderForm, getOrderFields, SYSTEM_FIELDS, SYSTEM_KEYS } from "../commerce/order-form";
import { decryptSecret, encryptSecret, secretHint } from "../crypto";
import { env } from "../env";
import { ApiError, badRequest, cleanText, docId, notFound } from "../http";
import { log } from "../logger";

/* ------------------------------------------------------------------ */
/* Bot settings                                                        */
/* ------------------------------------------------------------------ */

const PROVIDER_VALUES = ["claude", "openai", "gemini", "groq", "custom"] as const satisfies readonly AIProviderName[];

/** Provider choices for the settings form (no secrets). */
export function providerOptions() {
  return AI_PROVIDERS.map((p) => ({
    value: p.value,
    label: p.label,
    defaultModel: p.defaultModel,
    defaultBaseUrl: p.value === "claude" ? "" : OPENAI_COMPATIBLE_DEFAULTS[p.value].baseUrl,
  }));
}

export type ProviderOption = ReturnType<typeof providerOptions>[number];

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)/i;

const baseUrl = cleanText(300).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    // Development may point at a local model server; production must not reach internal hosts.
    if (env.isProduction && PRIVATE_HOST.test(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}, "Enter a valid http(s) URL");

const RuleInput = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, "Invalid rule id"),
  text: cleanText(300).pipe(z.string().min(1, "Rule text can't be empty")),
  enabled: z.boolean(),
});

export const BotSettingsInput = z.object({
  botName: cleanText(80).pipe(z.string().min(1, "Bot name is required")),
  welcomeMessage: cleanText(1000),
  businessDescription: cleanText(2000),
  instructions: cleanText(8000),
  rules: z
    .array(RuleInput)
    .max(40, "Up to 40 rules")
    .refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length, "Rule ids must be unique"),
  aiEnabled: z.boolean(),
  humanHandoffEnabled: z.boolean(),
  handoffMessage: cleanText(1000),
  testModeCreatesOrders: z.boolean(),
  aiProvider: z.enum(PROVIDER_VALUES).nullable(),
  aiModel: cleanText(120),
  aiBaseUrl: baseUrl,
  /** Write-only. Empty = keep the saved key. */
  aiApiKey: z.string().trim().max(500),
  /** Clears the saved key. */
  removeAiKey: z.boolean(),
});

export type BotSettingsPatch = Partial<z.infer<typeof BotSettingsInput>>;

type SettingsRow = Awaited<ReturnType<typeof ensureBotSettings>>;

function toView(row: SettingsRow, businessDescription: string) {
  const businessKey = decryptSecret(row.aiApiKeyEnc);
  const serverKey = Boolean(env.ai.apiKey) || env.ai.provider === "mock";
  const effective = resolveAIConfig(row);
  return {
    botName: row.botName,
    welcomeMessage: row.welcomeMessage,
    businessDescription,
    instructions: row.instructions,
    rules: row.rules,
    aiEnabled: row.aiEnabled,
    humanHandoffEnabled: row.humanHandoffEnabled,
    handoffMessage: row.handoffMessage,
    testModeCreatesOrders: row.testModeCreatesOrders,
    aiProvider: row.aiProvider,
    aiModel: row.aiModel,
    aiBaseUrl: row.aiBaseUrl,
    aiKeyHint: secretHint(businessKey),
    aiKeySource: (businessKey ? "business" : serverKey ? "server" : "none") as "business" | "server" | "none",
    /** What the assistant would use right now (never includes the key). */
    effectiveAI: effective ? { provider: effective.provider, model: effective.model } : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type BotSettingsView = ReturnType<typeof toView>;

export const DEFAULT_RULE_IDS = DEFAULT_RULES.map((rule) => rule.id);

async function businessDoc(businessId: string) {
  const s = await store();
  const business = fromDoc<Business>(await s.businesses.doc(businessId).get());
  if (!business) throw notFound("Business not found");
  return business;
}

export async function getBotSettingsView(businessId: string): Promise<BotSettingsView> {
  const s = await store();
  const [row, business] = await Promise.all([ensureBotSettings(businessId), s.businesses.doc(businessId).get().then((snap) => fromDoc<Business>(snap))]);
  return toView(row, business?.description ?? "");
}

export async function updateBotSettings(businessId: string, input: BotSettingsPatch, actor: AuditActor): Promise<BotSettingsView> {
  const s = await store();
  const current = await ensureBotSettings(businessId);
  const { businessDescription, aiApiKey, removeAiKey, ...rest } = input;

  const set: Partial<BotSettings> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  let keyChange: "set" | "removed" | null = null;
  if (aiApiKey) {
    set.aiApiKeyEnc = encryptSecret(aiApiKey);
    keyChange = "set";
  } else if (removeAiKey) {
    set.aiApiKeyEnc = null;
    keyChange = "removed";
  }

  const provider = rest.aiProvider !== undefined ? rest.aiProvider : current.aiProvider;
  const finalBaseUrl = rest.aiBaseUrl !== undefined ? rest.aiBaseUrl : current.aiBaseUrl;
  if (provider === "custom" && !finalBaseUrl) throw badRequest("aiBaseUrl: Enter the API URL for your custom provider");

  // settings/bot and the business description (businesses/{b}.description) change together.
  const now = new Date();
  const batch = s.db.batch();
  if (Object.keys(set).length) batch.update(s.bot(businessId), { ...set, updatedAt: now });
  if (businessDescription !== undefined) batch.update(s.businesses.doc(businessId), { description: businessDescription, updatedAt: now });
  await batch.commit();

  // Field names only — never values, and never the key.
  const fields = Object.keys(input).filter((k) => k !== "aiApiKey" && k !== "removeAiKey");
  await audit(businessId, actor, "bot.settings_updated", { type: "bot_settings", id: businessId }, { fields, apiCredential: keyChange });
  return getBotSettingsView(businessId);
}

export const TestConnectionInput = z.object({
  aiProvider: z.enum(PROVIDER_VALUES).nullable().default(null),
  aiModel: cleanText(120).default(""),
  aiBaseUrl: baseUrl.default(""),
  aiApiKey: z.string().trim().max(500).default(""),
});

/**
 * Sends a tiny request with the settings as currently entered (unsaved).
 * The saved key is used when no new key was typed.
 */
export async function testAIConnection(businessId: string, input: z.infer<typeof TestConnectionInput>) {
  const saved = await ensureBotSettings(businessId);
  const config = resolveAIConfig({
    aiProvider: input.aiProvider,
    aiModel: input.aiModel,
    aiBaseUrl: input.aiBaseUrl,
    aiApiKeyEnc: input.aiApiKey ? encryptSecret(input.aiApiKey) : saved.aiApiKeyEnc,
  });
  if (!config) throw badRequest("No API key to test. Enter an API key, or ask your administrator to configure a server default.");
  if (config.provider === "mock") return { ok: true, provider: "mock", model: "mock", reply: "OK (mock provider)", models: undefined };

  const started = Date.now();
  try {
    const provider = createProvider(config);
    const [completion, models] = await Promise.all([
      provider.complete({
        system: "Reply with the single word OK.",
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        maxTokens: 50,
      }),
      config.provider !== "claude" && config.baseUrl
        ? listOpenAICompatibleModels(config.baseUrl, config.apiKey).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    return {
      ok: true,
      provider: config.provider,
      model: config.model,
      reply: completion.text.slice(0, 200) || "(empty reply)",
      latencyMs: Date.now() - started,
      models: models?.slice(0, 200),
    };
  } catch (err) {
    if (err instanceof AIProviderError) throw new ApiError(400, err.message);
    log.warn("bot.ai_test_failed", { businessId, provider: config.provider, err });
    throw new ApiError(400, `Could not connect to ${config.provider}. Check the provider, model and API URL.`);
  }
}

/* ------------------------------------------------------------------ */
/* Knowledge: FAQs & notes                                             */
/* ------------------------------------------------------------------ */

export const FaqInput = z.object({
  question: cleanText(300).pipe(z.string().min(1, "Question is required")),
  answer: cleanText(2000).pipe(z.string().min(1, "Answer is required")),
  enabled: z.boolean().default(true),
});

export const FaqPatch = FaqInput.extend({ move: z.enum(["up", "down"]) });

export const NoteInput = z.object({
  title: cleanText(160).pipe(z.string().min(1, "Title is required")),
  content: cleanText(8000).pipe(z.string().min(1, "Content is required")),
  enabled: z.boolean().default(true),
});

/** FAQs in display order; ties (older data) fall back to creation time. */
const isDocId = (value: string) => docId.safeParse(value).success;

const byFaqOrder = (a: Faq, b: Faq) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1);

export async function listKnowledge(businessId: string) {
  const s = await store();
  const [faqRows, noteRows] = await Promise.all([
    s.faqs(businessId).orderBy("sortOrder").get().then((snap) => fromDocs<Faq>(snap)),
    // Single equality filter; sorted in memory so no composite index is needed.
    s.knowledge(businessId).where("kind", "==", "note").get().then((snap) => fromDocs<KnowledgeNote>(snap)),
  ]);
  return {
    faqs: faqRows
      .sort(byFaqOrder)
      .map((f) => ({ id: f.id, question: f.question, answer: f.answer, enabled: f.enabled, sortOrder: f.sortOrder, updatedAt: f.updatedAt })),
    notes: noteRows
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((n) => ({ id: n.id, title: n.title, content: n.content, enabled: n.enabled, updatedAt: n.updatedAt })),
  };
}

export async function createFaq(businessId: string, input: z.infer<typeof FaqInput>, actor: AuditActor): Promise<Faq> {
  const s = await store();
  const [top] = fromDocs<Faq>(await s.faqs(businessId).orderBy("sortOrder", "desc").limit(1).get());
  const now = new Date();
  const faq: Faq = { id: newId(), ...input, sortOrder: (top?.sortOrder ?? -1) + 1, createdAt: now, updatedAt: now };
  const { id, ...doc } = faq;
  await s.faqs(businessId).doc(id).create(doc);
  await audit(businessId, actor, "faq.created", { type: "faq", id });
  return faq;
}

export async function updateFaq(businessId: string, id: string, input: Partial<z.infer<typeof FaqPatch>>, actor: AuditActor): Promise<Faq> {
  if (!isDocId(id)) throw notFound("FAQ not found");
  const s = await store();
  const { move, ...rest } = input;
  const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<z.infer<typeof FaqInput>>;
  const ref = s.faqs(businessId).doc(id);
  const row = await s.db.runTransaction(async (tx) => {
    const existing = fromDoc<Faq>(await tx.get(ref));
    if (!existing) throw notFound("FAQ not found");
    const now = new Date();
    const patches = new Map<string, Partial<Faq>>();

    if (move) {
      // Renumber everything so ties from older rows can't block a move.
      const ordered = fromDocs<Faq>(await tx.get(s.faqs(businessId).orderBy("sortOrder"))).sort(byFaqOrder);
      const from = ordered.findIndex((f) => f.id === id);
      const to = move === "up" ? from - 1 : from + 1;
      if (from >= 0 && to >= 0 && to < ordered.length) {
        [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
        ordered.forEach((faq, index) => {
          if (faq.sortOrder !== index) patches.set(faq.id, { sortOrder: index });
        });
      }
    }
    if (Object.keys(fields).length) patches.set(id, { ...patches.get(id), ...fields, updatedAt: now });

    for (const [faqId, patch] of patches) tx.update(s.faqs(businessId).doc(faqId), patch);
    return { ...existing, ...patches.get(id) };
  });
  await audit(businessId, actor, "faq.updated", { type: "faq", id }, { fields: Object.keys(input) });
  return row;
}

export async function deleteFaq(businessId: string, id: string, actor: AuditActor) {
  if (!isDocId(id)) throw notFound("FAQ not found");
  const s = await store();
  const ref = s.faqs(businessId).doc(id);
  await s.db.runTransaction(async (tx) => {
    if (!(await tx.get(ref)).exists) throw notFound("FAQ not found");
    tx.delete(ref);
  });
  await audit(businessId, actor, "faq.deleted", { type: "faq", id });
}

export async function createNote(businessId: string, input: z.infer<typeof NoteInput>, actor: AuditActor): Promise<KnowledgeNote> {
  const s = await store();
  const now = new Date();
  const note: KnowledgeNote = { id: newId(), kind: "note", ...input, createdAt: now, updatedAt: now };
  const { id, ...doc } = note;
  await s.knowledge(businessId).doc(id).create(doc);
  await audit(businessId, actor, "knowledge.created", { type: "bot_knowledge", id }, { title: note.title });
  return note;
}

export async function updateNote(businessId: string, id: string, input: Partial<z.infer<typeof NoteInput>>, actor: AuditActor): Promise<KnowledgeNote> {
  if (!isDocId(id)) throw notFound("Note not found");
  const s = await store();
  const ref = s.knowledge(businessId).doc(id);
  const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<z.infer<typeof NoteInput>>;
  const row = await s.db.runTransaction(async (tx) => {
    const current = fromDoc<KnowledgeNote>(await tx.get(ref));
    if (!current || current.kind !== "note") throw notFound("Note not found");
    if (!Object.keys(fields).length) return current;
    const patch = { ...fields, updatedAt: new Date() };
    tx.update(ref, patch);
    return { ...current, ...patch };
  });
  await audit(businessId, actor, "knowledge.updated", { type: "bot_knowledge", id }, { fields: Object.keys(input) });
  return row;
}

export async function deleteNote(businessId: string, id: string, actor: AuditActor) {
  if (!isDocId(id)) throw notFound("Note not found");
  const s = await store();
  const ref = s.knowledge(businessId).doc(id);
  const title = await s.db.runTransaction(async (tx) => {
    const current = fromDoc<KnowledgeNote>(await tx.get(ref));
    if (!current || current.kind !== "note") throw notFound("Note not found");
    tx.delete(ref);
    return current.title;
  });
  await audit(businessId, actor, "knowledge.deleted", { type: "bot_knowledge", id }, { title });
}

/** The business profile facts the assistant already knows (edited in Settings). */
export async function getBusinessFacts(businessId: string) {
  const row = await businessDoc(businessId);
  return {
    description: row.description,
    openingHours: row.openingHours,
    deliveryInfo: row.deliveryInfo,
    deliveryFee: row.deliveryFee,
    paymentMethods: row.paymentMethods,
    returnPolicy: row.returnPolicy,
    exchangePolicy: row.exchangePolicy,
    currency: row.currency,
  };
}

/* ------------------------------------------------------------------ */
/* Order form                                                          */
/* ------------------------------------------------------------------ */

const FIELD_TYPES = ["text", "textarea", "phone", "email", "number", "date", "time", "select"] as const satisfies readonly OrderFieldType[];
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_FIELDS = 40;

const OrderFieldInput = z.object({
  id: docId.optional(),
  key: z.string().trim().regex(KEY_PATTERN, "Keys use lowercase letters, numbers and _ (start with a letter, max 40)"),
  label: cleanText(80).pipe(z.string().min(1, "Every field needs a label")),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  enabled: z.boolean(),
  options: z.array(cleanText(80)).max(30, "Up to 30 options").default([]),
  helpText: cleanText(200).default(""),
});

export const OrderFormInput = z.object({
  fields: z.array(OrderFieldInput).min(1).max(MAX_FIELDS, `Up to ${MAX_FIELDS} fields`),
});

function serializeField(row: Awaited<ReturnType<typeof getOrderFields>>[number]) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    enabled: row.enabled,
    system: row.system,
    options: row.options,
    helpText: row.helpText,
  };
}

export type OrderFieldView = ReturnType<typeof serializeField>;

export async function getOrderFormView(businessId: string) {
  const s = await store();
  const [fields, business] = await Promise.all([
    getOrderFields(businessId, { includeDisabled: true }),
    s.businesses.doc(businessId).get().then((snap) => fromDoc<Business>(snap)),
  ]);
  return { fields: fields.map(serializeField), paymentMethods: business?.paymentMethods ?? [] };
}

/** Replaces the whole field list (order = array order) of settings/orderForm in one transaction. */
export async function replaceOrderForm(businessId: string, input: z.infer<typeof OrderFormInput>, actor: AuditActor) {
  const seen = new Set<string>();
  for (const field of input.fields) {
    if (seen.has(field.key)) throw badRequest(`Two fields use the key “${field.key}”. Keys must be unique.`);
    seen.add(field.key);
  }
  for (const system of SYSTEM_FIELDS) {
    const field = input.fields.find((f) => f.key === system.key);
    if (!field) throw badRequest(`“${system.label}” is a built-in field and can't be deleted. Untick “Collect” to stop asking for it.`);
    if (field.type !== system.type) throw badRequest(`The type of the built-in “${system.label}” field can't be changed.`);
  }
  for (const field of input.fields) {
    const options = [...new Set(field.options.filter(Boolean))];
    if (field.type === "select" && field.key !== "payment_method" && !options.length) {
      throw badRequest(`Add at least one option to “${field.label}”.`);
    }
  }

  const s = await store();
  await ensureOrderForm(businessId);
  const ref = s.orderForm(businessId);
  await s.db.runTransaction(async (tx) => {
    const form = fromDoc<OrderForm & { id: string }>(await tx.get(ref));
    const byId = new Map((form?.fields ?? []).map((field) => [field.id, field]));
    for (const field of input.fields) {
      const previous = field.id ? byId.get(field.id) : undefined;
      if (previous?.system && previous.key !== field.key) throw badRequest("Built-in field keys can't be changed.");
    }

    const used = new Set<string>();
    const fields: OrderFormField[] = input.fields.map((field, index) => {
      const keepId = field.id && byId.has(field.id) && !used.has(field.id) ? field.id : null;
      const id = keepId ?? newId();
      used.add(id);
      const phone = field.key === "phone";
      return {
        id,
        key: field.key,
        label: field.label,
        type: field.type,
        // The phone number always comes from WhatsApp, so it is always "collected".
        required: phone ? true : field.required,
        enabled: phone ? true : field.enabled,
        system: SYSTEM_KEYS.has(field.key),
        options: field.type === "select" && field.key !== "payment_method" ? [...new Set(field.options.filter(Boolean))] : [],
        helpText: field.helpText,
        sortOrder: index,
      };
    });
    tx.set(ref, { name: form?.name ?? "Order information", fields, updatedAt: new Date() });
  });

  await audit(businessId, actor, "order_form.updated", { type: "order_form" }, { keys: input.fields.map((f) => f.key) });
  return getOrderFormView(businessId);
}
