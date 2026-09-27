import { requireApiAuth } from "@/server/auth";
import { listCustomers } from "@/server/admin/customers";
import { json, route } from "@/server/http";

export const GET = route("customers.list", async (request) => {
  const auth = await requireApiAuth(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const page = Number(url.searchParams.get("page")) || 1;
  return json(await listCustomers(auth.business.id, { query: q, page }));
});
