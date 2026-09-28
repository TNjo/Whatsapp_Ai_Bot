import "server-only";
import { z } from "zod";
import { fromDoc, fromDocs, newId, store } from "@/db";
import type { Business, Product, ProductOption, ProductVariant } from "@/db/schema";
import { audit, type AuditActor } from "../audit";
import { badRequest, cleanText, docId, notFound } from "../http";
import { listCategories, resolveCategory } from "./categories";

/** Prices arrive in major units from forms ("2500") and are stored in minor units. */
const money = z.coerce.number().min(0).max(100_000_000).transform((v) => Math.round(v * 100));
/** Blank / null → no value (e.g. no discount, or a variant that uses the product price). */
const optionalMoney = z.preprocess((v) => (v === "" || v === null ? null : v), money.nullable()).optional();
const stockCount = z.coerce.number().int("Stock must be a whole number").min(0, "Stock cannot be negative").max(1_000_000);

const MAX_OPTIONS = 3;
const MAX_VARIANTS = 250;
const MAX_IMAGES = 10;
const UPLOAD_URL = /^\/api\/uploads\/([A-Za-z0-9_-]{8,64})\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/;
/** Firestore document ids (newId) — also rejects "/", "." and "..". */
export const isDocId = (value: string) => docId.safeParse(value).success;
/** @deprecated ids are Firestore document ids now; kept for existing imports. */
export const isUuid = isDocId;

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
  variants: z.array(z.object({ id: docId, stock: stockCount })).max(MAX_VARIANTS).optional(),
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
 * Makes the embedded variants match every combination of `options`. Existing
 * variants are kept (same id, so carts/orders keep their links) and updated from
 * `input` when a matching optionValues entry is sent; missing combinations get a
 * new id; variants for combinations that no longer exist are dropped. `total` is
 * the summed stock, or null when the product has no options.
 */
function syncVariants(existing: ProductVariant[], options: ProductOption[], input?: VariantInputData[]) {
  if (!options.length) return { variants: [] as ProductVariant[], total: null };

  const existingByKey = new Map(existing.map((v) => [variantKey(v.optionValues), v]));
  const inputByKey = new Map((input ?? []).map((v) => [variantKey(v.optionValues), v]));
  const variants: ProductVariant[] = [];
  let total = 0;

  for (const combo of combinations(options)) {
    const key = variantKey(combo);
    const current = existingByKey.get(key);
    const sent = inputByKey.get(key);
    const variant: ProductVariant = {
      id: current?.id ?? newId(),
      optionValues: combo,
      price: sent ? (sent.price ?? null) : (current?.price ?? null),
      stock: sent ? sent.stock : (current?.stock ?? 0),
      sku: sent ? sent.sku : (current?.sku ?? ""),
      active: sent ? sent.active : (current?.active ?? true),
    };
    total += variant.stock;
    variants.push(variant);
  }
  return { variants, total };
}

const variantView = (v: ProductVariant) => ({ id: v.id, optionValues: v.optionValues, price: v.price, stock: v.stock, sku: v.sku, active: v.active });

function sortVariants<T extends { optionValues: Record<string, string> }>(options: ProductOption[], variants: T[]): T[] {
  const order = new Map(combinations(options).map((combo, index) => [variantKey(combo), index]));
  // Firestore re-orders map keys; present values in the owner's option order ("Black / L", not "L / Black").
  const ordered = (values: Record<string, string>) =>
    Object.fromEntries([...options.filter((o) => o.name in values).map((o) => o.name), ...Object.keys(values)].map((k) => [k, values[k]]));
  return [...variants]
    .sort((a, b) => (order.get(variantKey(a.optionValues)) ?? 1e9) - (order.get(variantKey(b.optionValues)) ?? 1e9))
    .map((variant) => ({ ...variant, optionValues: ordered(variant.optionValues) }));
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

export type ProductStatusFilter = "all" | "active" | "disabled" | "out_of_stock" | "low_stock";

export async function lowStockThreshold(businessId: string) {
  const s = await store();
  const business = fromDoc<Business>(await s.businesses.doc(businessId).get());
  return business?.lowStockThreshold ?? 5;
}

/** Catalogs are small: load the business's products once, then filter and sort in memory. */
export async function listProducts(businessId: string, { q = "", status = "all" }: { q?: string; status?: ProductStatusFilter } = {}) {
  const s = await store();
  const [rows, categoryList, threshold] = await Promise.all([
    s.products(businessId).get().then((snap) => fromDocs<Product>(snap)),
    listCategories(businessId, "product"),
    status === "low_stock" ? lowStockThreshold(businessId) : Promise.resolve(0),
  ]);
  const categoryName = new Map(categoryList.map((c) => [c.id, c.name]));
  const query = q.trim().toLowerCase();

  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      price: row.price,
      discountPrice: row.discountPrice,
      sku: row.sku,
      stock: row.stock,
      trackStock: row.trackStock,
      images: row.images,
      options: row.options,
      status: row.status,
      category: row.categoryId ? (categoryName.get(row.categoryId) ?? null) : null,
      updatedAt: row.updatedAt,
      variants: sortVariants(row.options, (row.variants ?? []).map(variantView)),
    }))
    .filter((row) => {
      if (query && ![row.name, row.description, row.sku, row.category ?? ""].some((text) => text.toLowerCase().includes(query))) return false;
      switch (status) {
        case "active":
        case "disabled":
          return row.status === status;
        case "out_of_stock":
          return row.trackStock && row.stock <= 0;
        case "low_stock":
          return row.trackStock && row.stock > 0 && row.stock <= threshold;
        default:
          return true;
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.id < b.id ? -1 : 1));
}

export type ProductListRow = Awaited<ReturnType<typeof listProducts>>[number];

async function findProduct(businessId: string, id: string) {
  if (!isDocId(id)) return null;
  const s = await store();
  return fromDoc<Product>(await s.products(businessId).doc(id).get());
}

export async function getProductDetail(businessId: string, id: string) {
  const product = await findProduct(businessId, id);
  if (!product) return null;
  const s = await store();
  const category = product.categoryId
    ? ((await s.categories(businessId).doc(product.categoryId).get()).data() as { name?: string } | undefined)?.name ?? null
    : null;
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
    variants: sortVariants(product.options, (product.variants ?? []).map(variantView)),
  };
}

export type ProductDetail = NonNullable<Awaited<ReturnType<typeof getProductDetail>>>;

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export async function createProduct(businessId: string, input: ProductInputData, actor: AuditActor) {
  const s = await store();
  const discountPrice = input.discountPrice ?? null;
  checkDiscount(input.price, discountPrice);
  const images = checkImages(businessId, input.images);
  const options = normalizeOptions(input.options);
  const categoryId = await resolveCategory(businessId, "product", input.category);
  const { variants, total } = syncVariants([], options, input.variants);

  const id = newId();
  const now = new Date();
  const product: Omit<Product, "id"> = {
    businessId,
    categoryId,
    name: input.name,
    description: input.description,
    price: input.price,
    discountPrice,
    sku: input.sku,
    stock: total ?? input.stock,
    trackStock: input.trackStock,
    images,
    options,
    variants,
    status: input.status,
    createdAt: now,
    updatedAt: now,
  };
  await s.products(businessId).doc(id).create(product);

  await audit(businessId, actor, "product.created", { type: "product", id }, { name: input.name, variants: variants.length });
  return (await getProductDetail(businessId, id))!;
}

export async function updateProduct(businessId: string, id: string, input: Partial<ProductInputData>, actor: AuditActor) {
  if (!isDocId(id)) throw notFound("Product not found");
  const s = await store();
  const ref = s.products(businessId).doc(id);

  // Validation and category creation happen before the transaction (it may only read, then write).
  const images = input.images !== undefined ? checkImages(businessId, input.images) : undefined;
  const newOptions = input.options !== undefined ? normalizeOptions(input.options) : undefined;
  const categoryId = input.category !== undefined ? await resolveCategory(businessId, "product", input.category) : undefined;

  await s.db.runTransaction(async (tx) => {
    const current = fromDoc<Product>(await tx.get(ref));
    if (!current) throw notFound("Product not found");

    const price = input.price ?? current.price;
    const discountPrice = input.discountPrice !== undefined ? (input.discountPrice ?? null) : current.discountPrice;
    checkDiscount(price, discountPrice);

    const set: Partial<Omit<Product, "id">> = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name;
    if (input.description !== undefined) set.description = input.description;
    if (input.sku !== undefined) set.sku = input.sku;
    if (input.status !== undefined) set.status = input.status;
    if (input.trackStock !== undefined) set.trackStock = input.trackStock;
    if (input.price !== undefined) set.price = input.price;
    if (input.discountPrice !== undefined) set.discountPrice = discountPrice;
    if (images !== undefined) set.images = images;
    if (categoryId !== undefined) set.categoryId = categoryId;

    const options = newOptions ?? current.options;
    if (newOptions !== undefined) set.options = newOptions;
    const touchesVariants = input.options !== undefined || input.variants !== undefined;
    if (input.stock !== undefined && !touchesVariants && current.options.length) {
      throw badRequest("This product has variants — update each variant's stock instead.");
    }

    if (touchesVariants) {
      const { variants, total } = syncVariants(current.variants ?? [], options, input.variants);
      set.variants = variants;
      if (total !== null) set.stock = total;
      else if (input.stock !== undefined) set.stock = input.stock;
    } else if (input.stock !== undefined) {
      set.stock = input.stock;
    }
    tx.update(ref, set);
  });

  await audit(businessId, actor, "product.updated", { type: "product", id }, { fields: Object.keys(input) });
  return (await getProductDetail(businessId, id))!;
}

export async function setProductStock(businessId: string, id: string, input: z.infer<typeof StockInput>, actor: AuditActor) {
  if (!isDocId(id)) throw notFound("Product not found");
  const s = await store();
  const ref = s.products(businessId).doc(id);

  const from = await s.db.runTransaction(async (tx) => {
    const current = fromDoc<Product>(await tx.get(ref));
    if (!current) throw notFound("Product not found");
    const existing = current.variants ?? [];

    if (existing.length > 0) {
      if (!input.variants?.length) throw badRequest("This product has variants — send the stock for each variant.");
      const sent = new Map(input.variants.map((v) => [v.id, v.stock]));
      const variants = existing.map((v) => (sent.has(v.id) ? { ...v, stock: sent.get(v.id)! } : v));
      tx.update(ref, { variants, stock: variants.reduce((sum, v) => sum + v.stock, 0), updatedAt: new Date() });
    } else {
      if (input.stock === undefined) throw badRequest("stock: Enter the quantity in stock");
      tx.update(ref, { stock: input.stock, updatedAt: new Date() });
    }
    return current.stock;
  });

  const product = (await getProductDetail(businessId, id))!;
  await audit(businessId, actor, "product.stock_updated", { type: "product", id }, { from, to: product.stock });
  return product;
}

export async function deleteProduct(businessId: string, id: string, actor: AuditActor) {
  if (!isDocId(id)) throw notFound("Product not found");
  const s = await store();
  const ref = s.products(businessId).doc(id);
  const name = await s.db.runTransaction(async (tx) => {
    const current = fromDoc<Product>(await tx.get(ref));
    if (!current) throw notFound("Product not found");
    tx.delete(ref);
    return current.name;
  });
  await audit(businessId, actor, "product.deleted", { type: "product", id }, { name });
}
