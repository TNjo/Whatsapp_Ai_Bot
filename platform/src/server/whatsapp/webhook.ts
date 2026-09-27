import "server-only";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { whatsappConnections, type MessagePayload, type MessageType } from "@/db/schema";
import { handleIncoming } from "../bot/engine";
import { env } from "../env";
import { log } from "../logger";
import { businessForPhoneNumberId } from "./connection";
import { describeGraphError, type GraphErrorBody } from "./graph";
import { applyMessageStatus } from "./message-status";

/** Validates X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret). */
export function verifySignature(rawBody: string, header: string | null, secret = env.meta.appSecret): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const given = header.slice("sha256=".length);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

type WaMessage = {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  interactive?: {
    type: "button_reply" | "list_reply" | string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
    nfm_reply?: { name?: string; body?: string; response_json?: string };
  };
  button?: { payload?: string; text: string };
  reaction?: { message_id: string; emoji?: string };
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
  context?: { id?: string; from?: string };
  errors?: GraphErrorBody[];
};

type WaStatus = {
  id: string;
  status: "sent" | "delivered" | "read" | "failed" | string;
  timestamp?: string;
  recipient_id?: string;
  errors?: GraphErrorBody[];
};

type ChangeValue = {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id: string }[];
  messages?: WaMessage[];
  statuses?: WaStatus[];
};

export type WebhookPayload = {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: ChangeValue }[] }[];
};

/** Maps any WhatsApp message type to our stored shape. */
export function normalizeMessage(msg: WaMessage): { type: MessageType; content: string; payload: MessagePayload } {
  const media = (m: { id: string; mime_type?: string; caption?: string; filename?: string } | undefined) =>
    m ? { id: m.id, mimeType: m.mime_type, caption: m.caption, filename: m.filename } : undefined;
  switch (msg.type) {
    case "text":
      return { type: "text", content: msg.text?.body ?? "", payload: {} };
    case "image":
      return { type: "image", content: msg.image?.caption ?? "", payload: { media: media(msg.image) } };
    case "video":
      return { type: "video", content: msg.video?.caption ?? "", payload: { media: media(msg.video) } };
    case "audio":
      return { type: "audio", content: "", payload: { media: media(msg.audio) } };
    case "document":
      return { type: "document", content: msg.document?.caption ?? msg.document?.filename ?? "", payload: { media: media(msg.document) } };
    case "sticker":
      return { type: "sticker", content: "", payload: { media: media(msg.sticker) } };
    case "location":
      return {
        type: "location",
        content: [msg.location?.name, msg.location?.address].filter(Boolean).join(", "),
        payload: msg.location ? { location: msg.location } : {},
      };
    case "interactive": {
      const reply = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      if (reply) {
        return { type: "interactive", content: reply.title, payload: { interactive: { kind: "reply", replyId: reply.id } } };
      }
      return { type: "interactive", content: msg.interactive?.nfm_reply?.body ?? "", payload: {} };
    }
    case "button":
      return {
        type: "button",
        content: msg.button?.text ?? "",
        payload: { interactive: { kind: "reply", replyId: msg.button?.payload } },
      };
    case "reaction":
      return { type: "reaction", content: msg.reaction?.emoji ?? "", payload: {} };
    case "contacts": {
      const contact = msg.contacts?.[0];
      return {
        type: "contacts",
        content: [contact?.name?.formatted_name, contact?.phones?.[0]?.phone].filter(Boolean).join(" "),
        payload: {},
      };
    }
    default:
      return { type: "unsupported", content: "", payload: { error: msg.errors?.[0] ? { code: msg.errors[0].code, title: msg.errors[0].message } : undefined } };
  }
}

async function applyStatus(businessId: string, status: WaStatus) {
  if (status.status === "failed") {
    await applyMessageStatus(businessId, status.id, "failed", describeGraphError(status.errors?.[0], 400).friendly);
  } else if (status.status === "sent" || status.status === "delivered" || status.status === "read") {
    await applyMessageStatus(businessId, status.id, status.status);
  }
}

/**
 * Processes a verified webhook payload. Runs after the HTTP 200 has been sent,
 * so Meta never waits on the AI.
 */
export async function processWebhook(payload: WebhookPayload) {
  if (payload.object !== "whatsapp_business_account") return;
  const db = await getDb();
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const owner = await businessForPhoneNumberId(phoneNumberId);
      if (!owner) {
        log.warn("webhook.unknown_phone_number", { phoneNumberId });
        continue;
      }
      const { businessId } = owner;
      await db
        .update(whatsappConnections)
        .set({ lastWebhookEventAt: new Date() })
        .where(eq(whatsappConnections.id, owner.connectionId));

      for (const status of value.statuses ?? []) {
        try {
          await applyStatus(businessId, status);
        } catch (err) {
          log.error("webhook.status_failed", { businessId, err });
        }
      }

      for (const msg of value.messages ?? []) {
        const contact = value.contacts?.find((c) => c.wa_id === msg.from) ?? value.contacts?.[0];
        const normalized = normalizeMessage(msg);
        log.info("webhook.message", { businessId, type: msg.type, waMessageId: msg.id });
        try {
          await handleIncoming({
            businessId,
            waId: msg.from,
            profileName: contact?.profile?.name,
            message: {
              waMessageId: msg.id,
              type: normalized.type,
              content: normalized.content,
              payload: normalized.payload,
              // Server receive time: keeps ordering consistent with our own review/confirmation timestamps.
              timestamp: new Date(),
            },
          });
        } catch (err) {
          log.error("webhook.message_failed", { businessId, waMessageId: msg.id, err });
        }
      }
    }
  }
}
