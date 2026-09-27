import { requireApiAuth } from "@/server/auth";
import { getOrderFormView, OrderFormInput, replaceOrderForm } from "@/server/admin/bot";
import { json, readJson, route } from "@/server/http";

export const GET = route("bot.order_form.get", async (request) => {
  const auth = await requireApiAuth(request);
  return json(await getOrderFormView(auth.business.id));
});

/** Replaces the whole field list; array order is the display order. */
export const PUT = route("bot.order_form.replace", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  const input = await readJson(request, OrderFormInput);
  return json(await replaceOrderForm(auth.business.id, input, auth.actor));
});
