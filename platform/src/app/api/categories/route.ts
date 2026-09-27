import { requireApiAuth } from "@/server/auth";
import { listCategories } from "@/server/admin/categories";
import { json, route } from "@/server/http";

export const GET = route("categories.list", async (request) => {
  const auth = await requireApiAuth(request);
  const kind = new URL(request.url).searchParams.get("kind") === "service" ? "service" : "product";
  return json({ categories: await listCategories(auth.business.id, kind) });
});
