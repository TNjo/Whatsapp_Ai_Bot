import { requireApiAuth } from "@/server/auth";
import { deleteService, ServiceInput, updateService } from "@/server/admin/services";
import { json, readPatch, route } from "@/server/http";

export const PATCH = route("services.update", async (request, ctx: RouteContext<"/api/services/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  const input = await readPatch(request, ServiceInput);
  return json({ service: await updateService(auth.business.id, id, input, auth.actor) });
});

export const DELETE = route("services.delete", async (request, ctx: RouteContext<"/api/services/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  await deleteService(auth.business.id, id, auth.actor);
  return json({ ok: true });
});
