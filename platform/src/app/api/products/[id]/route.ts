import { requireApiAuth } from "@/server/auth";
import { deleteProduct, getProductDetail, ProductInput, updateProduct } from "@/server/admin/products";
import { json, notFound, readPatch, route } from "@/server/http";

export const GET = route("products.get", async (request, ctx: RouteContext<"/api/products/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  const product = await getProductDetail(auth.business.id, id);
  if (!product) throw notFound("Product not found");
  return json({ product });
});

export const PATCH = route("products.update", async (request, ctx: RouteContext<"/api/products/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  const input = await readPatch(request, ProductInput);
  return json({ product: await updateProduct(auth.business.id, id, input, auth.actor) });
});

export const DELETE = route("products.delete", async (request, ctx: RouteContext<"/api/products/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  await deleteProduct(auth.business.id, id, auth.actor);
  return json({ ok: true });
});
