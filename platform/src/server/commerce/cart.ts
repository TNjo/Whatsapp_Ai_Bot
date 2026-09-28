import "server-only";
import crypto from "node:crypto";
import { fromDoc, newId, store } from "@/db";
import type { Business, Cart, CartItem, CartStage, Customer } from "@/db/schema";
import { formatMoney, variantLabel } from "@/lib/format";
import { findVariant, getProduct, getService, matchOptionValue, variantAvailable, variantPrice, type Product, type Variant } from "./catalog";
import { getOrderFields, type FormField } from "./order-form";

export type { Cart };

export class CartError extends Error {}

/** businesses/{b}/carts/{conversationId} is the conversation's open draft order. */
export async function getOpenCart(businessId: string, conversationId: string): Promise<Cart | null> {
  const s = await store();
  return fromDoc<Cart>(await s.carts(businessId).doc(conversationId).get());
}

/** Creates the draft order, prefilled with details we already know about the customer. */
export async function getOrCreateCart(businessId: string, conversationId: string, customerId: string): Promise<Cart> {
  const existing = await getOpenCart(businessId, conversationId);
  if (existing) return existing;
  const s = await store();
  const customer = fromDoc<Customer>(await s.customers(businessId).doc(customerId).get());
  const fields: Record<string, string> = {};
  if (customer && !customer.isTest && customer.phone) fields.phone = customer.phone;
  // Details from a previous order are reused; the review step lets the customer correct them.
  if (customer?.address) {
    if (customer.displayName) fields.name = customer.displayName;
    fields.address = customer.address;
    if (customer.city) fields.city = customer.city;
  }
  const now = new Date();
  const cart: Cart = {
    id: conversationId,
    businessId,
    conversationId,
    customerId,
    stage: "BROWSING",
    items: [],
    fields,
    reviewHash: null,
    reviewSentAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await s.carts(businessId).doc(conversationId).set({ ...cart, id: undefined });
  return cart;
}

async function saveCart(cart: Cart) {
  const s = await store();
  const { id, ...rest } = cart;
  await s.carts(cart.businessId).doc(id).set({ ...rest, updatedAt: new Date() });
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
  const s = await store();
  const business = fromDoc<Business>(await s.businesses.doc(businessId).get())!;
  const rows = [...cart.items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const items: CartLine[] = [];
  for (const row of rows) {
    if (row.productId) {
      const found = await getProduct(businessId, row.productId);
      if (!found) continue;
      const { product, variants } = found;
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
    .map((field) => ({ key: field.key, label: field.label, type: field.type, options: fieldOptions(field, paymentMethods), helpText: field.helpText }));
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

/** Saves the cart with its computed stage, dropping a stale review whenever the contents changed. */
async function touch(cart: Cart) {
  const view = await viewCart(cart.businessId, cart);
  const stale = Boolean(cart.reviewSentAt && cart.reviewHash !== view.reviewHash);
  const next: Cart = { ...cart, stage: view.stage, ...(stale ? { reviewSentAt: null, reviewHash: null } : {}) };
  await saveCart(next);
  return stale ? viewCart(next.businessId, next) : view;
}

/** Reloads the cart so consecutive tool steps always work on the latest state. */
async function fresh(businessId: string, cart: Cart) {
  return (await getOpenCart(businessId, cart.conversationId)) ?? cart;
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

const sameOptions = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export async function addCartItem(
  businessId: string,
  cartInput: Cart,
  input: { productId?: string; serviceId?: string; quantity?: number; options?: Record<string, string> },
) {
  const cart = await fresh(businessId, cartInput);
  const quantity = Math.max(1, Math.min(99, Math.floor(input.quantity ?? 1)));
  const item = (patch: Partial<CartItem>): CartItem => ({
    id: newId(),
    productId: null,
    variantId: null,
    serviceId: null,
    optionValues: {},
    quantity,
    createdAt: new Date(),
    ...patch,
  });
  if (input.serviceId) {
    const service = await getService(businessId, input.serviceId);
    if (!service || service.status !== "active") throw new CartError("That service is not available.");
    return { view: await touch({ ...cart, items: [...cart.items, item({ serviceId: service.id })] }), warnings: [] as string[] };
  }
  if (!input.productId) throw new CartError("Provide a productId or serviceId from the catalog.");
  const found = await getProduct(businessId, input.productId);
  if (!found || found.product.status !== "active") throw new CartError("That product is not available.");
  const { chosen, errors } = resolveOptions(found.product, input.options);

  // Merge with an identical line instead of duplicating it.
  const same = cart.items.find((row) => row.productId === found.product.id && sameOptions(row.optionValues, chosen));
  const items = same
    ? cart.items.map((row) => (row === same ? { ...row, quantity: Math.min(99, row.quantity + quantity) } : row))
    : [...cart.items, item({ productId: found.product.id, optionValues: chosen })];
  return { view: await touch({ ...cart, items }), warnings: errors };
}

export async function updateCartItem(
  businessId: string,
  cartInput: Cart,
  itemId: string,
  input: { quantity?: number; options?: Record<string, string> },
) {
  const cart = await fresh(businessId, cartInput);
  const row = cart.items.find((i) => i.id === itemId);
  if (!row) throw new CartError("That item is not in the cart. Use an itemId from the cart.");
  const warnings: string[] = [];
  if (input.quantity !== undefined && input.quantity <= 0) {
    return { view: await touch({ ...cart, items: cart.items.filter((i) => i.id !== itemId) }), warnings };
  }
  const next: CartItem = { ...row };
  if (input.quantity !== undefined) next.quantity = Math.min(99, Math.floor(input.quantity));
  if (input.options && row.productId) {
    const found = await getProduct(businessId, row.productId);
    if (found) {
      const { chosen, errors } = resolveOptions(found.product, input.options, row.optionValues);
      next.optionValues = chosen;
      warnings.push(...errors);
    }
  }
  return { view: await touch({ ...cart, items: cart.items.map((i) => (i.id === itemId ? next : i)) }), warnings };
}

export async function removeCartItem(businessId: string, cartInput: Cart, itemId: string) {
  const cart = await fresh(businessId, cartInput);
  if (!cart.items.some((i) => i.id === itemId)) throw new CartError("That item is not in the cart.");
  return touch({ ...cart, items: cart.items.filter((i) => i.id !== itemId) });
}

/** Validates and stores order-form answers. Unknown keys and invalid choices are reported back. */
export async function setCartFields(businessId: string, cartInput: Cart, values: Record<string, unknown>) {
  const cart = await fresh(businessId, cartInput);
  const s = await store();
  const fields = await getOrderFields(businessId);
  const business = fromDoc<Business>(await s.businesses.doc(businessId).get())!;
  const next = { ...cart.fields };
  const warnings: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const field = fields.find((f) => f.key === key);
    if (!field) {
      warnings.push(`"${key}" is not an order field. Valid keys: ${fields.map((f) => f.key).join(", ")}.`);
      continue;
    }
    const value = String(raw ?? "")
      .trim()
      .slice(0, 500);
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
  return { view: await touch({ ...cart, fields: next }), warnings };
}

export async function markReviewSent(businessId: string, cartId: string, reviewHash: string) {
  const s = await store();
  await s.carts(businessId).doc(cartId).update({ reviewHash, reviewSentAt: new Date(), stage: "CUSTOMER_CONFIRMATION", updatedAt: new Date() });
}

/** The customer no longer wants the draft: remove it (orders keep their own copy of everything). */
export async function abandonCart(businessId: string, cart: Cart) {
  const s = await store();
  await s.carts(businessId).doc(cart.id).delete();
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
