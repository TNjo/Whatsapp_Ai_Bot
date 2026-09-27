import { requireApiAuth } from "@/server/auth";
import { createFaq, FaqInput } from "@/server/admin/bot";
import { json, readJson, route } from "@/server/http";

export const POST = route("bot.faqs.create", async (request) => {
  const auth = await requireApiAuth(request);
  const input = await readJson(request, FaqInput);
  return json({ faq: await createFaq(auth.business.id, input, auth.actor) }, { status: 201 });
});
