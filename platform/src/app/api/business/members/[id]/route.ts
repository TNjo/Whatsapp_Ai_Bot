import { requireApiAuth } from "@/server/auth";
import { removeMember } from "@/server/admin/business-settings";
import { json, route } from "@/server/http";

export const DELETE = route("business.members.delete", async (request, ctx: RouteContext<"/api/business/members/[id]">) => {
  const auth = await requireApiAuth(request, "owner");
  const { id } = await ctx.params;
  await removeMember(auth.business.id, id, auth.actor);
  return json({ ok: true });
});
