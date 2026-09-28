import "server-only";
import { z } from "zod";
import type { Conversation, Customer } from "@/db/schema";
import { formatMoney, variantLabel } from "@/lib/format";
import { STATUS_EMOJI, STATUS_LABEL } from "@/lib/order-status";
import { requestHumanSupport } from "../conversations";
import { docId } from "../http";
import { log } from "../logger";
import type { JsonSchema, ToolDefinition } from "../ai/types";
import {
  addCartItem,
  abandonCart,
  CartError,
  getOpenCart,
  getOrCreateCart,
  markReviewSent,
  removeCartItem,
  reviewText,
  setCartFields,
  updateCartItem,
  viewCart,
  type CartView,
} from "../commerce/cart";
import { getProduct, productAvailable, productBasePrice, searchProducts, searchServices, variantAvailable, variantPrice, findVariant, type Product, type Variant } from "../commerce/catalog";
import { createOrderFromCart, customerOrders, OrderError } from "../commerce/orders";
import type { OutboundMessage } from "../whatsapp/messaging";
import type { BotContext } from "./settings";

export type ToolRuntime = {
  businessId: string;
  conversation: Conversation;
  customer: Customer;
  bot: BotContext;
  isTest: boolean;
  /** When the message being answered arrived — used to prove confirmation came after the review. */
  inboundAt: Date;
};

export type ToolOutcome = {
  data: unknown;
  /** Deterministic messages to send; ends the AI turn. */
  terminal?: OutboundMessage[];
  isError?: boolean;
};

type Tool<S extends z.ZodType> = {
  name: string;
  description: string;
  schema: S;
  parameters: JsonSchema;
  run: (rt: ToolRuntime, args: z.infer<S>) => Promise<ToolOutcome>;
};

function tool<S extends z.ZodType>(def: Tool<S>) {
  return def;
}

const money = (rt: ToolRuntime, minor: number) => formatMoney(minor, rt.bot.business.currency);

function productSummary(rt: ToolRuntime, product: Product, variants: Variant[], category: string | null) {
  const available = productAvailable(product, variants);
  const low = product.trackStock && available && product.stock > 0 && product.stock <= rt.bot.business.lowStockThreshold;
  return {
    productId: product.id,
    name: product.name,
    category,
    price: money(rt, productBasePrice(product)),
    regularPrice: product.discountPrice !== null && product.discountPrice < product.price ? money(rt, product.price) : undefined,
    available,
    lowStock: low || undefined,
    options: product.options.map((option) => ({
      name: option.name,
      values: option.values.map((value) => {
        if (!variants.length) return value;
        const any = variants.some((v) => v.optionValues[option.name] === value && variantAvailable(product, v));
        return any ? value : `${value} (out of stock)`;
      }),
    })),
    hasImage: product.images.length > 0,
  };
}

function cartSummary(rt: ToolRuntime, view: CartView) {
  return {
    stage: view.stage,
    items: view.items.map((item) => ({
      itemId: item.itemId,
      name: item.name,
      options: item.options,
      missingOptions: item.missingOptions.length ? item.missingOptions : undefined,
      quantity: item.quantity,
      unitPrice: money(rt, item.unitPrice),
      lineTotal: money(rt, item.lineTotal),
      problem: item.problem ?? undefined,
    })),
    collected: view.fields,
    missingRequiredFields: view.missingFields.map((field) => ({
      key: field.key,
      label: field.label,
      choices: field.options.length ? field.options : undefined,
    })),
    optionalFieldsNotAsked: view.optionalFields,
    subtotal: money(rt, view.subtotal),
    deliveryFee: money(rt, view.deliveryFee),
    total: money(rt, view.total),
    readyForReview: view.readyForReview,
    next: !view.items.length
      ? "Add at least one item."
      : view.items.some((i) => i.missingOptions.length)
        ? "Ask the customer for the missing product options."
        : view.items.some((i) => i.problem)
          ? "Tell the customer about the item problem and offer alternatives."
          : view.missingFields.length
            ? `Ask for: ${view.missingFields.map((f) => f.label).join(", ")}.`
            : view.stage === "CUSTOMER_CONFIRMATION"
              ? "The review was shown. If the customer clearly confirms, call createOrder."
              : "Everything is collected. Call presentOrderReview.",
  };
}

const itemInput = z.object({
  productId: docId.optional(),
  serviceId: docId.optional(),
  quantity: z.number().int().min(1).max(99).default(1),
  options: z.record(z.string(), z.string()).optional(),
});

const itemInputSchema = {
  type: "object",
  properties: {
    productId: { type: "string", description: "productId from searchProducts/getProduct" },
    serviceId: { type: "string", description: "serviceId from searchServices" },
    quantity: { type: "integer", minimum: 1, maximum: 99 },
    options: {
      type: "object",
      description: 'Chosen product options by option name, e.g. {"Size":"L","Color":"Black"}',
      additionalProperties: { type: "string" },
    },
  },
};

async function withCartErrors(fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CartError || err instanceof OrderError) return { data: { error: err.message }, isError: true };
    throw err;
  }
}

export const TOOLS = [
  tool({
    name: "searchProducts",
    description:
      "Search the business's real product catalog. Always use this before mentioning any product, price or availability. Returns matching products with prices, options and availability.",
    schema: z.object({ query: z.string().min(1).max(200), maxResults: z.number().int().min(1).max(10).optional() }),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the customer is looking for, e.g. 'black t-shirt'" },
        maxResults: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query"],
    },
    async run(rt, args) {
      const results = await searchProducts(rt.businessId, args.query, { limit: args.maxResults ?? 6 });
      return {
        data: {
          query: args.query,
          count: results.length,
          products: results.map((r) => productSummary(rt, r.product, r.variants, r.category)),
          note: results.length ? undefined : "No matching products. Do not invent any; offer to help with something else.",
        },
      };
    },
  }),
  tool({
    name: "getProduct",
    description: "Get full details of one product (description, options, per-option availability).",
    schema: z.object({ productId: docId }),
    parameters: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] },
    async run(rt, args) {
      const found = await getProduct(rt.businessId, args.productId);
      if (!found || found.product.status !== "active") return { data: { error: "Product not found" }, isError: true };
      return { data: { ...productSummary(rt, found.product, found.variants, found.category), description: found.product.description.slice(0, 800) } };
    },
  }),
  tool({
    name: "checkStock",
    description: "Check whether a product (optionally a specific option combination) is in stock for a quantity.",
    schema: z.object({ productId: docId, options: z.record(z.string(), z.string()).optional(), quantity: z.number().int().min(1).max(99).default(1) }),
    parameters: {
      type: "object",
      properties: {
        productId: { type: "string" },
        options: { type: "object", additionalProperties: { type: "string" } },
        quantity: { type: "integer", minimum: 1 },
      },
      required: ["productId"],
    },
    async run(rt, args) {
      const found = await getProduct(rt.businessId, args.productId);
      if (!found || found.product.status !== "active") return { data: { available: false, reason: "Product not found or disabled" } };
      const { product, variants } = found;
      if (product.options.length && variants.length) {
        const chosen = Object.fromEntries(
          Object.entries(args.options ?? {}).map(([k, v]) => {
            const option = product.options.find((o) => o.name.toLowerCase() === k.toLowerCase());
            return [option?.name ?? k, v];
          }),
        );
        const missing = product.options.filter((o) => !chosen[o.name]).map((o) => o.name);
        if (missing.length) return { data: { available: productAvailable(product, variants), needOptions: missing } };
        const variant = findVariant(variants, chosen);
        if (!variant) return { data: { available: false, reason: `${variantLabel(chosen)} is not offered` } };
        return { data: { available: variantAvailable(product, variant, args.quantity), price: money(rt, variantPrice(product, variant)) } };
      }
      return { data: { available: variantAvailable(product, null, args.quantity), price: money(rt, productBasePrice(product)) } };
    },
  }),
  tool({
    name: "searchServices",
    description: "Search the business's real services (e.g. haircut) with price and duration.",
    schema: z.object({ query: z.string().max(200).default("") }),
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(rt, args) {
      const results = await searchServices(rt.businessId, args.query);
      return {
        data: {
          services: results.map(({ service, category }) => ({
            serviceId: service.id,
            name: service.name,
            category,
            price: money(rt, service.price),
            durationMinutes: service.durationMinutes ?? undefined,
            availability: service.availability || undefined,
            description: service.description.slice(0, 300),
          })),
        },
      };
    },
  }),
  tool({
    name: "getBusinessInformation",
    description: "Business details: opening hours, delivery, payment methods, return/exchange policy, contact, and FAQs.",
    schema: z.object({ topic: z.string().max(100).optional() }),
    parameters: { type: "object", properties: { topic: { type: "string", description: "Optional topic, e.g. 'delivery'" } } },
    async run(rt, args) {
      const b = rt.bot.business;
      const topic = args.topic?.toLowerCase() ?? "";
      return {
        data: {
          name: b.name,
          description: b.description,
          openingHours: b.openingHours || "Not provided",
          delivery: b.deliveryInfo || "Not provided",
          deliveryFee: b.deliveryFee ? money(rt, b.deliveryFee) : "No delivery fee configured",
          paymentMethods: b.paymentMethods,
          bankDetails: topic.includes("bank") || topic.includes("pay") ? b.bankDetails || undefined : undefined,
          returnPolicy: b.returnPolicy || "Not provided",
          exchangePolicy: b.exchangePolicy || "Not provided",
          contact: { phone: b.phone, email: b.email, address: b.address, website: b.website },
          faqs: rt.bot.faqs
            .filter((faq) => !topic || `${faq.question} ${faq.answer}`.toLowerCase().includes(topic))
            .slice(0, 15)
            .map((faq) => ({ q: faq.question, a: faq.answer })),
        },
      };
    },
  }),
  tool({
    name: "getCustomer",
    description: "What we know about the current customer (name, saved address, order count).",
    schema: z.object({}),
    parameters: { type: "object", properties: {} },
    async run(rt) {
      const c = rt.customer;
      return {
        data: {
          name: c.displayName || c.profileName || null,
          whatsapp: rt.isTest ? "(test customer)" : c.phone,
          savedAddress: c.address || null,
          city: c.city || null,
          totalOrders: c.totalOrders,
        },
      };
    },
  }),
  tool({
    name: "createDraftOrder",
    description:
      "Start (or continue) the customer's draft order and add items. Use when the customer wants to buy something. Include options the customer already mentioned (size, color…).",
    schema: z.object({ items: z.array(itemInput).min(1).max(10) }),
    parameters: {
      type: "object",
      properties: { items: { type: "array", items: itemInputSchema, minItems: 1 } },
      required: ["items"],
    },
    async run(rt, args) {
      return withCartErrors(async () => {
        const cart = await getOrCreateCart(rt.businessId, rt.conversation.id, rt.customer.id);
        const warnings: string[] = [];
        let view: CartView | null = null;
        for (const item of args.items) {
          const added = await addCartItem(rt.businessId, cart, item);
          warnings.push(...added.warnings);
          view = added.view;
        }
        return { data: { draftOrder: cartSummary(rt, view ?? (await viewCart(rt.businessId, cart))), warnings: warnings.length ? warnings : undefined } };
      });
    },
  }),
  tool({
    name: "updateDraftOrder",
    description:
      "Change the draft order: add/remove items, change quantity or options, and save order details the customer gave (name, address, city, payment_method, note, and any custom fields — use the field keys).",
    schema: z.object({
      addItems: z.array(itemInput).max(10).optional(),
      updateItems: z
        .array(z.object({ itemId: docId, quantity: z.number().int().min(0).max(99).optional(), options: z.record(z.string(), z.string()).optional() }))
        .max(10)
        .optional(),
      removeItemIds: z.array(docId).max(10).optional(),
      fields: z.record(z.string(), z.string()).optional(),
    }),
    parameters: {
      type: "object",
      properties: {
        addItems: { type: "array", items: itemInputSchema },
        updateItems: {
          type: "array",
          items: {
            type: "object",
            properties: {
              itemId: { type: "string" },
              quantity: { type: "integer", minimum: 0, description: "0 removes the item" },
              options: { type: "object", additionalProperties: { type: "string" } },
            },
            required: ["itemId"],
          },
        },
        removeItemIds: { type: "array", items: { type: "string" } },
        fields: {
          type: "object",
          description: 'Order form values by field key, e.g. {"address":"12 Main St","city":"Colombo 05","payment_method":"Cash on Delivery"}',
          additionalProperties: { type: "string" },
        },
      },
    },
    async run(rt, args) {
      return withCartErrors(async () => {
        const cart = await getOrCreateCart(rt.businessId, rt.conversation.id, rt.customer.id);
        const warnings: string[] = [];
        for (const item of args.addItems ?? []) warnings.push(...(await addCartItem(rt.businessId, cart, item)).warnings);
        for (const item of args.updateItems ?? []) warnings.push(...(await updateCartItem(rt.businessId, cart, item.itemId, item)).warnings);
        for (const itemId of args.removeItemIds ?? []) await removeCartItem(rt.businessId, cart, itemId);
        if (args.fields && Object.keys(args.fields).length) {
          const fresh = (await getOpenCart(rt.businessId, rt.conversation.id)) ?? cart;
          warnings.push(...(await setCartFields(rt.businessId, fresh, args.fields)).warnings);
        }
        const latest = (await getOpenCart(rt.businessId, rt.conversation.id)) ?? cart;
        return { data: { draftOrder: cartSummary(rt, await viewCart(rt.businessId, latest)), warnings: warnings.length ? warnings : undefined } };
      });
    },
  }),
  tool({
    name: "calculateOrderTotal",
    description: "Show the current draft order with computed totals, missing information and the next step.",
    schema: z.object({}),
    parameters: { type: "object", properties: {} },
    async run(rt) {
      const cart = await getOpenCart(rt.businessId, rt.conversation.id);
      if (!cart) return { data: { draftOrder: null, note: "No draft order yet." } };
      return { data: { draftOrder: cartSummary(rt, await viewCart(rt.businessId, cart)) } };
    },
  }),
  tool({
    name: "presentOrderReview",
    description:
      "When every required detail is collected, send the customer the final order summary with Confirm / Edit / Cancel buttons. This sends the message itself — do not write your own summary.",
    schema: z.object({}),
    parameters: { type: "object", properties: {} },
    async run(rt) {
      const cart = await getOpenCart(rt.businessId, rt.conversation.id);
      if (!cart) return { data: { error: "No draft order." }, isError: true };
      const view = await viewCart(rt.businessId, cart);
      if (!view.readyForReview) return { data: { error: "Not ready for review.", draftOrder: cartSummary(rt, view) }, isError: true };
      await markReviewSent(rt.businessId, cart.id, view.reviewHash);
      const labels = new Map(rt.bot.orderFields.map((field) => [field.key, field.label]));
      return {
        data: { sent: true },
        terminal: [
          {
            kind: "buttons",
            text: reviewText(view, labels),
            buttons: [
              { id: "confirm_order", title: "Confirm Order" },
              { id: "edit_order", title: "Edit" },
              { id: "cancel_order", title: "Cancel" },
            ],
          },
        ],
      };
    },
  }),
  tool({
    name: "createOrder",
    description:
      "Place the order. Only call this after presentOrderReview was sent AND the customer's latest message clearly confirms it (e.g. 'confirm', 'yes, place it'). Sends the confirmation message itself.",
    schema: z.object({}),
    parameters: { type: "object", properties: {} },
    async run(rt) {
      return withCartErrors(async () => {
        const cart = await getOpenCart(rt.businessId, rt.conversation.id);
        if (!cart) return { data: { error: "No draft order." }, isError: true };
        if (!cart.reviewSentAt || cart.reviewSentAt > rt.inboundAt) {
          return { data: { error: "The customer has not confirmed the review yet. Call presentOrderReview first." }, isError: true };
        }
        const order = await placeOrder(rt);
        return { data: { orderNumber: order.orderNumber }, terminal: [{ kind: "text", text: orderPlacedText(rt, order) }] };
      });
    },
  }),
  tool({
    name: "cancelDraftOrder",
    description: "Discard the customer's draft order when they no longer want it.",
    schema: z.object({}),
    parameters: { type: "object", properties: {} },
    async run(rt) {
      const cart = await getOpenCart(rt.businessId, rt.conversation.id);
      if (cart) await abandonCart(rt.businessId, cart);
      return { data: { cancelled: Boolean(cart) } };
    },
  }),
  tool({
    name: "getCustomerOrders",
    description: "The customer's recent orders with status and tracking. Use for 'where is my order?'.",
    schema: z.object({ limit: z.number().int().min(1).max(10).optional() }),
    parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 10 } } },
    async run(rt, args) {
      const rows = await customerOrders(rt.businessId, rt.customer.id, args.limit ?? 5);
      return {
        data: {
          orders: rows.map((order) => ({
            orderNumber: order.orderNumber,
            status: `${STATUS_LABEL[order.status]} ${STATUS_EMOJI[order.status] ?? ""}`.trim(),
            total: money(rt, order.total),
            tracking: order.trackingNumber || undefined,
            placed: order.createdAt.toISOString().slice(0, 10),
          })),
          note: rows.length ? undefined : "This customer has no orders.",
        },
      };
    },
  }),
  tool({
    name: "getOrderStatus",
    description: "Status of one of this customer's orders by order number (e.g. ORD-10025).",
    schema: z.object({ orderNumber: z.string().min(3).max(30) }),
    parameters: { type: "object", properties: { orderNumber: { type: "string" } }, required: ["orderNumber"] },
    async run(rt, args) {
      const wanted = args.orderNumber.replace(/^#/, "").trim().toUpperCase();
      const rows = await customerOrders(rt.businessId, rt.customer.id, 50);
      const order = rows.find((o) => o.orderNumber.toUpperCase() === wanted || o.orderNumber.endsWith(wanted.replace(/\D/g, "")));
      if (!order) return { data: { found: false, note: "No order with that number for this customer." } };
      return {
        data: {
          found: true,
          orderNumber: order.orderNumber,
          status: STATUS_LABEL[order.status],
          tracking: order.trackingNumber || undefined,
          total: money(rt, order.total),
          placed: order.createdAt.toISOString().slice(0, 10),
        },
      };
    },
  }),
  tool({
    name: "showProduct",
    description: "Send one product to the customer as a card (photo, price, options) with an Order button. Sends the message itself.",
    schema: z.object({ productId: docId }),
    parameters: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] },
    async run(rt, args) {
      const card = await productCard(rt, args.productId);
      if (!card) return { data: { error: "Product not found" }, isError: true };
      return { data: { sent: true }, terminal: card };
    },
  }),
  tool({
    name: "presentOptions",
    description:
      "Send a short question with tappable choices (up to 10). Use for choosing between products, sizes, colors or payment methods. Sends the message itself. For products use ids like 'product:<productId>'.",
    schema: z.object({
      text: z.string().min(1).max(900),
      options: z.array(z.object({ id: z.string().min(1).max(200), title: z.string().min(1).max(60), description: z.string().max(72).optional() })).min(2).max(10),
      buttonText: z.string().max(20).optional(),
    }),
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          items: {
            type: "object",
            properties: { id: { type: "string" }, title: { type: "string" }, description: { type: "string" } },
            required: ["id", "title"],
          },
        },
        buttonText: { type: "string", description: "List button label, max 20 chars" },
      },
      required: ["text", "options"],
    },
    async run(_rt, args) {
      const fitsButtons = args.options.length <= 3 && args.options.every((o) => o.title.length <= 20 && !o.description);
      const message: OutboundMessage = fitsButtons
        ? { kind: "buttons", text: args.text, buttons: args.options.map((o) => ({ id: o.id, title: o.title })) }
        : { kind: "list", text: args.text, buttonText: args.buttonText || "View options", sections: [{ rows: args.options }] };
      return { data: { sent: true }, terminal: [message] };
    },
  }),
  tool({
    name: "requestHumanSupport",
    description:
      "Hand the conversation to a team member when you cannot answer accurately, the customer asks for a person, or there is a complaint/problem you cannot solve. Sends the handoff message itself.",
    schema: z.object({ reason: z.string().min(3).max(300) }),
    parameters: { type: "object", properties: { reason: { type: "string", description: "Short reason for the team" } }, required: ["reason"] },
    async run(rt, args) {
      await requestHumanSupport(rt.businessId, rt.conversation.id, args.reason);
      const text = rt.bot.settings.handoffMessage || "I'll connect you with our team.";
      return { data: { handedOff: true }, terminal: [{ kind: "text", text }] };
    },
  }),
];

export type BotTool = (typeof TOOLS)[number];

export function toolDefinitions(rt: ToolRuntime): ToolDefinition[] {
  return TOOLS.filter((t) => rt.bot.settings.humanHandoffEnabled || t.name !== "requestHumanSupport").map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Validates arguments and runs a tool. Unknown tools and bad arguments come back as errors the model can fix. */
export async function executeTool(rt: ToolRuntime, name: string, rawArgs: unknown): Promise<ToolOutcome> {
  const found = TOOLS.find((t) => t.name === name);
  if (!found || (name === "requestHumanSupport" && !rt.bot.settings.humanHandoffEnabled)) {
    return { data: { error: `Unknown tool ${name}` }, isError: true };
  }
  const parsed = found.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { data: { error: "Invalid arguments", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, isError: true };
  }
  const started = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = await found.run(rt, parsed.data as any);
    log.info("ai.tool", { businessId: rt.businessId, conversationId: rt.conversation.id, tool: name, ms: Date.now() - started, error: outcome.isError || undefined });
    return outcome;
  } catch (err) {
    log.error("ai.tool.failed", { businessId: rt.businessId, tool: name, err });
    return { data: { error: "The tool failed. Apologise briefly and offer to connect the customer with the team." }, isError: true };
  }
}

/** Shared by the createOrder tool and the Confirm Order button. */
export async function placeOrder(rt: ToolRuntime) {
  const cart = await getOpenCart(rt.businessId, rt.conversation.id);
  if (!cart) throw new OrderError("No draft order.");
  const isTestOrder = rt.isTest && !rt.bot.settings.testModeCreatesOrders;
  return createOrderFromCart(rt.businessId, cart, { isTest: isTestOrder });
}

export function orderPlacedText(rt: ToolRuntime, order: { orderNumber: string; total: number; currency: string; isTest: boolean }) {
  return [
    `✅ Thank you! Your order *#${order.orderNumber}* has been placed.`,
    "",
    `Total: ${formatMoney(order.total, order.currency)}`,
    "",
    "We'll confirm it shortly and keep you updated here.",
    order.isTest ? "\n_(Test mode: this is not a real order.)_" : "",
  ]
    .join("\n")
    .trim();
}

export async function productCard(rt: ToolRuntime, productId: string): Promise<OutboundMessage[] | null> {
  const found = await getProduct(rt.businessId, productId);
  if (!found || found.product.status !== "active") return null;
  const { product, variants } = found;
  const available = productAvailable(product, variants);
  const price = productBasePrice(product);
  const lines = [
    `*${product.name}*`,
    price < product.price ? `${money(rt, price)} ~(was ${money(rt, product.price)})~` : money(rt, price),
    ...product.options.map((option) => `${option.name}: ${option.values.join(", ")}`),
    available ? "✅ In stock" : "❌ Currently out of stock",
    product.description ? `\n${product.description.slice(0, 400)}` : "",
  ].filter(Boolean);
  const out: OutboundMessage[] = [];
  if (product.images[0]) out.push({ kind: "image", url: product.images[0], text: product.name });
  out.push(
    available
      ? {
          kind: "buttons",
          text: lines.join("\n"),
          buttons: [
            { id: `order_product:${product.id}`, title: "Order" },
            { id: "browse_more", title: "See more" },
          ],
        }
      : { kind: "text", text: lines.join("\n") },
  );
  return out;
}
