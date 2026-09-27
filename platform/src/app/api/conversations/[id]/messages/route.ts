import { z } from "zod";
import { requireApiAuth } from "@/server/auth";
import { conversationMessages, sendManualReply } from "@/server/admin/inbox";
import { loadConversation } from "@/server/conversations";
import { cleanText, json, readJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export const GET = route("conversations.messages", async (request, ctx: RouteContext<"/api/conversations/[id]/messages">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  await loadConversation(auth.business.id, id);
  const before = new URL(request.url).searchParams.get("before");
  const date = before ? new Date(before) : undefined;
  return json({ messages: await conversationMessages(auth.business.id, id, date && !Number.isNaN(date.getTime()) ? date : undefined) });
});

const Body = z
  .object({
    text: cleanText(4096).optional(),
    templateId: z.string().uuid().optional(),
    variables: z.array(cleanText(500)).max(20).optional(),
  })
  .refine((b) => Boolean(b.text) !== Boolean(b.templateId), "Send either a text or a template");

/** Manual reply from the dashboard. */
export const POST = route("conversations.reply", async (request, ctx: RouteContext<"/api/conversations/[id]/messages">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  await rateLimit(`reply:${auth.user.id}`, 120, 60);
  const body = await readJson(request, Body);
  const { result, aiPaused } = await sendManualReply(auth, id, body);
  return json({ ...result, aiPaused }, { status: result.ok ? 200 : 422 });
});
