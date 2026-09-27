import { requireApiAuth } from "@/server/auth";
import { testAIConnection, TestConnectionInput } from "@/server/admin/bot";
import { json, readJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export const POST = route("bot.settings.test", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  await rateLimit(`ai-test:${auth.business.id}`, 20, 3600);
  const input = await readJson(request, TestConnectionInput);
  return json(await testAIConnection(auth.business.id, input));
});
