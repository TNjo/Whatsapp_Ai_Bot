import { requireApiAuth } from "@/server/auth";
import { createProduct, listProducts, lowStockThreshold, ProductInput, type ProductStatusFilter } from "@/server/admin/products";
import { json, readJson, route } from "@/server/http";

const STATUSES = new Set<ProductStatusFilter>(["all", "active", "disabled", "out_of_stock", "low_stock"]);

export const GET = route("products.list", async (request) => {
  const auth = await requireApiAuth(request);
  const params = new URL(request.url).searchParams;
  const raw = params.get("status") as ProductStatusFilter | null;
  const status = raw && STATUSES.has(raw) ? raw : "all";
  const [products, threshold] = await Promise.all([
    listProducts(auth.business.id, { q: params.get("q") ?? "", status }),
    lowStockThreshold(auth.business.id),
  ]);
  return json({ products, lowStockThreshold: threshold });
});

export const POST = route("products.create", async (request) => {
  const auth = await requireApiAuth(request);
  const input = await readJson(request, ProductInput);
  return json({ product: await createProduct(auth.business.id, input, auth.actor) }, { status: 201 });
});
