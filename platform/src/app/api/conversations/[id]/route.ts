import { z } from "zod";
import { requireApiAuth } from "@/server/auth";
import { conversationDetail } from "@/server/admin/inbox";
import { setConversationAI, setConversationStatus } from "@/server/conversations";
import { json, readPatch, route } from "@/server/http";

export const GET = route("conversations.get", async (request, ctx: RouteContext<"/api/conversations/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  return json(await conversationDetail(auth.business.id, id));
});

const Patch = z.object({ aiEnabled: z.boolean(), status: z.enum(["active", "resolved"]) });

/** Pause/resume AI (spec §58) and resolve/reopen (spec §30). */
export const PATCH = route("conversations.update", async (request, ctx: RouteContext<"/api/conversations/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  const body = await readPatch(request, Patch);
  if (body.aiEnabled !== undefined) await setConversationAI(auth.business.id, id, body.aiEnabled, auth.actor);
  if (body.status) await setConversationStatus(auth.business.id, id, body.status, auth.actor);
  return json({ ok: true });
});
