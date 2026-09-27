import "server-only";
import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { categories, products, productVariants, services, type ProductOption } from "@/db/schema";

export type Product = typeof products.$inferSelect;
export type Variant = typeof productVariants.$inferSelect;
export type Service = typeof services.$inferSelect;

const STOPWORDS = new Set(
  "a an and any are available can could do does for from have i im is it me my of on or please show some the there to u want we what which with you your need looking buy order get price how much".split(
    " ",
  ),
);

export function searchTokens(query: string): string[] {
  const words = query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
  const tokens = new Set<string>();
  for (const word of words) {
    tokens.add(word);
    if (word.length > 4 && word.endsWith("es")) tokens.add(word.slice(0, -2));
    if (word.length > 3 && word.endsWith("s")) tokens.add(word.slice(0, -1));
  }
  return [...tokens].slice(0, 12);
}

/** Base unit price: discount when set and lower, otherwise the list price. */
export function productBasePrice(product: Pick<Product, "price" | "discountPrice">) {
  return product.discountPrice !== null && product.discountPrice < product.price ? product.discountPrice : product.price;
}

export function variantPrice(product: Product, variant: Variant | null | undefined) {
  return variant?.price ?? productBasePrice(product);
}

export function variantAvailable(product: Product, variant: Variant | null | undefined, quantity = 1) {
  if (product.status !== "active") return false;
  if (variant) return variant.active && (!product.trackStock || variant.stock >= quantity);
  return !product.trackStock || product.stock >= quantity;
}

export function productAvailable(product: Product, variants: Variant[]) {
  if (product.status !== "active") return false;
  if (product.options.length && variants.length) return variants.some((variant) => variantAvailable(product, variant));
  return variantAvailable(product, null);
}

export async function loadVariants(productIds: string[]) {
  if (!productIds.length) return new Map<string, Variant[]>();
  const db = await getDb();
  const rows = await db.select().from(productVariants).where(inArray(productVariants.productId, productIds));
  const map = new Map<string, Variant[]>();
  for (const row of rows) map.set(row.productId, [...(map.get(row.productId) ?? []), row]);
  return map;
}

export async function categoryNames(businessId: string) {
  const db = await getDb();
  const rows = await db.select().from(categories).where(eq(categories.businessId, businessId));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * Keyword search over the real catalog: name, description, category, SKU and
 * option values ("black", "large"). Ranked by how many tokens match where.
 */
export async function searchProducts(
  businessId: string,
  query: string,
  { limit = 8, includeUnavailable = true }: { limit?: number; includeUnavailable?: boolean } = {},
) {
  const db = await getDb();
  const tokens = searchTokens(query);
  const cats = await categoryNames(businessId);
  const matchingCats = [...cats.entries()].filter(([, name]) => tokens.some((t) => name.toLowerCase().includes(t))).map(([id]) => id);

  const tokenFilters = tokens.flatMap((token) => [
    ilike(products.name, `%${token}%`),
    ilike(products.description, `%${token}%`),
    ilike(products.sku, `%${token}%`),
    sql`${products.options}::text ilike ${`%${token}%`}`,
  ]);
  if (matchingCats.length) tokenFilters.push(inArray(products.categoryId, matchingCats));

  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.businessId, businessId), eq(products.status, "active"), tokens.length ? or(...tokenFilters) : undefined))
    .limit(200);

  const variants = await loadVariants(rows.map((row) => row.id));
  const scored = rows
    .map((product) => {
      const name = product.name.toLowerCase();
      const desc = product.description.toLowerCase();
      const opts = JSON.stringify(product.options).toLowerCase();
      const cat = (product.categoryId ? cats.get(product.categoryId) : "")?.toLowerCase() ?? "";
      let score = 0;
      for (const token of tokens) {
        if (name.includes(token)) score += 5;
        if (cat.includes(token)) score += 3;
        if (opts.includes(token)) score += 3;
        if (desc.includes(token)) score += 1;
      }
      const productVariantsList = variants.get(product.id) ?? [];
      return { product, variants: productVariantsList, category: product.categoryId ? (cats.get(product.categoryId) ?? null) : null, score, available: productAvailable(product, productVariantsList) };
    })
    .filter((row) => includeUnavailable || row.available)
    .sort((a, b) => b.score - a.score || Number(b.available) - Number(a.available) || a.product.name.localeCompare(b.product.name));

  return scored.slice(0, limit);
}

export async function getProduct(businessId: string, productId: string) {
  const db = await getDb();
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.businessId, businessId)));
  if (!product) return null;
  const variants = (await loadVariants([product.id])).get(product.id) ?? [];
  const cats = await categoryNames(businessId);
  return { product, variants, category: product.categoryId ? (cats.get(product.categoryId) ?? null) : null };
}

export async function searchServices(businessId: string, query: string, limit = 8) {
  const db = await getDb();
  const tokens = searchTokens(query);
  const rows = await db
    .select()
    .from(services)
    .where(
      and(
        eq(services.businessId, businessId),
        eq(services.status, "active"),
        tokens.length ? or(...tokens.flatMap((t) => [ilike(services.name, `%${t}%`), ilike(services.description, `%${t}%`)])) : undefined,
      ),
    )
    .limit(100);
  const cats = await categoryNames(businessId);
  return rows
    .map((service) => {
      const text = `${service.name} ${service.description}`.toLowerCase();
      return {
        service,
        category: service.categoryId ? (cats.get(service.categoryId) ?? null) : null,
        score: tokens.reduce((sum, t) => sum + (service.name.toLowerCase().includes(t) ? 3 : text.includes(t) ? 1 : 0), 0),
      };
    })
    .sort((a, b) => b.score - a.score || a.service.name.localeCompare(b.service.name))
    .slice(0, limit);
}

export async function getService(businessId: string, serviceId: string) {
  const db = await getDb();
  const [service] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.businessId, businessId)));
  return service ?? null;
}

const SIZE_ALIASES: Record<string, string[]> = {
  xs: ["extra small", "x-small", "xsmall"],
  s: ["small", "sm"],
  m: ["medium", "med"],
  l: ["large", "lg"],
  xl: ["extra large", "x-large", "xlarge"],
  xxl: ["2xl", "double extra large", "xx-large"],
};

/** Matches a customer's wording to a defined option value ("large" → "L", "black" → "Black"). */
export function matchOptionValue(option: ProductOption, raw: string): string | null {
  const wanted = raw.trim().toLowerCase();
  const exact = option.values.find((value) => value.toLowerCase() === wanted);
  if (exact) return exact;
  for (const value of option.values) {
    const aliases = SIZE_ALIASES[value.toLowerCase()];
    if (aliases?.includes(wanted)) return value;
  }
  const partial = option.values.filter((value) => value.toLowerCase().includes(wanted) || wanted.includes(value.toLowerCase()));
  return partial.length === 1 ? partial[0] : null;
}

/** Finds the variant whose option values match exactly. */
export function findVariant(variants: Variant[], chosen: Record<string, string>) {
  return (
    variants.find((variant) =>
      Object.entries(variant.optionValues).every(([key, value]) => chosen[key]?.toLowerCase() === value.toLowerCase()),
    ) ?? null
  );
}
