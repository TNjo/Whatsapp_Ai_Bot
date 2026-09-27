import { requireApiAuth } from "@/server/auth";
import { json, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { connectionView, runHealthCheck } from "@/server/whatsapp/connection";

export const POST = route("whatsapp.health", async (request) => {
  const auth = await requireApiAuth(request);
  await rateLimit(`wa-health:${auth.business.id}`, 30, 3600);
  await runHealthCheck(auth.business.id);
  return json(await connectionView(auth.business.id));
});
