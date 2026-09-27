import { requireApiAuth } from "@/server/auth";
import { deleteTemplate, TemplateInput, updateTemplate } from "@/server/admin/whatsapp";
import { json, readPatch, route } from "@/server/http";

export const PATCH = route("templates.update", async (request, ctx: RouteContext<"/api/whatsapp/templates/[id]">) => {
  const auth = await requireApiAuth(request, "owner");
  const { id } = await ctx.params;
  const input = await readPatch(request, TemplateInput);
  return json({ template: await updateTemplate(auth.business.id, id, input, auth.actor) });
});

export const DELETE = route("templates.delete", async (request, ctx: RouteContext<"/api/whatsapp/templates/[id]">) => {
  const auth = await requireApiAuth(request, "owner");
  const { id } = await ctx.params;
  await deleteTemplate(auth.business.id, id, auth.actor);
  return json({ ok: true });
});
