import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { customers, whatsappConnections, whatsappPhoneNumbers, type HealthCheck, type MessagePayload, type MessageType } from "@/db/schema";
import { audit, type AuditActor } from "../audit";
import { resolveAIConfig } from "../ai/service";
import { ensureBotSettings } from "../bot/settings";
import { getOrCreateConversation, insertOutboundRecord, setConversationAI, upsertCustomer } from "../conversations";
import { publish } from "../events";
import { ApiError } from "../http";
import { log } from "../logger";
import { notify } from "../notifications";
import { localUploadPath, toPlainText, type OutboundMessage } from "./messaging";
import { applyMessageStatus } from "./message-status";

/**
 * Linked-device connection (QR code) — WhatsApp Web automation via whatsapp-web.js.
 * UNOFFICIAL: WhatsApp may restrict numbers that are automated this way. It lets
 * ordinary (personal or Business-app) numbers use the same bot, inbox and orders.
 */

export type WebMessage = {
  id: { _serialized: string };
  from: string;
  to: string;
  fromMe: boolean;
  body: string;
  type: string;
  timestamp: number;
  isStatus?: boolean;
  broadcast?: boolean;
  hasMedia?: boolean;
  location?: { latitude: string | number; longitude: string | number; description?: string; name?: string; address?: string };
  selectedButtonId?: string;
  selectedRowId?: string;
  _data?: { notifyName?: string; mimetype?: string; filename?: string; caption?: string };
  downloadMedia?: () => Promise<{ mimetype: string; data: string; filename?: string | null } | undefined>;
};

export interface WebClientLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- whatsapp-web.js passes event-specific arguments
  on(event: string, listener: (...args: any[]) => void): unknown;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  logout(): Promise<void>;
  sendMessage(chatId: string, content: unknown, options?: Record<string, unknown>): Promise<{ id: { _serialized: string } }>;
  sendSeen?(chatId: string): Promise<unknown>;
  getMessageById?(id: string): Promise<WebMessage | null>;
  getContactLidAndPhone?(ids: string[]): Promise<{ lid: string; pn: string }[]>;
  info?: { wid?: { user?: string; _serialized?: string }; pushname?: string };
}

export type WebDriver = {
  createClient(businessId: string): WebClientLike;
  mediaFromFile(filePath: string): unknown;
  mediaFromUrl(url: string): Promise<unknown>;
};

export type LinkStatus = "idle" | "starting" | "qr" | "authenticated" | "ready" | "disconnected" | "error";

type Entry = {
  businessId: string;
  client: WebClientLike;
  status: LinkStatus;
  qr: string | null;
  error: string | null;
  readyAt: number;
  resumed: boolean;
  /** Ids of messages this server sent, so echoes from message_create are not mistaken for the owner typing. */
  sent: Set<string>;
};

export const SESSION_ROOT = path.join(process.cwd(), ".data", "wa-web");
const NOISE = new Set([
  "e2e_notification",
  "notification_template",
  "gp2",
  "protocol",
  "ciphertext",
  "call_log",
  "revoked",
  "group_notification",
  "broadcast_notification",
  "debug",
]);

const globalRef = globalThis as unknown as { __wabWeb?: Map<string, Entry>; __wabWebDriver?: WebDriver };
const entries = (globalRef.__wabWeb ??= new Map<string, Entry>());

/** Tests inject a fake driver; production lazily loads whatsapp-web.js (headless Chrome). */
export function setWebDriver(driver: WebDriver | undefined) {
  globalRef.__wabWebDriver = driver;
}

async function driver(): Promise<WebDriver> {
  if (globalRef.__wabWebDriver) return globalRef.__wabWebDriver;
  const mod = await import("whatsapp-web.js");
  const lib = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof import("whatsapp-web.js");
  globalRef.__wabWebDriver = {
    createClient: (businessId) =>
      new lib.Client({
        authStrategy: new lib.LocalAuth({ clientId: businessId, dataPath: SESSION_ROOT }),
        puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] },
      }) as unknown as WebClientLike,
    mediaFromFile: (filePath) => lib.MessageMedia.fromFilePath(filePath),
    mediaFromUrl: (url) => lib.MessageMedia.fromUrl(url, { unsafeMime: true }),
  };
  return globalRef.__wabWebDriver;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

export function linkState(businessId: string) {
  const entry = entries.get(businessId);
  return { status: entry?.status ?? ("idle" as LinkStatus), qr: entry?.qr ?? null, error: entry?.error ?? null };
}

export function isWebReady(businessId: string) {
  return entries.get(businessId)?.status === "ready";
}

async function setConnection(businessId: string, values: Partial<typeof whatsappConnections.$inferInsert>) {
  const db = await getDb();
  await db
    .insert(whatsappConnections)
    .values({ businessId, ...values })
    .onConflictDoUpdate({ target: whatsappConnections.businessId, set: values });
  publish(businessId, { type: "whatsapp.updated" });
}

async function removeSession(businessId: string) {
  await fs.rm(path.join(SESSION_ROOT, `session-${businessId}`), { recursive: true, force: true }).catch(() => undefined);
}

async function dropClient(entry: Entry) {
  if (entries.get(entry.businessId) === entry) entries.delete(entry.businessId);
  await withTimeout(entry.client.destroy(), 15_000).catch(() => undefined);
}

/**
 * Starts linking (shows a QR code) or, with `resume`, reconnects a saved session
 * after a server restart without a new scan.
 */
export async function startLink(businessId: string, actor: AuditActor | null, { resume = false } = {}) {
  const db = await getDb();
  const [connection] = await db.select().from(whatsappConnections).where(eq(whatsappConnections.businessId, businessId));
  if (connection?.status === "connected" && connection.connectedVia !== "qr") {
    throw new ApiError(409, "Disconnect the WhatsApp Business API connection before linking another number.");
  }
  const existing = entries.get(businessId);
  if (existing && ["starting", "qr", "authenticated", "ready"].includes(existing.status)) return linkState(businessId);
  if (existing) await dropClient(existing);

  const entry: Entry = {
    businessId,
    client: (await driver()).createClient(businessId),
    status: "starting",
    qr: null,
    error: null,
    readyAt: 0,
    resumed: resume,
    sent: new Set(),
  };
  entries.set(businessId, entry);
  if (!resume) await setConnection(businessId, { status: "connecting", connectedVia: "qr", lastError: null });
  wire(entry);
  entry.client.initialize().catch((err) => fail(entry, err instanceof Error ? err.message : "WhatsApp Web could not start."));
  if (actor) await audit(businessId, actor, "whatsapp.link_started", { type: "whatsapp_connection" });
  log.info("whatsapp.web.starting", { businessId, resume });
  return linkState(businessId);
}

async function fail(entry: Entry, message: string) {
  if (entries.get(entry.businessId) !== entry) return;
  entry.status = "error";
  entry.error = message;
  entry.qr = null;
  log.warn("whatsapp.web.failed", { businessId: entry.businessId, message });
  await setConnection(entry.businessId, { status: "error", lastError: message });
  await dropClient(entry);
}

function wire(entry: Entry) {
  const { client, businessId } = entry;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const on = (event: string, listener: (...args: any[]) => void) => client.on(event, listener);

  on("qr", async (qr: string) => {
    try {
      entry.qr = await QRCode.toDataURL(qr, { width: 360, margin: 1 });
      const firstQr = entry.status !== "qr";
      entry.status = "qr";
      if (entry.resumed && firstQr) {
        // The saved session expired: the owner has to scan again.
        await setConnection(businessId, { status: "connecting", lastError: "The saved WhatsApp session expired. Scan the QR code again." });
        await notify(businessId, {
          type: "whatsapp_status",
          title: "Link WhatsApp again",
          body: "The saved WhatsApp session expired. Open the WhatsApp page and scan the new QR code.",
          link: "/dashboard/whatsapp",
        });
      }
      publish(businessId, { type: "whatsapp.updated" });
    } catch (err) {
      log.warn("whatsapp.web.qr_failed", { businessId, err });
    }
  });
  on("authenticated", () => {
    entry.status = "authenticated";
    entry.qr = null;
    publish(businessId, { type: "whatsapp.updated" });
  });
  on("auth_failure", (message: string) => {
    void fail(entry, `Linking failed: ${String(message || "authentication failed")}. Scan a new QR code.`).then(() => removeSession(businessId));
  });
  on("ready", () => {
    onReady(entry).catch((err) => log.error("whatsapp.web.ready_failed", { businessId, err }));
  });
  on("disconnected", (reason: string) => {
    onDisconnected(entry, String(reason || "")).catch((err) => log.error("whatsapp.web.disconnect_failed", { businessId, err }));
  });
  on("message", (msg: WebMessage) => {
    onIncoming(entry, msg).catch((err) => log.error("whatsapp.web.incoming_failed", { businessId, err }));
  });
  on("message_create", (msg: WebMessage) => {
    if (msg.fromMe) onOwnMessage(entry, msg).catch((err) => log.error("whatsapp.web.own_message_failed", { businessId, err }));
  });
  on("message_ack", (msg: WebMessage, ack: number) => {
    const status = ack === -1 ? "failed" : ack >= 3 ? "read" : ack === 2 ? "delivered" : ack === 1 ? "sent" : null;
    if (status) applyMessageStatus(businessId, msg.id._serialized, status).catch(() => undefined);
  });
}

async function onReady(entry: Entry) {
  const { businessId, client } = entry;
  const wid = client.info?.wid?.user || String(client.info?.wid?._serialized ?? "").split("@")[0].replace(/\D/g, "");
  const pushname = client.info?.pushname ?? "";
  const phone = wid ? `+${wid}` : "";
  const db = await getDb();

  // One number, one business: refuse a number another business already uses.
  if (phone) {
    const [taken] = await db
      .select({ businessId: whatsappPhoneNumbers.businessId })
      .from(whatsappPhoneNumbers)
      .where(and(eq(whatsappPhoneNumbers.displayPhoneNumber, phone), ne(whatsappPhoneNumbers.businessId, businessId)));
    if (taken) {
      await withTimeout(client.logout(), 15_000).catch(() => undefined);
      await fail(entry, "This WhatsApp number is already connected to another business.");
      await removeSession(businessId);
      return;
    }
  }

  entry.status = "ready";
  entry.readyAt = Date.now();
  entry.error = null;
  entry.qr = null;
  await db.transaction(async (tx) => {
    const [connection] = await tx
      .insert(whatsappConnections)
      .values({ businessId, status: "connected", connectedVia: "qr", lastError: null, connectedAt: new Date() })
      .onConflictDoUpdate({
        target: whatsappConnections.businessId,
        set: {
          status: "connected",
          connectedVia: "qr",
          lastError: null,
          wabaId: null,
          wabaName: null,
          accessTokenEnc: null,
          ...(entry.resumed ? {} : { connectedAt: new Date() }),
        },
      })
      .returning();
    await tx.delete(whatsappPhoneNumbers).where(eq(whatsappPhoneNumbers.businessId, businessId));
    await tx.insert(whatsappPhoneNumbers).values({
      businessId,
      connectionId: connection.id,
      phoneNumberId: `web:${businessId}`,
      displayPhoneNumber: phone,
      verifiedName: pushname,
      isPrimary: true,
    });
  });
  await webHealthCheck(businessId);
  if (!entry.resumed) await audit(businessId, { name: "system" }, "whatsapp.linked", { type: "whatsapp_connection" }, { phone });
  log.info("whatsapp.web.ready", { businessId, resumed: entry.resumed });
  publish(businessId, { type: "whatsapp.updated" });
}

async function onDisconnected(entry: Entry, reason: string) {
  const { businessId } = entry;
  if (entries.get(businessId) !== entry) return;
  const loggedOut = /logout|unpaired/i.test(reason);
  entry.status = "disconnected";
  entry.error = loggedOut ? "This device was unlinked from the phone." : `Disconnected${reason ? `: ${reason}` : ""}`;
  await setConnection(businessId, { status: loggedOut ? "disconnected" : "error", lastError: entry.error });
  await dropClient(entry);
  if (loggedOut) await removeSession(businessId);
  await notify(businessId, {
    type: "whatsapp_status",
    title: "WhatsApp disconnected",
    body: loggedOut ? "The linked device was removed on the phone. Link it again to keep replying." : entry.error,
    link: "/dashboard/whatsapp",
  });
}

/** "9477…@c.us" → 9477…; "…@lid" → resolved phone number when WhatsApp shares it. */
async function identify(entry: Entry, chatId: string) {
  const [user, server] = chatId.split("@");
  if (server === "c.us") return { waId: user.replace(/\D/g, "") };
  if (server === "lid") {
    try {
      const [pair] = (await entry.client.getContactLidAndPhone?.([chatId])) ?? [];
      const pn = pair?.pn?.split("@")[0]?.replace(/\D/g, "");
      if (pn) return { waId: pn };
    } catch {
      // fall through to the lid itself
    }
    return { waId: `lid:${user}` };
  }
  return null;
}

function normalize(msg: WebMessage): { type: MessageType; content: string; payload: MessagePayload } {
  const caption = msg._data?.caption ?? (msg.type === "chat" ? "" : msg.body) ?? "";
  const media = (): MessagePayload => ({
    media: { id: msg.id._serialized, mimeType: msg._data?.mimetype, filename: msg._data?.filename, caption: caption || undefined },
  });
  switch (msg.type) {
    case "chat":
      return { type: "text", content: msg.body ?? "", payload: {} };
    case "image":
    case "video":
    case "sticker":
      return { type: msg.type, content: msg.type === "sticker" ? "" : caption, payload: media() };
    case "audio":
    case "ptt":
      return { type: "audio", content: "", payload: media() };
    case "document":
      return { type: "document", content: caption || msg._data?.filename || "", payload: media() };
    case "location":
      return {
        type: "location",
        content: [msg.location?.name ?? msg.location?.description, msg.location?.address].filter(Boolean).join(", "),
        payload: msg.location
          ? { location: { latitude: Number(msg.location.latitude), longitude: Number(msg.location.longitude), name: msg.location.description } }
          : {},
      };
    case "buttons_response":
    case "list_response":
      return {
        type: "interactive",
        content: msg.body ?? "",
        payload: { interactive: { kind: "reply", replyId: msg.selectedButtonId ?? msg.selectedRowId } },
      };
    case "vcard":
    case "multi_vcard":
      return { type: "contacts", content: "", payload: {} };
    default:
      return { type: "unsupported", content: msg.body ?? "", payload: {} };
  }
}

async function onIncoming(entry: Entry, msg: WebMessage) {
  const chatId = String(msg.from || "");
  if (msg.fromMe || msg.isStatus || msg.broadcast) return;
  if (!/@(c\.us|lid)$/.test(chatId)) return; // groups, broadcasts, newsletters
  if (NOISE.has(msg.type)) return;
  if (entry.readyAt && msg.timestamp * 1000 < entry.readyAt - 120_000) return; // backlog after reconnect
  const who = await identify(entry, chatId);
  if (!who) return;
  const normalized = normalize(msg);
  log.info("whatsapp.web.message", { businessId: entry.businessId, type: msg.type });
  const { handleIncoming } = await import("../bot/engine");
  await handleIncoming({
    businessId: entry.businessId,
    waId: who.waId,
    waChatId: chatId,
    profileName: msg._data?.notifyName,
    message: { waMessageId: msg.id._serialized, type: normalized.type, content: normalized.content, payload: normalized.payload },
  });
}

/** The owner typed on the phone: record it in the inbox and let the human take over from the AI. */
async function onOwnMessage(entry: Entry, msg: WebMessage) {
  const id = msg.id._serialized;
  const chatId = String(msg.to || "");
  if (!/@(c\.us|lid)$/.test(chatId) || NOISE.has(msg.type)) return;
  // Messages we send also emit message_create; give our own bookkeeping time to record the id.
  await new Promise((resolve) => setTimeout(resolve, process.env.NODE_ENV === "test" ? 50 : 2000));
  if (entry.sent.has(id)) return;
  const db = await getDb();
  const { messages } = await import("@/db/schema");
  const [known] = await db.select({ id: messages.id }).from(messages).where(eq(messages.waMessageId, id));
  if (known) return;

  const who = await identify(entry, chatId);
  if (!who) return;
  const { customer } = await upsertCustomer(entry.businessId, { waId: who.waId, waChatId: chatId });
  const { conversation } = await getOrCreateConversation(entry.businessId, customer.id);
  const normalized = normalize(msg);
  const record = await insertOutboundRecord(entry.businessId, conversation.id, {
    sender: "agent",
    type: normalized.type,
    content: normalized.content,
    payload: normalized.payload,
  });
  await db.update(messages).set({ status: "sent", waMessageId: id, statusUpdatedAt: new Date() }).where(eq(messages.id, record.id));
  publish(entry.businessId, { type: "message.created", conversationId: conversation.id, messageId: record.id, direction: "outbound" });
  if (conversation.aiEnabled) await setConversationAI(entry.businessId, conversation.id, false, { name: "Owner (phone)" });
}

export class WebLinkError extends Error {}

function chatIdFor(customer: typeof customers.$inferSelect) {
  if (customer.waChatId) return customer.waChatId;
  if (/^\d+$/.test(customer.waId)) return `${customer.waId}@c.us`;
  throw new WebLinkError("This customer can't be reached through the linked WhatsApp.");
}

/** Sends through the linked device. Buttons and lists become numbered text. */
export async function webSend(businessId: string, customer: typeof customers.$inferSelect, message: OutboundMessage): Promise<string> {
  const entry = entries.get(businessId);
  if (!entry || entry.status !== "ready") throw new WebLinkError("The linked WhatsApp is reconnecting. Try again in a moment.");
  const chatId = chatIdFor(customer);
  let content: unknown = toPlainText(message);
  let options: Record<string, unknown> | undefined;
  if (message.kind === "image" || message.kind === "document") {
    try {
      const d = await driver();
      const filePath = localUploadPath(message.url);
      content = filePath ? d.mediaFromFile(filePath) : await d.mediaFromUrl(message.url);
      options = { caption: message.text || undefined, ...(message.kind === "document" ? { sendMediaAsDocument: true } : {}) };
    } catch (err) {
      log.warn("whatsapp.web.media_failed", { businessId, err });
      content = message.text || message.url;
    }
  }
  const sent = await entry.client.sendMessage(chatId, content, options);
  const id = sent.id._serialized;
  entry.sent.add(id);
  if (entry.sent.size > 5000) entry.sent.clear();
  return id;
}

export async function webMarkRead(businessId: string, customer: typeof customers.$inferSelect) {
  const entry = entries.get(businessId);
  if (!entry || entry.status !== "ready" || !entry.client.sendSeen) return;
  await entry.client.sendSeen(chatIdFor(customer)).catch(() => undefined);
}

export async function webDownloadMedia(businessId: string, waMessageId: string) {
  const entry = entries.get(businessId);
  if (!entry || entry.status !== "ready" || !entry.client.getMessageById) return null;
  const msg = await entry.client.getMessageById(waMessageId);
  const media = await msg?.downloadMedia?.();
  return media ? { mimeType: media.mimetype, data: Buffer.from(media.data, "base64"), filename: media.filename ?? undefined } : null;
}

/** Cancels an in-progress link (QR not scanned yet). */
export async function cancelLink(businessId: string) {
  const entry = entries.get(businessId);
  if (entry && entry.status !== "ready") {
    await dropClient(entry);
    await setConnection(businessId, { status: "disconnected", lastError: null });
  }
  return linkState(businessId);
}

/** Logs the device out on WhatsApp, deletes the saved session and clears the connection. */
export async function unlinkWeb(businessId: string) {
  const entry = entries.get(businessId);
  if (entry) {
    await withTimeout(entry.client.logout(), 15_000).catch(() => undefined);
    await dropClient(entry);
  }
  await removeSession(businessId);
}

export async function webHealthCheck(businessId: string): Promise<HealthCheck[]> {
  const db = await getDb();
  const state = linkState(businessId);
  const [phone] = await db.select().from(whatsappPhoneNumbers).where(eq(whatsappPhoneNumbers.businessId, businessId));
  const settings = await ensureBotSettings(businessId);
  const ai = resolveAIConfig(settings);
  const ready = state.status === "ready";
  const checks: HealthCheck[] = [
    { key: "account", label: "Linked device", ok: ready, detail: ready ? "WhatsApp Web session is active (unofficial connection)." : state.error ?? "Reconnecting to WhatsApp Web…" },
    { key: "phone", label: "Phone number", ok: Boolean(phone?.displayPhoneNumber), detail: phone ? `${phone.displayPhoneNumber}${phone.verifiedName ? ` (${phone.verifiedName})` : ""}` : "Not linked yet." },
    { key: "api", label: "Session", ok: ready, detail: ready ? "Saved on this server; survives restarts until unlinked on the phone." : "Waiting for WhatsApp Web." },
    { key: "webhook", label: "Incoming messages", ok: ready, detail: "Linked devices receive messages directly — no webhook needed." },
    { key: "messaging", label: "Messaging", ok: ready, detail: "No 24-hour window or templates on linked devices. Keep the phone online occasionally." },
    {
      key: "bot",
      label: "Bot",
      ok: Boolean(settings.aiEnabled && ai),
      detail: !settings.aiEnabled ? "The AI assistant is turned off." : ai ? `AI replies with ${ai.provider} (${ai.model}).` : "Add an AI API key in Bot settings.",
    },
  ];
  await db
    .update(whatsappConnections)
    .set({ health: checks, lastHealthCheckAt: new Date() })
    .where(eq(whatsappConnections.businessId, businessId));
  return checks;
}

/** On server start: reconnect every saved linked device without a new scan. */
export async function resumeLinkedDevices() {
  const db = await getDb();
  const rows = await db
    .select({ businessId: whatsappConnections.businessId })
    .from(whatsappConnections)
    .where(and(eq(whatsappConnections.connectedVia, "qr"), eq(whatsappConnections.status, "connected")));
  for (const row of rows) {
    await startLink(row.businessId, null, { resume: true }).catch((err) => log.warn("whatsapp.web.resume_failed", { businessId: row.businessId, err }));
  }
  return rows.length;
}
