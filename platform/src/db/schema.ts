import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { OrderStatus } from "../lib/order-status";

/**
 * Money is stored as integer minor units (cents) in the business currency.
 * Every business-owned row carries business_id and is only ever read through
 * a business id that came from the authenticated session or a verified
 * WhatsApp connection — never from the request body.
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const businessId = () =>
  uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" });

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const businesses = pgTable("businesses", {
  id: id(),
  name: text("name").notNull(),
  logoUrl: text("logo_url"),
  description: text("description").notNull().default(""),
  phone: text("phone").notNull().default(""),
  email: text("email").notNull().default(""),
  address: text("address").notNull().default(""),
  website: text("website").notNull().default(""),
  whatsappNumber: text("whatsapp_number").notNull().default(""),
  openingHours: text("opening_hours").notNull().default(""),
  deliveryInfo: text("delivery_info").notNull().default(""),
  deliveryFee: integer("delivery_fee").notNull().default(0),
  paymentMethods: jsonb("payment_methods").$type<string[]>().notNull().default(["Cash on Delivery", "Bank Transfer"]),
  bankDetails: text("bank_details").notNull().default(""),
  returnPolicy: text("return_policy").notNull().default(""),
  exchangePolicy: text("exchange_policy").notNull().default(""),
  currency: text("currency").notNull().default("LKR"),
  timezone: text("timezone").notNull().default("Asia/Colombo"),
  lowStockThreshold: integer("low_stock_threshold").notNull().default(5),
  nextOrderNumber: integer("next_order_number").notNull().default(10001),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type MemberRole = "owner" | "staff";

export const businessMembers = pgTable(
  "business_members",
  {
    id: id(),
    businessId: businessId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<MemberRole>().notNull().default("staff"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("business_members_business_user").on(t.businessId, t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256 of the cookie token
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessId: businessId(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

/* ------------------------------------------------------------------ */
/* WhatsApp                                                            */
/* ------------------------------------------------------------------ */

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type HealthCheck = {
  key: "account" | "phone" | "api" | "webhook" | "messaging" | "bot";
  label: string;
  ok: boolean;
  detail: string;
};

export const whatsappConnections = pgTable("whatsapp_connections", {
  id: id(),
  businessId: businessId().unique(),
  status: text("status").$type<ConnectionStatus>().notNull().default("disconnected"),
  /** embedded_signup / manual = official Cloud API; qr = linked device via WhatsApp Web (unofficial). */
  connectedVia: text("connected_via").$type<"embedded_signup" | "manual" | "qr">(),
  wabaId: text("waba_id"),
  wabaName: text("waba_name"),
  metaBusinessId: text("meta_business_id"),
  accessTokenEnc: text("access_token_enc"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  registrationPinEnc: text("registration_pin_enc"),
  health: jsonb("health").$type<HealthCheck[]>().notNull().default([]),
  lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
  lastWebhookEventAt: timestamp("last_webhook_event_at", { withTimezone: true }),
  lastError: text("last_error"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const whatsappPhoneNumbers = pgTable("whatsapp_phone_numbers", {
  id: id(),
  businessId: businessId(),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => whatsappConnections.id, { onDelete: "cascade" }),
  phoneNumberId: text("phone_number_id").notNull().unique(),
  displayPhoneNumber: text("display_phone_number").notNull().default(""),
  verifiedName: text("verified_name").notNull().default(""),
  qualityRating: text("quality_rating"),
  isPrimary: boolean("is_primary").notNull().default(true),
  createdAt: createdAt(),
});

export type TemplatePurpose =
  | "order_confirmed"
  | "order_processing"
  | "order_ready"
  | "order_dispatched"
  | "order_delivered"
  | "order_completed"
  | "order_rejected"
  | "order_cancelled"
  | "payment_received"
  | "other";

export const whatsappTemplates = pgTable(
  "whatsapp_templates",
  {
    id: id(),
    businessId: businessId(),
    name: text("name").notNull(),
    language: text("language").notNull().default("en"),
    category: text("category").notNull().default("UTILITY"),
    purpose: text("purpose").$type<TemplatePurpose>().notNull().default("other"),
    body: text("body").notNull().default(""),
    /** Ordered variable names, mapped to {{1}}, {{2}}… when sending. */
    variables: jsonb("variables").$type<string[]>().notNull().default([]),
    status: text("status").$type<"APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "UNKNOWN">().notNull().default("UNKNOWN"),
    metaTemplateId: text("meta_template_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("whatsapp_templates_name").on(t.businessId, t.name, t.language)],
);

/* ------------------------------------------------------------------ */
/* Customers & conversations                                           */
/* ------------------------------------------------------------------ */

export const customers = pgTable(
  "customers",
  {
    id: id(),
    businessId: businessId(),
    waId: text("wa_id").notNull(),
    /** Chat id for linked-device (QR) connections, e.g. "9477…@c.us" or "…@lid". */
    waChatId: text("wa_chat_id"),
    phone: text("phone").notNull(),
    profileName: text("profile_name").notNull().default(""),
    displayName: text("display_name").notNull().default(""),
    email: text("email").notNull().default(""),
    address: text("address").notNull().default(""),
    city: text("city").notNull().default(""),
    notes: text("notes").notNull().default(""),
    isTest: boolean("is_test").notNull().default(false),
    totalOrders: integer("total_orders").notNull().default(0),
    totalSpent: integer("total_spent").notNull().default(0),
    firstInteractionAt: timestamp("first_interaction_at", { withTimezone: true }).notNull().defaultNow(),
    lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("customers_business_wa").on(t.businessId, t.waId)],
);

export type ConversationStatus = "active" | "human_required" | "resolved";

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    businessId: businessId(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    status: text("status").$type<ConversationStatus>().notNull().default("active"),
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    handoffReason: text("handoff_reason"),
    topic: text("topic").notNull().default(""),
    isTest: boolean("is_test").notNull().default(false),
    unreadCount: integer("unread_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessagePreview: text("last_message_preview").notNull().default(""),
    /** Last customer message — drives the 24-hour customer service window. */
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversations_business_customer").on(t.businessId, t.customerId),
    index("conversations_business_last").on(t.businessId, t.lastMessageAt),
  ],
);

export type MessageDirection = "inbound" | "outbound";
export type MessageSender = "customer" | "ai" | "agent" | "system";
export type MessageType =
  | "text"
  | "image"
  | "document"
  | "audio"
  | "video"
  | "sticker"
  | "location"
  | "interactive"
  | "button"
  | "template"
  | "contacts"
  | "reaction"
  | "unsupported";
export type MessageStatus = "received" | "pending" | "sent" | "delivered" | "read" | "failed";

export type MessagePayload = {
  media?: { id: string; mimeType?: string; filename?: string; caption?: string; link?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  interactive?: {
    kind: "buttons" | "list" | "reply";
    buttons?: { id: string; title: string }[];
    sections?: { title?: string; rows: { id: string; title: string; description?: string }[] }[];
    buttonText?: string;
    replyId?: string;
    header?: string;
    footer?: string;
  };
  template?: { name: string; language: string; variables: string[] };
  aiTools?: string[];
  error?: { code?: number | string; title?: string; detail?: string };
};

export const messages = pgTable(
  "messages",
  {
    id: id(),
    businessId: businessId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: text("direction").$type<MessageDirection>().notNull(),
    sender: text("sender").$type<MessageSender>().notNull(),
    type: text("type").$type<MessageType>().notNull().default("text"),
    content: text("content").notNull().default(""),
    payload: jsonb("payload").$type<MessagePayload>().notNull().default({}),
    waMessageId: text("wa_message_id"),
    status: text("status").$type<MessageStatus>().notNull().default("pending"),
    errorMessage: text("error_message"),
    sentByUserId: uuid("sent_by_user_id").references(() => users.id, { onDelete: "set null" }),
    statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("messages_wa_id").on(t.waMessageId).where(sql`${t.waMessageId} is not null`),
    index("messages_conversation").on(t.conversationId, t.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export const categories = pgTable(
  "categories",
  {
    id: id(),
    businessId: businessId(),
    name: text("name").notNull(),
    kind: text("kind").$type<"product" | "service">().notNull().default("product"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("categories_business_name").on(t.businessId, t.kind, t.name)],
);

export type ProductOption = { name: string; values: string[] };
export type CatalogStatus = "active" | "disabled";

export const products = pgTable(
  "products",
  {
    id: id(),
    businessId: businessId(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    price: integer("price").notNull(),
    discountPrice: integer("discount_price"),
    sku: text("sku").notNull().default(""),
    stock: integer("stock").notNull().default(0),
    trackStock: boolean("track_stock").notNull().default(true),
    images: jsonb("images").$type<string[]>().notNull().default([]),
    /** e.g. [{ name: "Color", values: ["Black","White"] }, { name: "Size", values: ["S","M","L"] }] */
    options: jsonb("options").$type<ProductOption[]>().notNull().default([]),
    status: text("status").$type<CatalogStatus>().notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("products_business").on(t.businessId)],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: id(),
    businessId: businessId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** e.g. { Color: "Black", Size: "L" } */
    optionValues: jsonb("option_values").$type<Record<string, string>>().notNull(),
    price: integer("price"),
    stock: integer("stock").notNull().default(0),
    sku: text("sku").notNull().default(""),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("product_variants_product").on(t.productId)],
);

export const services = pgTable(
  "services",
  {
    id: id(),
    businessId: businessId(),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    price: integer("price").notNull(),
    durationMinutes: integer("duration_minutes"),
    availability: text("availability").notNull().default(""),
    status: text("status").$type<CatalogStatus>().notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("services_business").on(t.businessId)],
);

/* ------------------------------------------------------------------ */
/* Order form                                                          */
/* ------------------------------------------------------------------ */

export const orderForms = pgTable("order_forms", {
  id: id(),
  businessId: businessId().unique(),
  name: text("name").notNull().default("Order information"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type OrderFieldType = "text" | "textarea" | "phone" | "email" | "number" | "date" | "time" | "select";

export const orderFormFields = pgTable(
  "order_form_fields",
  {
    id: id(),
    businessId: businessId(),
    formId: uuid("form_id")
      .notNull()
      .references(() => orderForms.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: text("type").$type<OrderFieldType>().notNull().default("text"),
    required: boolean("required").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    /** System fields map onto order columns and cannot be deleted. */
    system: boolean("system").notNull().default(false),
    options: jsonb("options").$type<string[]>().notNull().default([]),
    helpText: text("help_text").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("order_form_fields_key").on(t.formId, t.key)],
);

/* ------------------------------------------------------------------ */
/* Carts (draft orders) & orders                                       */
/* ------------------------------------------------------------------ */

export type CartStage =
  | "BROWSING"
  | "PRODUCT_SELECTED"
  | "COLLECTING_INFORMATION"
  | "ORDER_REVIEW"
  | "CUSTOMER_CONFIRMATION";

export const carts = pgTable(
  "carts",
  {
    id: id(),
    businessId: businessId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    status: text("status").$type<"open" | "converted" | "abandoned">().notNull().default("open"),
    stage: text("stage").$type<CartStage>().notNull().default("BROWSING"),
    /** Collected order-form values keyed by field key. */
    fields: jsonb("fields").$type<Record<string, string>>().notNull().default({}),
    /** Hash of items + fields at the moment the review was shown. */
    reviewHash: text("review_hash"),
    reviewSentAt: timestamp("review_sent_at", { withTimezone: true }),
    orderId: uuid("order_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("carts_conversation").on(t.conversationId, t.status)],
);

export const cartItems = pgTable("cart_items", {
  id: id(),
  businessId: businessId(),
  cartId: uuid("cart_id")
    .notNull()
    .references(() => carts.id, { onDelete: "cascade" }),
  productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
  /** Chosen option values, including partial choices before a variant resolves. */
  optionValues: jsonb("option_values").$type<Record<string, string>>().notNull().default({}),
  quantity: integer("quantity").notNull().default(1),
  createdAt: createdAt(),
});

export { ORDER_STATUSES, type OrderStatus } from "../lib/order-status";

export const orders = pgTable(
  "orders",
  {
    id: id(),
    businessId: businessId(),
    orderNumber: text("order_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    status: text("status").$type<OrderStatus>().notNull().default("PENDING"),
    currency: text("currency").notNull().default("LKR"),
    subtotal: integer("subtotal").notNull(),
    deliveryFee: integer("delivery_fee").notNull().default(0),
    discount: integer("discount").notNull().default(0),
    total: integer("total").notNull(),
    customerName: text("customer_name").notNull().default(""),
    customerPhone: text("customer_phone").notNull().default(""),
    deliveryAddress: text("delivery_address").notNull().default(""),
    city: text("city").notNull().default(""),
    paymentMethod: text("payment_method").notNull().default(""),
    customerNote: text("customer_note").notNull().default(""),
    internalNotes: text("internal_notes").notNull().default(""),
    trackingNumber: text("tracking_number").notNull().default(""),
    isTest: boolean("is_test").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("orders_business_number").on(t.businessId, t.orderNumber),
    index("orders_business_status").on(t.businessId, t.status),
    index("orders_customer").on(t.customerId),
  ],
);

export const orderItems = pgTable("order_items", {
  id: id(),
  businessId: businessId(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
  variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  optionValues: jsonb("option_values").$type<Record<string, string>>().notNull().default({}),
  unitPrice: integer("unit_price").notNull(),
  quantity: integer("quantity").notNull(),
  lineTotal: integer("line_total").notNull(),
});

export const orderCustomFields = pgTable("order_custom_fields", {
  id: id(),
  businessId: businessId(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  label: text("label").notNull(),
  value: text("value").notNull(),
});

export const orderStatusHistory = pgTable(
  "order_status_history",
  {
    id: id(),
    businessId: businessId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    fromStatus: text("from_status").$type<OrderStatus | null>(),
    toStatus: text("to_status").$type<OrderStatus>().notNull(),
    changedByUserId: uuid("changed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    changedBy: text("changed_by").notNull(),
    note: text("note").notNull().default(""),
    notification: text("notification").$type<"sent" | "template" | "failed" | "skipped">().notNull().default("skipped"),
    createdAt: createdAt(),
  },
  (t) => [index("order_status_history_order").on(t.orderId, t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Bot                                                                 */
/* ------------------------------------------------------------------ */

export type BotRule = { id: string; text: string; enabled: boolean };
export type AIProviderName = "openai" | "groq" | "gemini" | "claude" | "custom";
export type StatusMessageKey = Exclude<TemplatePurpose, "other" | "payment_received">;

export const botSettings = pgTable("bot_settings", {
  businessId: uuid("business_id")
    .primaryKey()
    .references(() => businesses.id, { onDelete: "cascade" }),
  botName: text("bot_name").notNull().default("Assistant"),
  welcomeMessage: text("welcome_message").notNull().default(""),
  instructions: text("instructions").notNull().default(""),
  rules: jsonb("rules").$type<BotRule[]>().notNull().default([]),
  aiEnabled: boolean("ai_enabled").notNull().default(true),
  humanHandoffEnabled: boolean("human_handoff_enabled").notNull().default(true),
  handoffMessage: text("handoff_message").notNull().default(""),
  aiProvider: text("ai_provider").$type<AIProviderName>(),
  aiModel: text("ai_model").notNull().default(""),
  aiBaseUrl: text("ai_base_url").notNull().default(""),
  aiApiKeyEnc: text("ai_api_key_enc"),
  temperature: integer("temperature_pct").notNull().default(30),
  testModeCreatesOrders: boolean("test_mode_creates_orders").notNull().default(false),
  statusMessages: jsonb("status_messages").$type<Partial<Record<StatusMessageKey, string>>>().notNull().default({}),
  updatedAt: updatedAt(),
});

export const faqs = pgTable("faqs", {
  id: id(),
  businessId: businessId(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Free-form knowledge. `kind` leaves room for uploaded documents / RAG chunks later. */
export const botKnowledge = pgTable("bot_knowledge", {
  id: id(),
  businessId: businessId(),
  kind: text("kind").$type<"note" | "document">().notNull().default("note"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ------------------------------------------------------------------ */
/* Notifications & audit                                               */
/* ------------------------------------------------------------------ */

export type NotificationType =
  | "new_order"
  | "new_customer"
  | "new_message"
  | "human_support"
  | "message_failed"
  | "low_stock"
  | "order_status"
  | "whatsapp_status";

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    businessId: businessId(),
    type: text("type").$type<NotificationType>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_business").on(t.businessId, t.createdAt)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull().default(""),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_business").on(t.businessId, t.createdAt)],
);

/** Fixed-window rate limit counters, shared across processes via the database. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
