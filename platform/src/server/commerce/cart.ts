import "server-only";
import crypto from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { businesses, cartItems, carts, customers, type CartStage } from "@/db/schema";
import { formatMoney, variantLabel } from "@/lib/format";
import {
  findVariant,
  getProduct,
  getService,
  loadVariants,
  matchOptionValue,
  variantAvailable,
  variantPrice,
  type Product,
  type Variant,
} from "./catalog";
import { getOrderFields, type FormField } from "./order-form";

export type Cart = typeof carts.$inferSelect;

export class CartError extends Error {}

export async function getOpenCart(businessId: string, conversationId: string): Promise<Cart | null> {
  const db = await getDb();
  const [cart] = await db
    .select()
    .from(carts)
    .where(and(eq(carts.businessId, businessId), eq(carts.conversationId, conversationId), eq(carts.status, "open")));
  return cart ?? null;
}

/** Creates the draft order, prefilled with details we already know about the customer. */
export async function getOrCreateCart(businessId: string, conversationId: string, customerId: string): Promise<Cart> {
  const existing = await getOpenCart(businessId, conversationId);
  if (existing) return existing;
  const db = await getDb();
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId));
  const fields: Record<string, string> = {};
  if (customer && !customer.isTest && customer.phone) fields.phone = customer.phone;
  // Details from a previous order are reused; the review step lets the customer correct them.
  if (customer?.address) {
    if (customer.displayName) fields.name = customer.displayName;
    fields.address = customer.address;
    if (customer.city) fields.city = customer.city;
  }
  const [cart] = await db.insert(carts).values({ businessId, conversationId, customerId, fields }).returning();
  return cart;
}

export type CartLine = {
  itemId: string;
  kind: "product" | "service";
  refId: string;
  name: string;
  options: Record<string, string>;
  missingOptions: { name: string; values: string[] }[];
  variantId: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  available: boolean;
  problem: string | null;
};

export type CartView = {
  id: string;
  stage: CartStage;
  items: CartLine[];
  fields: Record<string, string>;
  missingFields: { key: string; label: string; type: string; options: string[]; helpText: string }[];
  optionalFields: { key: string; label: string }[];
  paymentMethods: string[];
  currency: string;
  subtotal: number;
  deliveryFee: number;
  total: number;
  readyForReview: boolean;
  reviewHash: string;
};

function fieldOptions(field: FormField, paymentMethods: string[]) {
  return field.key === "payment_method" ? paymentMethods : field.options;
}

export async function viewCart(businessId: string, cart: Cart): Promise<CartView> {
  const db = await getDb();
  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  const rows = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id)).orderBy(asc(cartItems.createdAt));
  const productIds = rows.map((row) => row.productId).filter((id): id is string => Boolean(id));
  const variantMap = await loadVariants(productIds);

  const items: CartLine[] = [];
  for (const row of rows) {
    if (row.productId) {
      const found = await getProduct(businessId, row.productId);
      if (!found) continue;
      const { product } = found;
      const variants = variantMap.get(product.id) ?? [];
      const missingOptions = product.options
        .filter((option) => !row.optionValues[option.name])
        .map((option) => ({ name: option.name, values: option.values }));
      const variant: Variant | null = product.options.length && !missingOptions.length ? findVariant(variants, row.optionValues) : null;
      const unitPrice = variantPrice(product, variant);
      const needsVariant = product.options.length > 0 && variants.length > 0;
      let problem: string | null = null;
      let available = true;
      if (product.status !== "active") {
        available = false;
        problem = "This product is no longer available.";
      } else if (!missingOptions.length && needsVariant && !variant) {
        available = false;
        problem = `The combination ${variantLabel(row.optionValues)} is not offered.`;
      } else if (!missingOptions.length && !variantAvailable(product, needsVariant ? variant : null, row.quantity)) {
        available = false;
        problem = "Not enough stock for this quantity.";
      }
      items.push({
        itemId: row.id,
        kind: "product",
        refId: product.id,
        name: product.name,
        options: row.optionValues,
        missingOptions,
        variantId: variant?.id ?? null,
        quantity: row.quantity,
        unitPrice,
        lineTotal: unitPrice * row.quantity,
        available,
        problem,
      });
    } else if (row.serviceId) {
      const service = await getService(businessId, row.serviceId);
      if (!service) continue;
      const available = service.status === "active";
      items.push({
        itemId: row.id,
        kind: "service",
        refId: service.id,
        name: service.name,
        options: {},
        missingOptions: [],
        variantId: null,
        quantity: row.quantity,
        unitPrice: service.price,
        lineTotal: service.price * row.quantity,
        available,
        problem: available ? null : "This service is no longer available.",
      });
    }
  }

  const fields = await getOrderFields(businessId);
  const paymentMethods = business.paymentMethods;
  const missingFields = fields
    .filter((field) => field.required && !cart.fields[field.key]?.trim())
    .map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      options: fieldOptions(field, paymentMethods),
      helpText: field.helpText,
    }));
  const optionalFields = fields.filter((field) => !field.required && !cart.fields[field.key]?.trim()).map((f) => ({ key: f.key, label: f.label }));

  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const deliveryFee = items.some((item) => item.kind === "product") ? business.deliveryFee : 0;
  const itemsReady = items.length > 0 && items.every((item) => !item.missingOptions.length && item.available);
  const readyForReview = itemsReady && missingFields.length === 0;

  const reviewHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ items: items.map((i) => [i.refId, i.options, i.quantity, i.unitPrice]), fields: cart.fields, deliveryFee }))
    .digest("hex")
    .slice(0, 32);

  let stage: CartStage;
  if (!items.length) stage = "BROWSING";
  else if (!itemsReady) stage = "PRODUCT_SELECTED";
  else if (missingFields.length) stage = "COLLECTING_INFORMATION";
  else if (cart.reviewSentAt && cart.reviewHash === reviewHash) stage = "CUSTOMER_CONFIRMATION";
  else stage = "ORDER_REVIEW";

  return {
    id: cart.id,
    stage,
    items,
    fields: cart.fields,
    missingFields,
    optionalFields,
    paymentMethods,
    currency: business.currency,
    subtotal,
    deliveryFee,
    total: subtotal + deliveryFee,
    readyForReview,
    reviewHash,
  };
}

/** Persists the computed stage and drops a stale review whenever the cart changes. */
async function touch(businessId: string, cartId: string) {
  const db = await getDb();
  const [cart] = await db.select().from(carts).where(eq(carts.id, cartId));
  const view = await viewCart(businessId, cart);
  const stale = cart.reviewSentAt && cart.reviewHash !== view.reviewHash;
  await db
    .update(carts)
    .set({ stage: view.stage, ...(stale ? { reviewSentAt: null, reviewHash: null } : {}) })
    .where(eq(carts.id, cartId));
  return viewCart(businessId, { ...cart, stage: view.stage, ...(stale ? { reviewSentAt: null, reviewHash: null } : {}) });
}

function resolveOptions(product: Product, requested: Record<string, string> | undefined, current: Record<string, string> = {}) {
  const chosen: Record<string, string> = { ...current };
  const errors: string[] = [];
  for (const [rawName, rawValue] of Object.entries(requested ?? {})) {
    if (!rawValue) continue;
    const option = product.options.find((o) => o.name.toLowerCase() === rawName.trim().toLowerCase());
    if (!option) {
      if (product.options.length) errors.push(`"${rawName}" is not an option for ${product.name}. Options: ${product.options.map((o) => o.name).join(", ")}.`);
      continue;
    }
    const value = matchOptionValue(option, String(rawValue));
    if (!value) errors.push(`${option.name} "${rawValue}" is not available. Choose one of: ${option.values.join(", ")}.`);
    else chosen[option.name] = value;
  }
  return { chosen, errors };
}

export async function addCartItem(
  businessId: string,
  cart: Cart,
  input: { productId?: string; serviceId?: string; quantity?: number; options?: Record<string, string> },
) {
  const db = await getDb();
  const quantity = Math.max(1, Math.min(99, Math.floor(input.quantity ?? 1)));
  if (input.serviceId) {
    const service = await getService(businessId, input.serviceId);
    if (!service || service.status !== "active") throw new CartError("That service is not available.");
    await db.insert(cartItems).values({ businessId, cartId: cart.id, serviceId: service.id, quantity });
    return { view: await touch(businessId, cart.id), warnings: [] as string[] };
  }
  if (!input.productId) throw new CartError("Provide a productId or serviceId from the catalog.");
  const found = await getProduct(businessId, input.productId);
  if (!found || found.product.status !== "active") throw new CartError("That product is not available.");
  const { chosen, errors } = resolveOptions(found.product, input.options);

  // Merge with an identical line instead of duplicating it.
  const existing = await db.select().from(cartItems).where(and(eq(cartItems.cartId, cart.id), eq(cartItems.productId, found.product.id)));
  const same = existing.find((row) => JSON.stringify(Object.entries(row.optionValues).sort()) === JSON.stringify(Object.entries(chosen).sort()));
  if (same) {
    await db.update(cartItems).set({ quantity: Math.min(99, same.quantity + quantity) }).where(eq(cartItems.id, same.id));
  } else {
    await db.insert(cartItems).values({ businessId, cartId: cart.id, productId: found.product.id, optionValues: chosen, quantity });
  }
  return { view: await touch(businessId, cart.id), warnings: errors };
}

export async function updateCartItem(
  businessId: string,
  cart: Cart,
  itemId: string,
  input: { quantity?: number; options?: Record<string, string> },
) {
  const db = await getDb();
  const [row] = await db.select().from(cartItems).where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cart.id)));
  if (!row) throw new CartError("That item is not in the cart. Use an itemId from the cart.");
  const warnings: string[] = [];
  const set: Partial<typeof cartItems.$inferInsert> = {};
  if (input.quantity !== undefined) {
    if (input.quantity <= 0) {
      await db.delete(cartItems).where(eq(cartItems.id, row.id));
      return { view: await touch(businessId, cart.id), warnings };
    }
    set.quantity = Math.min(99, Math.floor(input.quantity));
  }
  if (input.options && row.productId) {
    const found = await getProduct(businessId, row.productId);
    if (found) {
      const { chosen, errors } = resolveOptions(found.product, input.options, row.optionValues);
      set.optionValues = chosen;
      warnings.push(...errors);
    }
  }
  if (Object.keys(set).length) await db.update(cartItems).set(set).where(eq(cartItems.id, row.id));
  return { view: await touch(businessId, cart.id), warnings };
}

export async function removeCartItem(businessId: string, cart: Cart, itemId: string) {
  const db = await getDb();
  const deleted = await db.delete(cartItems).where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cart.id))).returning();
  if (!deleted.length) throw new CartError("That item is not in the cart.");
  return touch(businessId, cart.id);
}

/** Validates and stores order-form answers. Unknown keys and invalid choices are reported back. */
export async function setCartFields(businessId: string, cart: Cart, values: Record<string, unknown>) {
  const db = await getDb();
  const fields = await getOrderFields(businessId);
  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  const next = { ...cart.fields };
  const warnings: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const field = fields.find((f) => f.key === key);
    if (!field) {
      warnings.push(`"${key}" is not an order field. Valid keys: ${fields.map((f) => f.key).join(", ")}.`);
      continue;
    }
    const value = String(raw ?? "").trim().slice(0, 500);
    if (!value) {
      delete next[key];
      continue;
    }
    const options = fieldOptions(field, business.paymentMethods);
    if (field.type === "select" && options.length) {
      const match =
        options.find((o) => o.toLowerCase() === value.toLowerCase()) ??
        options.find((o) => o.toLowerCase().includes(value.toLowerCase()) || value.toLowerCase().includes(o.toLowerCase()));
      if (!match) {
        warnings.push(`${field.label} must be one of: ${options.join(", ")}.`);
        continue;
      }
      next[key] = match;
    } else if (field.type === "phone") {
      const digits = value.replace(/[^\d+]/g, "");
      if (digits.replace(/\D/g, "").length < 7) {
        warnings.push(`${field.label} does not look like a phone number.`);
        continue;
      }
      next[key] = digits;
    } else if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      warnings.push(`${field.label} does not look like an email address.`);
    } else if (field.type === "number" && !Number.isFinite(Number(value))) {
      warnings.push(`${field.label} must be a number.`);
    } else {
      next[key] = value;
    }
  }
  await db.update(carts).set({ fields: next }).where(eq(carts.id, cart.id));
  return { view: await touch(businessId, cart.id), warnings };
}

export async function markReviewSent(cartId: string, reviewHash: string) {
  const db = await getDb();
  await db
    .update(carts)
    .set({ reviewHash, reviewSentAt: new Date(), stage: "CUSTOMER_CONFIRMATION" })
    .where(eq(carts.id, cartId));
}

export async function abandonCart(businessId: string, cart: Cart) {
  const db = await getDb();
  await db.update(carts).set({ status: "abandoned" }).where(and(eq(carts.id, cart.id), eq(carts.businessId, businessId)));
}

/** The review message (spec §22), built from computed data — never from AI text. */
export function reviewText(view: CartView, fieldLabels: Map<string, string>): string {
  const money = (minor: number) => formatMoney(minor, view.currency);
  const lines: string[] = ["Please confirm your order:", ""];
  for (const item of view.items) {
    lines.push(`*${item.name}*`);
    for (const [key, value] of Object.entries(item.options)) lines.push(`${key}: ${value}`);
    lines.push(`Quantity: ${item.quantity}`);
    lines.push(`Price: ${money(item.lineTotal)}`);
    lines.push("");
  }
  const f = view.fields;
  if (f.name) lines.push(`Name: ${f.name}`);
  if (f.address || f.city) lines.push("", "Delivery:", [f.address, f.city].filter(Boolean).join(", "));
  if (f.payment_method) lines.push("", "Payment:", f.payment_method);
  const custom = Object.entries(f).filter(([key]) => !["name", "phone", "address", "city", "payment_method", "note"].includes(key));
  for (const [key, value] of custom) lines.push(`${fieldLabels.get(key) ?? key}: ${value}`);
  if (f.note) lines.push("", `Note: ${f.note}`);
  lines.push("", `Items: ${money(view.subtotal)}`);
  if (view.deliveryFee) lines.push(`Delivery: ${money(view.deliveryFee)}`);
  lines.push(`*Total: ${money(view.total)}*`, "", "Would you like to place this order?");
  return lines.join("\n");
}
