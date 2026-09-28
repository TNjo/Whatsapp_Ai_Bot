import type { OrderStatus } from "../lib/order-status";

/**
 * Firestore data model. Every document type below is stored with Date fields
 * (Firestore Timestamps on disk); `id` is the document id and is not stored.
 *
 * Top-level collections
 *   users/{userId}                     User
 *   userEmails/{emailLowercase}        { userId }            — unique email index
 *   sessions/{sha256(token)}           Session
 *   memberships/{businessId}_{userId}  Membership
 *   businesses/{businessId}            Business
 *   phoneNumbers/{phoneNumberId}       PhoneNumberIndex      — webhook routing, one number = one business
 *   rateLimits/{key}_{windowStart}     RateLimit
 *
 * Per business (businesses/{businessId}/…) — tenant isolation by path
 *   settings/whatsapp                  WhatsAppConnection
 *   settings/bot                       BotSettings
 *   settings/orderForm                 OrderForm
 *   templates/{id}                     WhatsAppTemplate
 *   customers/{waId}                   Customer              — doc id = WhatsApp id (unique per business)
 *   conversations/{customerId}         Conversation          — one conversation per customer
 *   conversations/{id}/messages/{id}   Message
 *   waMessages/{sha256(waMessageId)}   WaMessageIndex        — dedupe + status updates
 *   categories/{id}                    Category
 *   products/{id}                      Product (variants embedded)
 *   services/{id}                      Service
 *   carts/{conversationId}             Cart (the open draft order; deleted when converted/abandoned)
 *   orders/{id}                        Order (items, custom fields and status history embedded)
 *   faqs/{id}                          Faq
 *   knowledge/{id}                     KnowledgeNote
 *   notifications/{id}                 Notification
 *   auditLogs/{id}                     AuditLog
 */

type Doc = { id: string };

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export type MemberRole = "owner" | "staff";

export type User = Doc & {
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
};

export type Membership = Doc & {
  businessId: string;
  userId: string;
  role: MemberRole;
  createdAt: Date;
};

export type Session = Doc & {
  userId: string;
  businessId: string;
  expiresAt: Date;
  userAgent: string | null;
  createdAt: Date;
};

export type Business = Doc & {
  name: string;
  logoUrl: string | null;
  description: string;
  phone: string;
  email: string;
  address: string;
  website: string;
  whatsappNumber: string;
  openingHours: string;
  deliveryInfo: string;
  deliveryFee: number;
  paymentMethods: string[];
  bankDetails: string;
  returnPolicy: string;
  exchangePolicy: string;
  currency: string;
  timezone: string;
  lowStockThreshold: number;
  nextOrderNumber: number;
  createdAt: Date;
  updatedAt: Date;
};

export const BUSINESS_DEFAULTS: Omit<Business, "id" | "name" | "createdAt" | "updatedAt"> = {
  logoUrl: null,
  description: "",
  phone: "",
  email: "",
  address: "",
  website: "",
  whatsappNumber: "",
  openingHours: "",
  deliveryInfo: "",
  deliveryFee: 0,
  paymentMethods: ["Cash on Delivery", "Bank Transfer"],
  bankDetails: "",
  returnPolicy: "",
  exchangePolicy: "",
  currency: "LKR",
  timezone: "Asia/Colombo",
  lowStockThreshold: 5,
  nextOrderNumber: 10001,
};

export type RateLimit = { count: number; windowStart: Date; expireAt: Date };

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

export type ConnectedPhone = {
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating: string | null;
};

export type WhatsAppConnection = {
  status: ConnectionStatus;
  connectedVia: "embedded_signup" | "manual" | null;
  wabaId: string | null;
  wabaName: string | null;
  accessTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  registrationPinEnc: string | null;
  phone: ConnectedPhone | null;
  health: HealthCheck[];
  lastHealthCheckAt: Date | null;
  lastWebhookEventAt: Date | null;
  lastError: string | null;
  connectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PhoneNumberIndex = Doc & { businessId: string; createdAt: Date };

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

export type WhatsAppTemplate = Doc & {
  name: string;
  language: string;
  category: string;
  purpose: TemplatePurpose;
  body: string;
  /** Ordered variable names, mapped to {{1}}, {{2}}… when sending. */
  variables: string[];
  status: "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "UNKNOWN";
  metaTemplateId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/* ------------------------------------------------------------------ */
/* Customers & conversations                                           */
/* ------------------------------------------------------------------ */

export type Customer = Doc & {
  businessId: string;
  waId: string;
  phone: string;
  profileName: string;
  displayName: string;
  email: string;
  address: string;
  city: string;
  notes: string;
  isTest: boolean;
  totalOrders: number;
  totalSpent: number;
  firstInteractionAt: Date;
  lastInteractionAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type ConversationStatus = "active" | "human_required" | "resolved";

export type Conversation = Doc & {
  businessId: string;
  customerId: string;
  status: ConversationStatus;
  aiEnabled: boolean;
  handoffReason: string | null;
  topic: string;
  isTest: boolean;
  unreadCount: number;
  lastMessageAt: Date;
  lastMessagePreview: string;
  /** Last customer message — drives the 24-hour customer service window. */
  lastInboundAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

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

export type Message = Doc & {
  businessId: string;
  conversationId: string;
  direction: MessageDirection;
  sender: MessageSender;
  type: MessageType;
  content: string;
  payload: MessagePayload;
  waMessageId: string | null;
  status: MessageStatus;
  errorMessage: string | null;
  sentByUserId: string | null;
  statusUpdatedAt: Date | null;
  createdAt: Date;
};

/** businesses/{b}/waMessages/{sha256(waMessageId)} — finds our message from a WhatsApp id. */
export type WaMessageIndex = { conversationId: string; messageId: string; createdAt: Date };

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export type Category = Doc & { name: string; kind: "product" | "service"; createdAt: Date };

export type ProductOption = { name: string; values: string[] };
export type CatalogStatus = "active" | "disabled";

export type ProductVariant = {
  id: string;
  /** e.g. { Color: "Black", Size: "L" } */
  optionValues: Record<string, string>;
  price: number | null;
  stock: number;
  sku: string;
  active: boolean;
};

export type Product = Doc & {
  businessId: string;
  categoryId: string | null;
  name: string;
  description: string;
  price: number;
  discountPrice: number | null;
  sku: string;
  stock: number;
  trackStock: boolean;
  images: string[];
  /** e.g. [{ name: "Color", values: ["Black","White"] }, { name: "Size", values: ["S","M","L"] }] */
  options: ProductOption[];
  variants: ProductVariant[];
  status: CatalogStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type Service = Doc & {
  businessId: string;
  categoryId: string | null;
  name: string;
  description: string;
  price: number;
  durationMinutes: number | null;
  availability: string;
  status: CatalogStatus;
  createdAt: Date;
  updatedAt: Date;
};

/* ------------------------------------------------------------------ */
/* Order form                                                          */
/* ------------------------------------------------------------------ */

export type OrderFieldType = "text" | "textarea" | "phone" | "email" | "number" | "date" | "time" | "select";

export type OrderFormField = {
  id: string;
  key: string;
  label: string;
  type: OrderFieldType;
  required: boolean;
  enabled: boolean;
  /** System fields map onto order columns and cannot be deleted. */
  system: boolean;
  options: string[];
  helpText: string;
  sortOrder: number;
};

export type OrderForm = { name: string; fields: OrderFormField[]; updatedAt: Date };

/* ------------------------------------------------------------------ */
/* Carts (draft orders) & orders                                       */
/* ------------------------------------------------------------------ */

export type CartStage =
  | "BROWSING"
  | "PRODUCT_SELECTED"
  | "COLLECTING_INFORMATION"
  | "ORDER_REVIEW"
  | "CUSTOMER_CONFIRMATION";

export type CartItem = {
  id: string;
  productId: string | null;
  variantId: string | null;
  serviceId: string | null;
  /** Chosen option values, including partial choices before a variant resolves. */
  optionValues: Record<string, string>;
  quantity: number;
  createdAt: Date;
};

/** businesses/{b}/carts/{conversationId}: the open draft order of a conversation. */
export type Cart = Doc & {
  businessId: string;
  conversationId: string;
  customerId: string;
  stage: CartStage;
  items: CartItem[];
  /** Collected order-form values keyed by field key. */
  fields: Record<string, string>;
  /** Hash of items + fields at the moment the review was shown. */
  reviewHash: string | null;
  reviewSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export { ORDER_STATUSES, type OrderStatus } from "../lib/order-status";

export type OrderItem = {
  id: string;
  productId: string | null;
  variantId: string | null;
  serviceId: string | null;
  name: string;
  optionValues: Record<string, string>;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
};

export type OrderCustomField = { key: string; label: string; value: string };

export type OrderStatusChange = {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  changedByUserId: string | null;
  changedBy: string;
  note: string;
  notification: "sent" | "template" | "failed" | "skipped";
  createdAt: Date;
};

export type Order = Doc & {
  businessId: string;
  orderNumber: string;
  customerId: string;
  conversationId: string | null;
  status: OrderStatus;
  currency: string;
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  city: string;
  paymentMethod: string;
  customerNote: string;
  internalNotes: string;
  trackingNumber: string;
  isTest: boolean;
  items: OrderItem[];
  customFields: OrderCustomField[];
  history: OrderStatusChange[];
  createdAt: Date;
  updatedAt: Date;
};

/* ------------------------------------------------------------------ */
/* Bot                                                                 */
/* ------------------------------------------------------------------ */

export type BotRule = { id: string; text: string; enabled: boolean };
export type AIProviderName = "openai" | "groq" | "gemini" | "claude" | "custom";
export type StatusMessageKey = Exclude<TemplatePurpose, "other" | "payment_received">;

export type BotSettings = {
  businessId: string;
  botName: string;
  welcomeMessage: string;
  instructions: string;
  rules: BotRule[];
  aiEnabled: boolean;
  humanHandoffEnabled: boolean;
  handoffMessage: string;
  aiProvider: AIProviderName | null;
  aiModel: string;
  aiBaseUrl: string;
  aiApiKeyEnc: string | null;
  temperature: number;
  testModeCreatesOrders: boolean;
  statusMessages: Partial<Record<StatusMessageKey, string>>;
  updatedAt: Date;
};

export type Faq = Doc & {
  question: string;
  answer: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Free-form knowledge. `kind` leaves room for uploaded documents / RAG chunks later. */
export type KnowledgeNote = Doc & {
  kind: "note" | "document";
  title: string;
  content: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

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
  | "order_status";

export type Notification = Doc & {
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export type AuditLog = Doc & {
  userId: string | null;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: Date;
};
