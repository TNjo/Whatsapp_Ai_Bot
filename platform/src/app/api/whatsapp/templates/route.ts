import { requireApiAuth } from "@/server/auth";
import { listTemplates, saveTemplate, TemplateInput } from "@/server/admin/whatsapp";
import { json, readJson, route } from "@/server/http";

export const GET = route("templates.list", async (request) => {
  const auth = await requireApiAuth(request);
  return json({ templates: await listTemplates(auth.business.id) });
});

export const POST = route("templates.save", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  const input = await readJson(request, TemplateInput);
  return json({ template: await saveTemplate(auth.business.id, input, auth.actor) }, { status: 201 });
});
