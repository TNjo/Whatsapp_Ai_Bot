import { fromDoc, store } from "@/db";
import type { Message } from "@/db/schema";
import { requireApiAuth } from "@/server/auth";
import { errorResponse, notFound } from "@/server/http";
import { getCredentials } from "@/server/whatsapp/connection";
import { GraphError } from "@/server/whatsapp/graph";
import { fetchIncomingMedia } from "@/server/whatsapp/messaging";

/**
 * Streams a customer's media from WhatsApp on demand. Nothing is stored on
 * disk; WhatsApp keeps media for about 30 days.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/media/[conversationId]/[messageId]">) {
  try {
    const auth = await requireApiAuth(request);
    const { conversationId, messageId } = await ctx.params;
    const s = await store();
    const message = fromDoc<Message>(await s.messages(auth.business.id, conversationId).doc(messageId).get());
    const mediaId = message?.payload.media?.id;
    if (!message || message.direction !== "inbound" || !mediaId) throw notFound("Media not found");
    const credentials = await getCredentials(auth.business.id);
    if (!credentials) throw notFound("WhatsApp is not connected");
    const media = await fetchIncomingMedia(credentials.accessToken, mediaId);
    return new Response(media.body, {
      headers: {
        "Content-Type": media.mimeType,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="${(message.payload.media?.filename ?? "media").replace(/[^\w.-]/g, "_")}"`,
      },
    });
  } catch (err) {
    if (err instanceof GraphError) return Response.json({ error: err.friendly }, { status: 404 });
    return errorResponse(err, { route: "media.get" });
  }
}
