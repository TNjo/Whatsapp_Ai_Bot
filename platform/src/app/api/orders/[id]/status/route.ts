import { z } from "zod";
import { requireApiAuth } from "@/server/auth";
import { changeOrderStatus } from "@/server/commerce/orders";
import { cleanText, json, readJson, route } from "@/server/http";
import { ORDER_STATUSES } from "@/lib/order-status";

const Body = z.object({
  status: z.enum(ORDER_STATUSES),
  note: cleanText(500).optional(),
  trackingNumber: cleanText(120).optional(),
  notifyCustomer: z.boolean().default(true),
});

/** Changes an order's status and (by default) notifies the customer on WhatsApp. */
export const POST = route("orders.status", async (request, ctx: RouteContext<"/api/orders/[id]/status">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  const body = await readJson(request, Body);
  const result = await changeOrderStatus(auth.business.id, id, body.status, auth.actor, body);
  return json(result);
});
