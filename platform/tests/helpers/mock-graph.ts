import http from "node:http";
import type { AddressInfo } from "node:net";

export type GraphCall = { method: string; path: string; query: Record<string, string>; body: Record<string, unknown> | null };

export const PHONE_NUMBER_ID = "109876543210";
export const WABA_ID = "208765432109";
export const DISPLAY_PHONE = "+94 77 000 0000";

/**
 * A tiny stand-in for graph.facebook.com that answers the Cloud API calls the
 * platform makes and records every request for assertions.
 */
export async function startMockGraph(opts: { appId: string; callbackUrl: string; templates?: unknown[] }) {
  const calls: GraphCall[] = [];
  let messageSeq = 0;
  let failNextSend: { code: number; message: string } | null = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> | null = null;
    if (raw && req.headers["content-type"]?.includes("json")) body = JSON.parse(raw);
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, "/");
    calls.push({ method: req.method ?? "GET", path, query: Object.fromEntries(url.searchParams), body });

    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (path === `/${PHONE_NUMBER_ID}/messages` && req.method === "POST") {
      if (body?.status === "read") return send(200, { success: true });
      if (failNextSend) {
        const error = failNextSend;
        failNextSend = null;
        return send(400, { error: { code: error.code, message: error.message, type: "OAuthException" } });
      }
      messageSeq += 1;
      return send(200, { messaging_product: "whatsapp", contacts: [{ wa_id: body?.to }], messages: [{ id: `wamid.MOCK${messageSeq}` }] });
    }
    if (path === `/${PHONE_NUMBER_ID}` && req.method === "GET") {
      return send(200, { id: PHONE_NUMBER_ID, display_phone_number: DISPLAY_PHONE, verified_name: "UrbanStyle", quality_rating: "GREEN", platform_type: "CLOUD_API" });
    }
    if (path === `/${WABA_ID}` && req.method === "GET") return send(200, { id: WABA_ID, name: "UrbanStyle WABA" });
    if (path === `/${WABA_ID}/subscribed_apps`) {
      if (req.method === "GET") return send(200, { data: [{ whatsapp_business_api_data: { id: opts.appId, name: "Test App" } }] });
      return send(200, { success: true });
    }
    if (path === `/${opts.appId}/subscriptions`) {
      return send(200, { data: [{ object: "whatsapp_business_account", callback_url: opts.callbackUrl, active: true, fields: [{ name: "messages", version: "v23.0" }] }] });
    }
    if (path === "/debug_token") {
      return send(200, { data: { is_valid: true, app_id: opts.appId, scopes: ["whatsapp_business_messaging", "whatsapp_business_management"] } });
    }
    if (path === `/${WABA_ID}/message_templates`) return send(200, { data: opts.templates ?? [] });
    if (path === "/oauth/access_token") return send(200, { access_token: "EAAembeddedsignuptoken1234567890", token_type: "bearer" });
    return send(404, { error: { code: 100, message: `Unhandled mock path ${req.method} ${path}` } });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    /** Outgoing customer messages (excluding read receipts). */
    sent: () => calls.filter((c) => c.path === `/${PHONE_NUMBER_ID}/messages` && c.body?.status !== "read").map((c) => c.body!),
    failNextSend: (code: number, message: string) => {
      failNextSend = { code, message };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Text a sent message would show to the customer. */
export function sentText(body: Record<string, unknown>): string {
  const type = body.type as string;
  if (type === "text") return (body.text as { body: string }).body;
  if (type === "interactive") return ((body.interactive as { body: { text: string } }).body.text) ?? "";
  if (type === "template") {
    const t = body.template as { name: string; components?: { parameters: { text: string }[] }[] };
    return `[template ${t.name}] ${t.components?.[0]?.parameters.map((p) => p.text).join(" | ") ?? ""}`;
  }
  if (type === "image") return (body.image as { caption?: string }).caption ?? "";
  return "";
}
