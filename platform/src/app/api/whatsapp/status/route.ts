import { requireApiAuth } from "@/server/auth";
import { whatsappOverview } from "@/server/admin/whatsapp";
import { json, route } from "@/server/http";

export const GET = route("whatsapp.status", async (request) => {
  const auth = await requireApiAuth(request);
  return json(await whatsappOverview(auth.business.id));
});
