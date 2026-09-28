import "server-only";
import crypto from "node:crypto";
import { fromDoc, store } from "@/db";
import {
  type BotSettings,
  type WhatsAppConnection,
  type WhatsAppTemplate,
  type HealthCheck,
  type TemplatePurpose,
} from "@/db/schema";
import { audit, type AuditActor } from "../audit";
import { decryptSecret, encryptSecret } from "../crypto";
import { env } from "../env";
import { publish } from "../events";
import { ApiError } from "../http";
import { log } from "../logger";
import { resolveAIConfig } from "../ai/service";
import { debugToken, exchangeCodeForToken, graph, GraphError } from "./graph";
import { WhatsAppMessagingService, type Credentials } from "./messaging";

export const WEBHOOK_PATH = "/api/webhooks/whatsapp";

type PhoneInfo = {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  platform_type?: string;
  code_verification_status?: string;
  status?: string;
};

/** businesses/{b}/settings/whatsapp — the connection, with its phone number embedded. */
export async function getConnection(businessId: string) {
  const s = await store();
  const connection = fromDoc<WhatsAppConnection & { id: string }>(await s.whatsapp(businessId).get());
  if (!connection) return null;
  return { connection, phone: connection.phone };
}

/** Browser-safe view of the connection. Never includes tokens. */
export async function connectionView(businessId: string) {
  const found = await getConnection(businessId);
  const setup = {
    embeddedSignupAvailable: Boolean(env.meta.appId && env.meta.appSecret && env.meta.embeddedSignupConfigId),
    appId: env.meta.appId || null,
    configId: env.meta.embeddedSignupConfigId || null,
    graphVersion: env.meta.graphVersion,
    webhookUrl: `${env.appUrl}${WEBHOOK_PATH}`,
    webhookVerifyTokenSet: Boolean(env.meta.webhookVerifyToken),
    appSecretSet: Boolean(env.meta.appSecret),
    serverCredentialsAvailable: Boolean(env.whatsapp.accessToken && env.whatsapp.phoneNumberId && env.whatsapp.businessAccountId),
  };
  if (!found) {
    return { status: "disconnected" as const, setup, connection: null };
  }
  const { connection, phone } = found;
  return {
    status: connection.status,
    setup,
    connection: {
      connectedVia: connection.connectedVia,
      wabaId: connection.wabaId,
      wabaName: connection.wabaName,
      phoneNumberId: phone?.phoneNumberId ?? null,
      displayPhoneNumber: phone?.displayPhoneNumber ?? "",
      verifiedName: phone?.verifiedName ?? "",
      qualityRating: phone?.qualityRating ?? null,
      health: connection.health,
      lastHealthCheckAt: connection.lastHealthCheckAt,
      lastWebhookEventAt: connection.lastWebhookEventAt,
      lastError: connection.lastError,
      connectedAt: connection.connectedAt,
      tokenExpiresAt: connection.tokenExpiresAt,
    },
  };
}

/** Decrypted credentials for sending. Only ever used server-side. */
export async function getCredentials(businessId: string): Promise<(Credentials & { wabaId: string | null }) | null> {
  const found = await getConnection(businessId);
  if (!found || found.connection.status !== "connected" || !found.phone) return null;
  const accessToken = decryptSecret(found.connection.accessTokenEnc);
  if (!accessToken) return null;
  return { accessToken, phoneNumberId: found.phone.phoneNumberId, wabaId: found.connection.wabaId };
}

const messagingCache = new Map<string, { key: string; service: WhatsAppMessagingService }>();

export async function getMessagingService(businessId: string) {
  const credentials = await getCredentials(businessId);
  if (!credentials) return null;
  const key = `${credentials.phoneNumberId}:${credentials.accessToken.slice(-8)}`;
  const cached = messagingCache.get(businessId);
  if (cached?.key === key) return cached.service;
  const service = new WhatsAppMessagingService(credentials);
  messagingCache.set(businessId, { key, service });
  return service;
}

/** Resolves the business that owns an incoming webhook's phone number id (phoneNumbers/{id}). */
export async function businessForPhoneNumberId(phoneNumberId: string) {
  const s = await store();
  const row = (await s.phoneNumbers.doc(phoneNumberId).get()).data() as { businessId: string } | undefined;
  return row ? { businessId: row.businessId } : null;
}

type ConnectInput = {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
  via: "embedded_signup" | "manual";
  tokenExpiresIn?: number;
  pin?: string;
};

const EMPTY_CONNECTION: Omit<WhatsAppConnection, "createdAt" | "updatedAt"> = {
  status: "disconnected",
  connectedVia: null,
  wabaId: null,
  wabaName: null,
  accessTokenEnc: null,
  tokenExpiresAt: null,
  registrationPinEnc: null,
  phone: null,
  health: [],
  lastHealthCheckAt: null,
  lastWebhookEventAt: null,
  lastError: null,
  connectedAt: null,
};

async function setStatus(businessId: string, values: Partial<WhatsAppConnection>) {
  const s = await store();
  const ref = s.whatsapp(businessId);
  await s.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = new Date();
    if (snap.exists) tx.update(ref, { ...values, updatedAt: now });
    else tx.set(ref, { ...EMPTY_CONNECTION, ...values, createdAt: now, updatedAt: now });
  });
  publish(businessId, { type: "whatsapp.updated" });
}

/**
 * Validates the credentials against the Graph API, subscribes the app to the
 * WABA's webhooks, registers the number when needed and stores everything
 * encrypted. Throws an ApiError with a readable message when anything fails.
 */
async function finishConnection(businessId: string, input: ConnectInput, actor: AuditActor) {
  await setStatus(businessId, { status: "connecting", lastError: null });

  // The number may belong to another business on this platform — refuse rather than hijack it.
  const owner = await businessForPhoneNumberId(input.phoneNumberId);
  if (owner && owner.businessId !== businessId) {
    await setStatus(businessId, { status: "error", lastError: "This WhatsApp number is already connected to another business." });
    throw new ApiError(409, "This WhatsApp number is already connected to another business.");
  }

  let phone: PhoneInfo;
  let wabaName = "";
  try {
    phone = await graph<PhoneInfo>(input.phoneNumberId, {
      token: input.accessToken,
      query: { fields: "display_phone_number,verified_name,quality_rating,platform_type,code_verification_status,status" },
    });
    const waba = await graph<{ id: string; name?: string }>(input.wabaId, { token: input.accessToken, query: { fields: "id,name" } });
    wabaName = waba.name ?? "";
  } catch (err) {
    const message = err instanceof GraphError ? err.friendly : "Could not verify the WhatsApp account.";
    await setStatus(businessId, { status: "error", lastError: message });
    throw new ApiError(400, message);
  }

  // Receive this WABA's messages on our webhook.
  try {
    await graph(`${input.wabaId}/subscribed_apps`, { token: input.accessToken, method: "POST", json: {} });
  } catch (err) {
    log.warn("whatsapp.subscribe_failed", { businessId, err });
  }

  // Numbers onboarded through Embedded Signup must be registered for the Cloud API once.
  let pinEnc: string | null = null;
  if (phone.platform_type && phone.platform_type !== "CLOUD_API") {
    const pin = input.pin && /^\d{6}$/.test(input.pin) ? input.pin : String(crypto.randomInt(100000, 999999));
    try {
      await graph(`${input.phoneNumberId}/register`, {
        token: input.accessToken,
        json: { messaging_product: "whatsapp", pin },
      });
      pinEnc = encryptSecret(pin);
    } catch (err) {
      const message =
        err instanceof GraphError
          ? `The number could not be registered for the Cloud API: ${err.friendly}`
          : "The number could not be registered for the Cloud API.";
      await setStatus(businessId, { status: "error", lastError: message });
      throw new ApiError(400, message);
    }
  }

  const values = {
    status: "connected" as const,
    connectedVia: input.via,
    wabaId: input.wabaId,
    wabaName,
    accessTokenEnc: encryptSecret(input.accessToken),
    tokenExpiresAt: input.tokenExpiresIn ? new Date(Date.now() + input.tokenExpiresIn * 1000) : null,
    lastError: null,
    connectedAt: new Date(),
  };

  const s = await store();
  const phoneRef = s.phoneNumbers.doc(input.phoneNumberId);
  const connectionRef = s.whatsapp(businessId);
  await s.db.runTransaction(async (tx) => {
    const [claim, currentSnap] = await tx.getAll(phoneRef, connectionRef);
    const claimedBy = (claim.data() as { businessId?: string } | undefined)?.businessId;
    if (claimedBy && claimedBy !== businessId) throw new ApiError(409, "This WhatsApp number is already connected to another business.");
    const current = fromDoc<WhatsAppConnection & { id: string }>(currentSnap);
    // Switching numbers: release the old one.
    if (current?.phone && current.phone.phoneNumberId !== input.phoneNumberId) tx.delete(s.phoneNumbers.doc(current.phone.phoneNumberId));
    const now = new Date();
    tx.set(phoneRef, { businessId, createdAt: now });
    tx.set(connectionRef, {
      ...EMPTY_CONNECTION,
      ...(current ? { lastWebhookEventAt: current.lastWebhookEventAt, createdAt: current.createdAt } : { createdAt: now }),
      ...values,
      registrationPinEnc: pinEnc ?? current?.registrationPinEnc ?? null,
      phone: {
        phoneNumberId: input.phoneNumberId,
        displayPhoneNumber: phone.display_phone_number ?? "",
        verifiedName: phone.verified_name ?? "",
        qualityRating: phone.quality_rating ?? null,
      },
      updatedAt: now,
    });
  });

  messagingCache.delete(businessId);
  await audit(businessId, actor, "whatsapp.connected", { type: "whatsapp_connection" }, {
    via: input.via,
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
  });
  log.info("whatsapp.connected", { businessId, via: input.via, phoneNumberId: input.phoneNumberId });
  await runHealthCheck(businessId);
  await syncTemplates(businessId).catch((err) => log.warn("whatsapp.template_sync_failed", { businessId, err }));
  return connectionView(businessId);
}

export async function connectWithEmbeddedSignup(
  businessId: string,
  input: { code: string; phoneNumberId: string; wabaId: string; pin?: string },
  actor: AuditActor,
) {
  if (!env.meta.appId || !env.meta.appSecret) {
    throw new ApiError(400, "Embedded Signup is not configured on this server (META_APP_ID / META_APP_SECRET).");
  }
  let token: { accessToken: string; expiresIn?: number };
  try {
    token = await exchangeCodeForToken(input.code);
  } catch (err) {
    const message = err instanceof GraphError ? err.friendly : "Meta did not accept the sign-in. Please try again.";
    await setStatus(businessId, { status: "error", lastError: message });
    throw new ApiError(400, message);
  }
  return finishConnection(
    businessId,
    { ...input, accessToken: token.accessToken, tokenExpiresIn: token.expiresIn, via: "embedded_signup" },
    actor,
  );
}

export async function connectManually(
  businessId: string,
  input: { accessToken: string; phoneNumberId: string; wabaId: string } | { useServerCredentials: true },
  actor: AuditActor,
) {
  const creds =
    "useServerCredentials" in input
      ? {
          accessToken: env.whatsapp.accessToken,
          phoneNumberId: env.whatsapp.phoneNumberId,
          wabaId: env.whatsapp.businessAccountId,
        }
      : input;
  if (!creds.accessToken || !creds.phoneNumberId || !creds.wabaId) {
    throw new ApiError(400, "Access token, phone number ID and WhatsApp Business Account ID are all required.");
  }
  return finishConnection(businessId, { ...creds, via: "manual" }, actor);
}

export async function disconnect(businessId: string, actor: AuditActor) {
  const found = await getConnection(businessId);
  if (!found) return connectionView(businessId);
  const token = decryptSecret(found.connection.accessTokenEnc);
  if (token && found.connection.wabaId) {
    await graph(`${found.connection.wabaId}/subscribed_apps`, { token, method: "DELETE" }).catch((err) =>
      log.warn("whatsapp.unsubscribe_failed", { businessId, err }),
    );
  }
  const s = await store();
  const batch = s.db.batch();
  if (found.phone) batch.delete(s.phoneNumbers.doc(found.phone.phoneNumberId));
  batch.update(s.whatsapp(businessId), {
    status: "disconnected",
    connectedVia: null,
    accessTokenEnc: null,
    registrationPinEnc: null,
    tokenExpiresAt: null,
    phone: null,
    health: [],
    lastError: null,
    connectedAt: null,
    updatedAt: new Date(),
  });
  await batch.commit();
  messagingCache.delete(businessId);
  publish(businessId, { type: "whatsapp.updated" });
  await audit(businessId, actor, "whatsapp.disconnected", { type: "whatsapp_connection" });
  return connectionView(businessId);
}

/** Connection Health (spec §6): account, phone, API access, webhook, messaging, bot. */
export async function runHealthCheck(businessId: string): Promise<HealthCheck[]> {
  const s = await store();
  const found = await getConnection(businessId);
  if (!found) return [];
  const { connection, phone } = found;
  const token = decryptSecret(connection.accessTokenEnc);
  const checks: HealthCheck[] = [];
  const push = (key: HealthCheck["key"], label: string, ok: boolean, detail: string) => checks.push({ key, label, ok, detail });

  let apiOk = false;
  if (!token || !phone) {
    push("api", "API access", false, "No access token is stored. Connect WhatsApp again.");
  } else {
    try {
      const info = await graph<PhoneInfo>(phone.phoneNumberId, {
        token,
        query: { fields: "display_phone_number,verified_name,quality_rating,platform_type" },
      });
      apiOk = true;
      push("api", "API access", true, "Access token is valid.");
      const registered = !info.platform_type || info.platform_type === "CLOUD_API";
      push(
        "phone",
        "Phone number",
        registered,
        registered
          ? `${info.display_phone_number ?? phone.displayPhoneNumber} (${info.verified_name ?? phone.verifiedName})`
          : "The number is not registered for the Cloud API yet.",
      );
      if (info.quality_rating && info.quality_rating !== phone.qualityRating) {
        await s.whatsapp(businessId).update({
          phone: { ...phone, qualityRating: info.quality_rating, displayPhoneNumber: info.display_phone_number ?? phone.displayPhoneNumber },
        });
      }
    } catch (err) {
      const detail = err instanceof GraphError ? err.friendly : "Could not reach WhatsApp.";
      push("api", "API access", false, detail);
      push("phone", "Phone number", false, "Could not verify the phone number.");
    }
  }

  if (token && connection.wabaId && apiOk) {
    try {
      const waba = await graph<{ id: string; name?: string }>(connection.wabaId, { token, query: { fields: "id,name" } });
      push("account", "WhatsApp account", true, waba.name ? `${waba.name} (${waba.id})` : waba.id);
    } catch (err) {
      push("account", "WhatsApp account", false, err instanceof GraphError ? err.friendly : "Could not load the business account.");
    }
  } else {
    push("account", "WhatsApp account", false, connection.wabaId ? "Could not verify the business account." : "No WhatsApp Business Account ID.");
  }

  // Webhook: the WABA must be subscribed to our app, and the app must point at our callback URL.
  const expected = `${env.appUrl}${WEBHOOK_PATH}`;
  let webhookOk = false;
  let webhookDetail = "Webhook not verified.";
  if (token && connection.wabaId && apiOk) {
    try {
      const subs = await graph<{ data?: { whatsapp_business_api_data?: { id?: string } }[] }>(`${connection.wabaId}/subscribed_apps`, { token });
      const subscribed = (subs.data ?? []).some((app) => !env.meta.appId || app.whatsapp_business_api_data?.id === env.meta.appId);
      webhookOk = subscribed;
      webhookDetail = subscribed ? "The business account is subscribed to this app." : "This app is not subscribed to the business account's webhooks.";
      if (subscribed && env.meta.appId && env.meta.appSecret) {
        const appSubs = await graph<{ data?: { object: string; callback_url?: string; active?: boolean; fields?: { name: string }[] }[] }>(
          `${env.meta.appId}/subscriptions`,
          { token: `${env.meta.appId}|${env.meta.appSecret}` },
        ).catch(() => null);
        const wa = appSubs?.data?.find((sub) => sub.object === "whatsapp_business_account");
        if (appSubs && !wa) {
          webhookOk = false;
          webhookDetail = `Add a WhatsApp webhook in the Meta app pointing to ${expected}.`;
        } else if (wa && wa.callback_url !== expected) {
          webhookOk = false;
          webhookDetail = `The Meta app's webhook points to ${wa.callback_url}; expected ${expected}.`;
        } else if (wa && !wa.fields?.some((field) => field.name === "messages")) {
          webhookOk = false;
          webhookDetail = "Subscribe the Meta app's webhook to the \"messages\" field.";
        }
      }
    } catch (err) {
      webhookDetail = err instanceof GraphError ? err.friendly : webhookDetail;
    }
  }
  if (!env.meta.appSecret) {
    webhookOk = false;
    webhookDetail = "META_APP_SECRET is not set, so incoming webhooks cannot be verified.";
  } else if (webhookOk && connection.lastWebhookEventAt) {
    webhookDetail += ` Last event ${connection.lastWebhookEventAt.toISOString()}.`;
  }
  push("webhook", "Webhook", webhookOk, webhookDetail);

  // Messaging permission: the token must carry whatsapp_business_messaging.
  if (token && apiOk) {
    const debug = await debugToken(token).catch(() => null);
    if (debug) {
      const ok = Boolean(debug.is_valid && debug.scopes?.includes("whatsapp_business_messaging"));
      push("messaging", "Messaging", ok, ok ? "whatsapp_business_messaging permission granted." : "The token is missing the whatsapp_business_messaging permission.");
    } else {
      push("messaging", "Messaging", true, "Token accepted by WhatsApp (set META_APP_SECRET to verify scopes).");
    }
  } else {
    push("messaging", "Messaging", false, "Messaging cannot be verified until API access works.");
  }

  const settings = fromDoc<BotSettings & { id: string }>(await s.bot(businessId).get());
  const aiConfig = resolveAIConfig(settings ?? null);
  push(
    "bot",
    "Bot",
    Boolean(settings?.aiEnabled !== false && aiConfig),
    settings?.aiEnabled === false ? "The AI assistant is turned off." : aiConfig ? `AI replies with ${aiConfig.provider} (${aiConfig.model}).` : "Add an AI API key in Bot settings.",
  );

  const order: HealthCheck["key"][] = ["account", "phone", "api", "webhook", "messaging", "bot"];
  checks.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  await s.whatsapp(businessId).update({
    health: checks,
    lastHealthCheckAt: new Date(),
    status: apiOk ? "connected" : "error",
    lastError: apiOk ? null : (checks.find((check) => check.key === "api")?.detail ?? null),
    updatedAt: new Date(),
  });
  publish(businessId, { type: "whatsapp.updated" });
  return checks;
}

const PURPOSE_GUESS: [RegExp, TemplatePurpose][] = [
  [/confirm/, "order_confirmed"],
  [/process|prepar/, "order_processing"],
  [/ready/, "order_ready"],
  [/dispatch|ship/, "order_dispatched"],
  [/deliver/, "order_delivered"],
  [/complet/, "order_completed"],
  [/reject/, "order_rejected"],
  [/cancel/, "order_cancelled"],
  [/payment|paid/, "payment_received"],
];

/** Pulls message templates and their approval status from Meta. */
export async function syncTemplates(businessId: string) {
  const credentials = await getCredentials(businessId);
  if (!credentials?.wabaId) throw new ApiError(400, "Templates come from the WhatsApp Business API. Connect it before syncing templates.");
  const data = await graph<{
    data?: { id: string; name: string; language: string; status: string; category: string; components?: { type: string; text?: string }[] }[];
  }>(`${credentials.wabaId}/message_templates`, {
    token: credentials.accessToken,
    query: { fields: "id,name,language,status,category,components", limit: "200" },
  });
  const s = await store();
  let count = 0;
  for (const template of data.data ?? []) {
    const body = template.components?.find((c) => c.type === "BODY")?.text ?? "";
    const variableCount = new Set(body.match(/\{\{\d+\}\}/g) ?? []).size;
    const ref = s.templates(businessId).doc(templateId(template.name, template.language));
    const existing = fromDoc<WhatsAppTemplate>(await ref.get());
    const status = (["APPROVED", "PENDING", "REJECTED", "PAUSED"].includes(template.status) ? template.status : "UNKNOWN") as WhatsAppTemplate["status"];
    const now = new Date();
    if (existing) {
      await ref.update({ status, body, category: template.category, metaTemplateId: template.id, updatedAt: now });
    } else {
      const purpose = PURPOSE_GUESS.find(([pattern]) => pattern.test(template.name))?.[1] ?? "other";
      await ref.set({
        name: template.name,
        language: template.language,
        category: template.category,
        status,
        body,
        purpose,
        variables: defaultVariables(purpose).slice(0, variableCount),
        metaTemplateId: template.id,
        createdAt: now,
        updatedAt: now,
      });
    }
    count += 1;
  }
  return count;
}

/** templates/{name__language}: the Meta template name + language is unique. */
export function templateId(name: string, language: string) {
  return `${name}__${language}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

export const TEMPLATE_VARIABLES = ["customer_name", "order_id", "total", "tracking", "business_name", "status"] as const;

export function defaultVariables(purpose: TemplatePurpose): string[] {
  if (purpose === "order_dispatched") return ["customer_name", "order_id", "tracking"];
  if (purpose === "order_confirmed" || purpose === "payment_received") return ["customer_name", "order_id", "total"];
  return ["customer_name", "order_id", "business_name"];
}
