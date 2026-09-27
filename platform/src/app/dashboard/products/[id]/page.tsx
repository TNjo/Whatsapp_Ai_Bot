import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageAuth } from "@/server/auth";
import { listCategories } from "@/server/admin/categories";
import { getProductDetail } from "@/server/admin/products";
import { ProductEditor } from "./product-editor";

export async function generateMetadata(props: PageProps<"/dashboard/products/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  return { title: id === "new" ? "Add product" : "Edit product" };
}

export default async function ProductEditorPage(props: PageProps<"/dashboard/products/[id]">) {
  const { id } = await props.params;
  const auth = await requirePageAuth();
  const [product, categories] = await Promise.all([
    id === "new" ? Promise.resolve(null) : getProductDetail(auth.business.id, id),
    listCategories(auth.business.id, "product"),
  ]);
  if (id !== "new" && !product) notFound();
  return (
    <ProductEditor
      key={product ? `${product.id}:${product.updatedAt.toISOString()}` : "new"}
      currency={auth.business.currency}
      categories={categories.map((c) => c.name)}
      product={
        product
          ? {
              id: product.id,
              name: product.name,
              description: product.description,
              category: product.category,
              price: product.price,
              discountPrice: product.discountPrice,
              sku: product.sku,
              stock: product.stock,
              trackStock: product.trackStock,
              images: product.images,
              options: product.options,
              status: product.status,
              variants: product.variants,
            }
          : null
      }
    />
  );
}
