import { requireApiAuth } from "@/server/auth";
import { createService, listServices, ServiceInput } from "@/server/admin/services";
import { json, readJson, route } from "@/server/http";

export const GET = route("services.list", async (request) => {
  const auth = await requireApiAuth(request);
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return json({ services: await listServices(auth.business.id, q) });
});

export const POST = route("services.create", async (request) => {
  const auth = await requireApiAuth(request);
  const input = await readJson(request, ServiceInput);
  return json({ service: await createService(auth.business.id, input, auth.actor) }, { status: 201 });
});
