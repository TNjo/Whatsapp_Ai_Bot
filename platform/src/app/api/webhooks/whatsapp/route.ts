import { after } from "next/server";
import { env } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { log } from "@/server/logger";
import { clientIp, rateLimit } from "@/server/rate-limit";
import { processWebhook, verifySignature, type WebhookPayload } from "@/server/whatsapp/webhook";

/** Meta webhook verification handshake. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  const expected = env.meta.webhookVerifyToken;
  if (mode === "subscribe" && expected && safeEqual(token, expected)) {
    log.info("webhook.verified");
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  log.warn("webhook.verify_rejected", { mode });
  return new Response("Forbidden", { status: 403 });
}

/** Incoming WhatsApp events. Signature-checked, acknowledged at once, processed after the response. */
export async function POST(request: Request) {
  try {
    await rateLimit(`webhook:${clientIp(request)}`, 2000, 60);
  } catch {
    return new Response("Too Many Requests", { status: 429 });
  }
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"))) {
    log.warn("webhook.bad_signature", { ip: clientIp(request) });
    return new Response("Invalid signature", { status: 401 });
  }
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  log.info("webhook.received", {
    entries: payload.entry?.length ?? 0,
    messages: payload.entry?.reduce((n, e) => n + (e.changes ?? []).reduce((m, c) => m + (c.value?.messages?.length ?? 0), 0), 0),
  });
  after(async () => {
    try {
      await processWebhook(payload);
    } catch (err) {
      log.error("webhook.processing_failed", { err });
    }
  });
  return new Response("OK", { status: 200 });
}
