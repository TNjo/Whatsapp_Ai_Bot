import { requireApiAuth } from "@/server/auth";
import { json, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { syncTemplates } from "@/server/whatsapp/connection";
import { GraphError } from "@/server/whatsapp/graph";
import { ApiError } from "@/server/http";

export const POST = route("templates.sync", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  await rateLimit(`wa-sync:${auth.business.id}`, 30, 3600);
  try {
    return json({ synced: await syncTemplates(auth.business.id) });
  } catch (err) {
    if (err instanceof GraphError) throw new ApiError(400, err.friendly);
    throw err;
  }
});
