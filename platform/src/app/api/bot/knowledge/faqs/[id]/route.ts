import { requireApiAuth } from "@/server/auth";
import { deleteFaq, FaqPatch, updateFaq } from "@/server/admin/bot";
import { json, readPatch, route } from "@/server/http";

/** Edit fields and/or reorder with `{ move: "up" | "down" }`. */
export const PATCH = route("bot.faqs.update", async (request, ctx: RouteContext<"/api/bot/knowledge/faqs/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  const input = await readPatch(request, FaqPatch);
  return json({ faq: await updateFaq(auth.business.id, id, input, auth.actor) });
});

export const DELETE = route("bot.faqs.delete", async (request, ctx: RouteContext<"/api/bot/knowledge/faqs/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  await deleteFaq(auth.business.id, id, auth.actor);
  return json({ ok: true });
});
