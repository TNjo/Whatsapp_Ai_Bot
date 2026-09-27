import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages } from "@/db/schema";
import { requireApiAuth } from "@/server/auth";
import { errorResponse, notFound } from "@/server/http";
import { connectionMode } from "@/server/whatsapp/channel";
import { getCredentials } from "@/server/whatsapp/connection";
import { webDownloadMedia } from "@/server/whatsapp/web";
import { GraphError } from "@/server/whatsapp/graph";
import { fetchIncomingMedia } from "@/server/whatsapp/messaging";

/**
 * Streams a customer's media from WhatsApp on demand. Nothing is stored on
 * disk; WhatsApp keeps media for about 30 days.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/media/[messageId]">) {
  try {
    const auth = await requireApiAuth(request);
    const { messageId } = await ctx.params;
    const db = await getDb();
    const [message] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.businessId, auth.business.id)));
    const mediaId = message?.payload.media?.id;
    if (!message || message.direction !== "inbound" || !mediaId) throw notFound("Media not found");
    if ((await connectionMode(auth.business.id)) === "web") {
      const media = message.waMessageId ? await webDownloadMedia(auth.business.id, message.waMessageId) : null;
      if (!media) throw notFound("Media is not available right now");
      return new Response(new Uint8Array(media.data), {
        headers: {
          "Content-Type": media.mimeType,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `inline; filename="${(media.filename ?? "media").replace(/[^\w.-]/g, "_")}"`,
        },
      });
    }
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
