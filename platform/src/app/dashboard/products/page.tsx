import type { Metadata } from "next";
import { requirePageAuth } from "@/server/auth";
import { listProducts, lowStockThreshold } from "@/server/admin/products";
import { ProductsManager } from "./products-manager";

export const metadata: Metadata = { title: "Products" };

export default async function ProductsPage() {
  const auth = await requirePageAuth();
  const [products, threshold] = await Promise.all([listProducts(auth.business.id), lowStockThreshold(auth.business.id)]);
  return (
    <ProductsManager
      currency={auth.business.currency}
      lowStockThreshold={threshold}
      initial={products.map((p) => ({ ...p, updatedAt: p.updatedAt.toISOString() }))}
    />
  );
}
