import "server-only";
import { and, asc, eq, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Tx } from "@/db";
import { businesses, categories, products, productVariants, type ProductOption } from "@/db/schema";
import { audit, type AuditActor } from "../audit";
import { badRequest, cleanText, notFound } from "../http";
import { resolveCategory } from "./categories";

/** Prices arrive in major units from forms ("2500") and are stored in minor units. */
const money = z.coerce.number().min(0).max(100_000_000).transform((v) => Math.round(v * 100));
/** Blank / null → no value (e.g. no discount, or a variant that uses the product price). */
const optionalMoney = z.preprocess((v) => (v === "" || v === null ? null : v), money.nullable()).optional();
const stockCount = z.coerce.number().int("Stock must be a whole number").min(0, "Stock cannot be negative").max(1_000_000);

const MAX_OPTIONS = 3;
const MAX_VARIANTS = 250;
const MAX_IMAGES = 10;
const UPLOAD_URL = /^\/api\/uploads\/([0-9a-f-]{36})\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);

const OptionInput = z.object({
  name: cleanText(40).pipe(z.string().min(1, "Option name is required")),
  values: z.array(cleanText(40)).max(50),
});

const VariantInput = z.object({
  optionValues: z.record(z.string().max(60), z.string().max(60)),
  price: optionalMoney,
  stock: stockCount.default(0),
  sku: cleanText(60).default(""),
  active: z.boolean().default(true),
});

export const ProductInput = z.object({
  name: cleanText(120).pipe(z.string().min(1, "Name is required")),
  description: cleanText(4000).default(""),
  category: cleanText(60).optional(),
  price: money,
  discountPrice: optionalMoney,
  sku: cleanText(60).default(""),
  stock: stockCount.default(0),
  trackStock: z.boolean().default(true),
  images: z.array(z.string().max(500)).max(MAX_IMAGES, `Up to ${MAX_IMAGES} images per product`).default([]),
  options: z.array(OptionInput).max(MAX_OPTIONS, `Up to ${MAX_OPTIONS} options per product`).default([]),
  variants: z.array(VariantInput).max(MAX_VARIANTS).default([]),
  status: z.enum(["active", "disabled"]).default("active"),
});

export const StockInput = z.object({
  stock: stockCount.optional(),
  variants: z.array(z.object({ id: z.string().regex(UUID, "Invalid variant"), stock: stockCount })).max(MAX_VARIANTS).optional(),
});

export type ProductInputData = z.infer<typeof ProductInput>;
type VariantInputData = z.infer<typeof VariantInput>;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Order-independent identity of a variant: {Color: Black, Size: L} === {Size: L, Color: Black}. */
export function variantKey(values: Record<string, string>) {
  return Object.entries(values)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}\u0000${v}`)
    .join("\u0001");
}

export function combinations(options: ProductOption[]): Record<string, string>[] {
  if (!options.length) return [];
  return options.reduce<Record<string, string>[]>(
    (acc, option) => acc.flatMap((combo) => option.values.map((value) => ({ ...combo, [option.name]: value }))),
    [{}],
  );
}

/** Trims, de-duplicates and validates option definitions. Options without values are dropped. */
function normalizeOptions(input: z.infer<typeof OptionInput>[]): ProductOption[] {
  const seen = new Set<string>();
  const options: ProductOption[] = [];
  for (const option of input) {
    const values = [...new Map(option.values.filter(Boolean).map((v) => [v.toLowerCase(), v])).values()];
    if (!values.length) continue;
    const lower = option.name.toLowerCase();
    if (seen.has(lower)) throw badRequest(`Option “${option.name}” is listed twice`);
    seen.add(lower);
    options.push({ name: option.name, values });
  }
  const count = options.reduce((n, o) => n * o.values.length, options.length ? 1 : 0);
  if (count > MAX_VARIANTS) throw badRequest(`These options make ${count} variants — the limit is ${MAX_VARIANTS}.`);
  return options;
}

/** Only this business's own uploads (or public https links) may be attached. */
function checkImages(businessId: string, images: string[]) {
  const clean = [...new Set(images.map((url) => url.trim()).filter(Boolean))];
  for (const url of clean) {
    const local = UPLOAD_URL.exec(url);
    if (local ? local[1] !== businessId : !/^https:\/\/[^\s"'<>]+$/i.test(url)) throw badRequest("One of the images is not valid. Please upload it again.");
  }
  return clean;
}

function checkDiscount(price: number, discountPrice: number | null) {
  if (discountPrice !== null && discountPrice >= price) throw badRequest("Discount price must be lower than the regular price");
}

/**
 * Makes the variant rows match every combination of `options`. Existing rows are
 * kept (same id, so carts/orders keep their links) and updated from `input` when a
 * matching optionValues entry is sent; missing combinations are inserted; rows for
 * combinations that no longer exist are deleted. Returns the summed stock, or null
 * when the product has no options.
 */
async function syncVariants(tx: Tx, businessId: string, productId: string, options: ProductOption[], input?: VariantInputData[]) {
  const existing = await tx
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), eq(productVariants.businessId, businessId)));

  if (!options.length) {
    if (existing.length) await tx.delete(productVariants).where(inArray(productVariants.id, existing.map((v) => v.id)));
    return null;
  }

  const existingByKey = new Map(existing.map((v) => [variantKey(v.optionValues), v]));
  const inputByKey = new Map((input ?? []).map((v) => [variantKey(v.optionValues), v]));
  const kept = new Set<string>();
  let total = 0;

  for (const combo of combinations(options)) {
    const key = variantKey(combo);
    const current = existingByKey.get(key);
    const sent = inputByKey.get(key);
    const next = {
      price: sent ? (sent.price ?? null) : (current?.price ?? null),
      stock: sent ? sent.stock : (current?.stock ?? 0),
      sku: sent ? sent.sku : (current?.sku ?? ""),
      active: sent ? sent.active : (current?.active ?? true),
    };
    total += next.stock;
    if (current) {
      kept.add(current.id);
      const changed =
        current.price !== next.price || current.stock !== next.stock || current.sku !== next.sku || current.active !== next.active;
      if (changed) await tx.update(productVariants).set(next).where(eq(productVariants.id, current.id));
    } else {
      await tx.insert(productVariants).values({ businessId, productId, optionValues: combo, ...next });
    }
  }

  const stale = existing.filter((v) => !kept.has(v.id)).map((v) => v.id);
  if (stale.length) await tx.delete(productVariants).where(inArray(productVariants.id, stale));
  return total;
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

export type ProductStatusFilter = "all" | "active" | "disabled" | "out_of_stock" | "low_stock";

export async function lowStockThreshold(businessId: string) {
  const db = await getDb();
  const [row] = await db.select({ threshold: businesses.lowStockThreshold }).from(businesses).where(eq(businesses.id, businessId));
  return row?.threshold ?? 5;
}

export async function listProducts(businessId: string, { q = "", status = "all" }: { q?: string; status?: ProductStatusFilter } = {}) {
  const db = await getDb();
  const query = q.trim();
  const statusFilter =
    status === "active" || status === "disabled"
      ? eq(products.status, status)
      : status === "out_of_stock"
        ? and(eq(products.trackStock, true), lte(products.stock, 0))
        : status === "low_stock"
          ? and(
              eq(products.trackStock, true),
              sql`${products.stock} > 0`,
              sql`${products.stock} <= (select ${businesses.lowStockThreshold} from ${businesses} where ${businesses.id} = ${businessId})`,
            )
          : undefined;
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      description: products.description,
      price: products.price,
      discountPrice: products.discountPrice,
      sku: products.sku,
      stock: products.stock,
      trackStock: products.trackStock,
      images: products.images,
      options: products.options,
      status: products.status,
      category: categories.name,
      updatedAt: products.updatedAt,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .where(
      and(
        eq(products.businessId, businessId),
        query
          ? or(
              ilike(products.name, `%${query}%`),
              ilike(products.description, `%${query}%`),
              ilike(products.sku, `%${query}%`),
              ilike(categories.name, `%${query}%`),
            )
          : undefined,
        statusFilter,
      ),
    )
    .orderBy(asc(products.name));

  const variants = rows.length
    ? await db
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          optionValues: productVariants.optionValues,
          price: productVariants.price,
          stock: productVariants.stock,
          sku: productVariants.sku,
          active: productVariants.active,
        })
        .from(productVariants)
        .where(and(eq(productVariants.businessId, businessId), inArray(productVariants.productId, rows.map((r) => r.id))))
    : [];

  return rows.map((row) => {
    const own = variants
      .filter((v) => v.productId === row.id)
      .map((v) => ({ id: v.id, optionValues: v.optionValues, price: v.price, stock: v.stock, sku: v.sku, active: v.active }));
    return { ...row, variants: sortVariants(row.options, own) };
  });
}

export type ProductListRow = Awaited<ReturnType<typeof listProducts>>[number];

function sortVariants<T extends { optionValues: Record<string, string> }>(options: ProductOption[], variants: T[]): T[] {
  const order = new Map(combinations(options).map((combo, index) => [variantKey(combo), index]));
  // jsonb re-orders object keys; present values in the owner's option order ("Black / L", not "L / Black").
  const ordered = (values: Record<string, string>) =>
    Object.fromEntries([...options.filter((o) => o.name in values).map((o) => o.name), ...Object.keys(values)].map((k) => [k, values[k]]));
  return [...variants]
    .sort((a, b) => (order.get(variantKey(a.optionValues)) ?? 1e9) - (order.get(variantKey(b.optionValues)) ?? 1e9))
    .map((variant) => ({ ...variant, optionValues: ordered(variant.optionValues) }));
}

async function findProduct(businessId: string, id: string, tx?: Tx) {
  if (!isUuid(id)) return null;
  const db = tx ?? (await getDb());
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, id), eq(products.businessId, businessId)));
  return row ?? null;
}

export async function getProductDetail(businessId: string, id: string) {
  const product = await findProduct(businessId, id);
  if (!product) return null;
  const db = await getDb();
  const [variants, category] = await Promise.all([
    db
      .select({
        id: productVariants.id,
        optionValues: productVariants.optionValues,
        price: productVariants.price,
        stock: productVariants.stock,
        sku: productVariants.sku,
        active: productVariants.active,
      })
      .from(productVariants)
      .where(and(eq(productVariants.productId, product.id), eq(productVariants.businessId, businessId))),
    product.categoryId
      ? db
          .select({ name: categories.name })
          .from(categories)
          .where(and(eq(categories.id, product.categoryId), eq(categories.businessId, businessId)))
          .then((r) => r[0]?.name ?? null)
      : Promise.resolve(null),
  ]);
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    discountPrice: product.discountPrice,
    sku: product.sku,
    stock: product.stock,
    trackStock: product.trackStock,
    images: product.images,
    options: product.options,
    status: product.status,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    category,
    variants: sortVariants(product.options, variants),
  };
}

export type ProductDetail = NonNullable<Awaited<ReturnType<typeof getProductDetail>>>;

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export async function createProduct(businessId: string, input: ProductInputData, actor: AuditActor) {
  const db = await getDb();
  const discountPrice = input.discountPrice ?? null;
  checkDiscount(input.price, discountPrice);
  const images = checkImages(businessId, input.images);
  const options = normalizeOptions(input.options);
  const categoryId = await resolveCategory(businessId, "product", input.category);

  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(products)
      .values({
        businessId,
        categoryId,
        name: input.name,
        description: input.description,
        price: input.price,
        discountPrice,
        sku: input.sku,
        stock: input.stock,
        trackStock: input.trackStock,
        images,
        options,
        status: input.status,
      })
      .returning({ id: products.id });
    const total = await syncVariants(tx, businessId, row.id, options, input.variants);
    if (total !== null) await tx.update(products).set({ stock: total }).where(eq(products.id, row.id));
    return row.id;
  });

  await audit(businessId, actor, "product.created", { type: "product", id }, { name: input.name, variants: options.length ? combinations(options).length : 0 });
  return (await getProductDetail(businessId, id))!;
}

export async function updateProduct(businessId: string, id: string, input: Partial<ProductInputData>, actor: AuditActor) {
  const current = await findProduct(businessId, id);
  if (!current) throw notFound("Product not found");

  const price = input.price ?? current.price;
  const discountPrice = input.discountPrice !== undefined ? (input.discountPrice ?? null) : current.discountPrice;
  checkDiscount(price, discountPrice);

  const set: Partial<typeof products.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description;
  if (input.sku !== undefined) set.sku = input.sku;
  if (input.status !== undefined) set.status = input.status;
  if (input.trackStock !== undefined) set.trackStock = input.trackStock;
  if (input.price !== undefined) set.price = input.price;
  if (input.discountPrice !== undefined) set.discountPrice = discountPrice;
  if (input.images !== undefined) set.images = checkImages(businessId, input.images);
  if (input.category !== undefined) set.categoryId = await resolveCategory(businessId, "product", input.category);

  const options = input.options !== undefined ? normalizeOptions(input.options) : current.options;
  if (input.options !== undefined) set.options = options;
  const touchesVariants = input.options !== undefined || input.variants !== undefined;
  if (input.stock !== undefined && !touchesVariants && current.options.length) {
    throw badRequest("This product has variants — update each variant's stock instead.");
  }

  const db = await getDb();
  await db.transaction(async (tx) => {
    if (touchesVariants) {
      const total = await syncVariants(tx, businessId, id, options, input.variants);
      if (total !== null) set.stock = total;
      else if (input.stock !== undefined) set.stock = input.stock;
    } else if (input.stock !== undefined) {
      set.stock = input.stock;
    }
    await tx
      .update(products)
      .set(set)
      .where(and(eq(products.id, id), eq(products.businessId, businessId)));
  });

  await audit(businessId, actor, "product.updated", { type: "product", id }, { fields: Object.keys(input) });
  return (await getProductDetail(businessId, id))!;
}

export async function setProductStock(businessId: string, id: string, input: z.infer<typeof StockInput>, actor: AuditActor) {
  const current = await findProduct(businessId, id);
  if (!current) throw notFound("Product not found");
  const db = await getDb();

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productVariants)
    .where(and(eq(productVariants.productId, id), eq(productVariants.businessId, businessId)));

  if (count > 0) {
    if (!input.variants?.length) throw badRequest("This product has variants — send the stock for each variant.");
    await db.transaction(async (tx) => {
      for (const variant of input.variants!) {
        await tx
          .update(productVariants)
          .set({ stock: variant.stock })
          .where(and(eq(productVariants.id, variant.id), eq(productVariants.productId, id), eq(productVariants.businessId, businessId)));
      }
      await tx
        .update(products)
        .set({
          stock: sql`(select coalesce(sum(${productVariants.stock}), 0)::int from ${productVariants} where ${productVariants.productId} = ${id})`,
          updatedAt: new Date(),
        })
        .where(and(eq(products.id, id), eq(products.businessId, businessId)));
    });
  } else {
    if (input.stock === undefined) throw badRequest("stock: Enter the quantity in stock");
    await db
      .update(products)
      .set({ stock: input.stock, updatedAt: new Date() })
      .where(and(eq(products.id, id), eq(products.businessId, businessId)));
  }

  const product = (await getProductDetail(businessId, id))!;
  await audit(businessId, actor, "product.stock_updated", { type: "product", id }, { from: current.stock, to: product.stock });
  return product;
}

export async function deleteProduct(businessId: string, id: string, actor: AuditActor) {
  if (!isUuid(id)) throw notFound("Product not found");
  const db = await getDb();
  const [row] = await db
    .delete(products)
    .where(and(eq(products.id, id), eq(products.businessId, businessId)))
    .returning({ id: products.id, name: products.name });
  if (!row) throw notFound("Product not found");
  await audit(businessId, actor, "product.deleted", { type: "product", id }, { name: row.name });
}
