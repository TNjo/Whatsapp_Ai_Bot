import { z } from "zod";
import { requireApiAuth } from "@/server/auth";
import { orderDetail, updateOrderNotes } from "@/server/admin/orders";
import { cleanText, json, readPatch, route } from "@/server/http";

export const GET = route("orders.get", async (request, ctx: RouteContext<"/api/orders/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  return json(await orderDetail(auth.business.id, id));
});

const Patch = z.object({ internalNotes: cleanText(4000), trackingNumber: cleanText(120) });

export const PATCH = route("orders.update", async (request, ctx: RouteContext<"/api/orders/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  const input = await readPatch(request, Patch);
  return json({ order: await updateOrderNotes(auth.business.id, id, input, auth.actor) });
});
