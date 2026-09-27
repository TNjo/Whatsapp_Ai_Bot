import { requireApiAuth } from "@/server/auth";
import { json, route } from "@/server/http";
import { disconnect } from "@/server/whatsapp/connection";

export const POST = route("whatsapp.disconnect", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  return json(await disconnect(auth.business.id, auth.actor));
});
