import { requireApiAuth } from "@/server/auth";
import { setProductStock, StockInput } from "@/server/admin/products";
import { json, readJson, route } from "@/server/http";

/** Body: `{ stock: number }` for simple products, `{ variants: [{ id, stock }] }` for products with variants. */
export const PUT = route("products.stock", async (request, ctx: RouteContext<"/api/products/[id]/stock">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  const input = await readJson(request, StockInput);
  return json({ product: await setProductStock(auth.business.id, id, input, auth.actor) });
});
