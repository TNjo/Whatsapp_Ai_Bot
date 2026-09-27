import { requireApiAuth } from "@/server/auth";
import { listKnowledge } from "@/server/admin/bot";
import { json, route } from "@/server/http";

export const GET = route("bot.knowledge.list", async (request) => {
  const auth = await requireApiAuth(request);
  return json(await listKnowledge(auth.business.id));
});
