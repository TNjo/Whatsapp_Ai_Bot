import { requireApiAuth } from "@/server/auth";
import { CustomerInput, getCustomer, updateCustomer } from "@/server/admin/customers";
import { json, notFound, readPatch, route } from "@/server/http";

export const GET = route("customers.get", async (request, ctx: RouteContext<"/api/customers/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  const detail = await getCustomer(auth.business.id, id);
  if (!detail) throw notFound("Customer not found");
  return json(detail);
});

export const PATCH = route("customers.update", async (request, ctx: RouteContext<"/api/customers/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  const input = await readPatch(request, CustomerInput);
  return json({ customer: await updateCustomer(auth.business.id, id, input, auth.actor) });
});
