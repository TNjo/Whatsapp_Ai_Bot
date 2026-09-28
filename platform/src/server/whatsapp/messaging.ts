import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { graph, GraphError } from "./graph";

export type ButtonOption = { id: string; title: string };
export type ListRow = { id: string; title: string; description?: string };
export type ListSection = { title?: string; rows: ListRow[] };

/** Channel-neutral outbound message produced by the bot, the order system or an agent. */
export type OutboundMessage =
  | { kind: "text"; text: string }
  | { kind: "image"; text?: string; url: string }
  | { kind: "document"; text?: string; url: string; filename: string }
  | { kind: "buttons"; text: string; buttons: ButtonOption[]; header?: string; footer?: string }
  | { kind: "list"; text: string; buttonText: string; sections: ListSection[]; header?: string; footer?: string }
  | { kind: "template"; name: string; language: string; variables: string[]; preview: string };

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Text fallback when an interactive message can't be delivered (spec §16). */
export function toPlainText(message: OutboundMessage): string {
  switch (message.kind) {
    case "text":
      return message.text;
    case "image":
    case "document":
      return message.text ?? "";
    case "template":
      return message.preview;
    case "buttons":
      return [message.header, message.text, message.buttons.map((b, i) => `${i + 1}. ${b.title}`).join("\n"), message.footer]
        .filter(Boolean)
        .join("\n\n");
    case "list": {
      let n = 0;
      const rows = message.sections
        .flatMap((section) => section.rows)
        .map((row) => `${++n}. ${row.title}${row.description ? ` — ${row.description}` : ""}`);
      return [message.header, message.text, rows.join("\n"), "Reply with the number of your choice.", message.footer]
        .filter(Boolean)
        .join("\n\n");
    }
  }
}

export type Credentials = { accessToken: string; phoneNumberId: string };

type SendResponse = { messages?: { id: string }[] };

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/**
 * WhatsAppMessagingService — the only place that knows Cloud API message shapes.
 * The order system and the bot hand it channel-neutral OutboundMessages.
 */
export class WhatsAppMessagingService {
  private mediaCache = new Map<string, { id: string; at: number }>();

  constructor(private credentials: Credentials) {}

  private async post(to: string, payload: Record<string, unknown>): Promise<string> {
    const data = await graph<SendResponse>(`${this.credentials.phoneNumberId}/messages`, {
      token: this.credentials.accessToken,
      json: { messaging_product: "whatsapp", recipient_type: "individual", to, ...payload },
    });
    const id = data.messages?.[0]?.id;
    if (!id) throw new GraphError("WhatsApp did not return a message id.", 502);
    return id;
  }

  sendText(to: string, text: string) {
    return this.post(to, { type: "text", text: { body: clip(text, 4096), preview_url: false } });
  }

  async sendImage(to: string, url: string, caption?: string) {
    const media = await this.mediaRef(url);
    return this.post(to, { type: "image", image: { ...media, caption: caption ? clip(caption, 1024) : undefined } });
  }

  async sendDocument(to: string, url: string, filename: string, caption?: string) {
    const media = await this.mediaRef(url);
    return this.post(to, { type: "document", document: { ...media, filename, caption } });
  }

  sendButtons(to: string, message: Extract<OutboundMessage, { kind: "buttons" }>) {
    return this.post(to, {
      type: "interactive",
      interactive: {
        type: "button",
        header: message.header ? { type: "text", text: clip(message.header, 60) } : undefined,
        body: { text: clip(message.text, 1024) },
        footer: message.footer ? { text: clip(message.footer, 60) } : undefined,
        action: {
          buttons: message.buttons.slice(0, 3).map((button) => ({
            type: "reply",
            reply: { id: clip(button.id, 256), title: clip(button.title, 20) },
          })),
        },
      },
    });
  }

  sendList(to: string, message: Extract<OutboundMessage, { kind: "list" }>) {
    let remaining = 10;
    const sections = message.sections
      .map((section) => {
        const rows = section.rows.slice(0, remaining);
        remaining -= rows.length;
        return {
          title: section.title ? clip(section.title, 24) : undefined,
          rows: rows.map((row) => ({
            id: clip(row.id, 200),
            title: clip(row.title, 24),
            description: row.description ? clip(row.description, 72) : undefined,
          })),
        };
      })
      .filter((section) => section.rows.length);
    return this.post(to, {
      type: "interactive",
      interactive: {
        type: "list",
        header: message.header ? { type: "text", text: clip(message.header, 60) } : undefined,
        body: { text: clip(message.text, 1024) },
        footer: message.footer ? { text: clip(message.footer, 60) } : undefined,
        action: { button: clip(message.buttonText || "View options", 20), sections },
      },
    });
  }

  sendTemplate(to: string, name: string, language: string, variables: string[]) {
    return this.post(to, {
      type: "template",
      template: {
        name,
        language: { code: language },
        components: variables.length
          ? [{ type: "body", parameters: variables.map((text) => ({ type: "text", text: clip(text || "-", 1024) })) }]
          : undefined,
      },
    });
  }

  /**
   * Sends any OutboundMessage. Interactive formats fall back to plain text when
   * WhatsApp rejects them (e.g. unsupported client or invalid parameter).
   */
  async send(to: string, message: OutboundMessage): Promise<{ waMessageId: string; fellBackToText: boolean }> {
    try {
      switch (message.kind) {
        case "text":
          return { waMessageId: await this.sendText(to, message.text), fellBackToText: false };
        case "image":
          return { waMessageId: await this.sendImage(to, message.url, message.text), fellBackToText: false };
        case "document":
          return { waMessageId: await this.sendDocument(to, message.url, message.filename, message.text), fellBackToText: false };
        case "buttons":
          return { waMessageId: await this.sendButtons(to, message), fellBackToText: false };
        case "list":
          return { waMessageId: await this.sendList(to, message), fellBackToText: false };
        case "template":
          return { waMessageId: await this.sendTemplate(to, message.name, message.language, message.variables), fellBackToText: false };
      }
    } catch (err) {
      const interactive = message.kind === "buttons" || message.kind === "list" || message.kind === "image";
      if (interactive && err instanceof GraphError && !err.windowClosed && !err.tokenInvalid) {
        const text = toPlainText(message);
        if (text) return { waMessageId: await this.sendText(to, text), fellBackToText: true };
      }
      throw err;
    }
  }

  async markRead(waMessageId: string) {
    await graph(`${this.credentials.phoneNumberId}/messages`, {
      token: this.credentials.accessToken,
      json: { messaging_product: "whatsapp", status: "read", message_id: waMessageId },
    });
  }

  /** Public https links are sent as-is; local uploads are uploaded to WhatsApp media first. */
  private async mediaRef(url: string): Promise<{ link: string } | { id: string }> {
    if (/^https:\/\//i.test(url)) return { link: url };
    const cached = this.mediaCache.get(url);
    if (cached && Date.now() - cached.at < 20 * 86400 * 1000) return { id: cached.id };
    const filePath = localUploadPath(url);
    if (!filePath) throw new GraphError("This file is not available for sending.", 400);
    // Runtime uploads only — keep the bundler from tracing the whole project.
    const bytes = await fs.readFile(/*turbopackIgnore: true*/ filePath);
    const type = MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const form = new FormData();
    form.set("messaging_product", "whatsapp");
    form.set("type", type);
    form.set("file", new Blob([bytes], { type }), path.basename(filePath));
    const data = await graph<{ id: string }>(`${this.credentials.phoneNumberId}/media`, {
      token: this.credentials.accessToken,
      body: form,
      timeoutMs: 60_000,
    });
    this.mediaCache.set(url, { id: data.id, at: Date.now() });
    return { id: data.id };
  }
}

export const UPLOAD_ROOT = path.join(process.cwd(), ".data", "uploads");

/** Maps "/api/uploads/<businessId>/<file>" to a file inside the upload root, rejecting traversal. */
export function localUploadPath(url: string): string | null {
  const match = /^\/api\/uploads\/([A-Za-z0-9_-]{8,64})\/([A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp|pdf))$/.exec(url);
  if (!match) return null;
  const resolved = path.resolve(UPLOAD_ROOT, match[1], match[2]);
  return resolved.startsWith(UPLOAD_ROOT + path.sep) ? resolved : null;
}

/** Fetches incoming media from WhatsApp on demand (not stored permanently). */
export async function fetchIncomingMedia(accessToken: string, mediaId: string) {
  const meta = await graph<{ url?: string; mime_type?: string; file_size?: number }>(mediaId, { token: accessToken });
  if (!meta.url) throw new GraphError("Media is no longer available on WhatsApp.", 404);
  const res = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok || !res.body) throw new GraphError("Media is no longer available on WhatsApp.", res.status);
  return { body: res.body, mimeType: meta.mime_type ?? res.headers.get("content-type") ?? "application/octet-stream", size: meta.file_size };
}
