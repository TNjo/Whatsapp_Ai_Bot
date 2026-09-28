import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, fromDoc, fromDocs, store } from "@/db";
import type { Cart, Conversation, Customer, Message, Notification, NotificationType, Order } from "@/db/schema";
import { setMockAIHandler } from "@/server/ai/service";
import { orderDetail } from "@/server/admin/orders";
import { registerBusiness } from "@/server/business";
import { changeOrderStatus } from "@/server/commerce/orders";
import { loadConversation } from "@/server/conversations";
import { subscribe, type RealtimeEvent } from "@/server/events";
import { loadSampleData } from "@/server/sample-data";
import { connectManually } from "@/server/whatsapp/connection";
import { processWebhook, verifySignature, type WebhookPayload } from "@/server/whatsapp/webhook";
import { DISPLAY_PHONE, PHONE_NUMBER_ID, sentText, startMockGraph, WABA_ID } from "./helpers/mock-graph";
import { scriptedAI } from "./helpers/scripted-ai";

const OWNER = { name: "Tharuka", userId: null };
let graph: Awaited<ReturnType<typeof startMockGraph>>;
let businessId: string;
const events: RealtimeEvent[] = [];
let waSeq = 0;

function signedWebhook(payload: WebhookPayload) {
  const raw = JSON.stringify(payload);
  const signature = "sha256=" + crypto.createHmac("sha256", process.env.META_APP_SECRET!).update(raw).digest("hex");
  return { raw, signature };
}

/** Delivers a customer message exactly as Meta would: signed JSON → verify → process. */
async function customerSends(waId: string, input: string | { replyId: string; title: string }, name = "Kasun Perera") {
  const id = `wamid.IN${++waSeq}`;
  const message =
    typeof input === "string"
      ? { id, from: waId, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: input } }
      : {
          id,
          from: waId,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: "interactive",
          interactive: { type: "button_reply", button_reply: { id: input.replyId, title: input.title } },
        };
  const payload: WebhookPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: DISPLAY_PHONE, phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name }, wa_id: waId }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
  const { raw, signature } = signedWebhook(payload);
  expect(verifySignature(raw, signature)).toBe(true);
  await processWebhook(JSON.parse(raw));
  return id;
}

const lastSent = () => sentText(graph.sent().at(-1)!);

/** Firestore lookups for assertions. Customer and conversation ids equal the WhatsApp id. */
const data = {
  customer: async (waId: string) => fromDoc<Customer>(await (await store()).customers(businessId).doc(waId).get()),
  conversation: async (waId: string) => fromDoc<Conversation>(await (await store()).conversations(businessId).doc(waId).get()),
  orders: async () => fromDocs<Order>(await (await store()).orders(businessId).get()),
  ordersOf: async (waId: string) => (await data.orders()).filter((o) => o.customerId === waId),
  notifications: async (type: NotificationType) =>
    fromDocs<Notification>(await (await store()).notifications(businessId).get()).filter((n) => n.type === type),
  messages: async () =>
    fromDocs<Message>(await (await store()).db.collectionGroup("messages").where("businessId", "==", businessId).get()).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    ),
};

beforeAll(async () => {
  graph = await startMockGraph({ appId: process.env.META_APP_ID!, callbackUrl: `${process.env.APP_URL}/api/webhooks/whatsapp` });
  process.env.WHATSAPP_GRAPH_BASE_URL = graph.baseUrl;
  setMockAIHandler(scriptedAI);

  const { business } = await registerBusiness({ businessName: "UrbanStyle", name: "Tharuka", email: "owner@urbanstyle.test", password: "password123" });
  businessId = business.id;
  await loadSampleData(businessId, OWNER);
  const view = await connectManually(businessId, { accessToken: "EAAtesttoken0000000000000000", phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID }, OWNER);
  expect(view.status).toBe("connected");
  subscribe(businessId, (event) => events.push(event));
});

afterAll(async () => {
  setMockAIHandler(undefined);
  await graph?.close();
  await closeDb();
});

describe("WhatsApp connection", () => {
  it("verifies every health check against the Graph API", async () => {
    const { connectionView } = await import("@/server/whatsapp/connection");
    const view = await connectionView(businessId);
    expect(view.connection?.displayPhoneNumber).toBe(DISPLAY_PHONE);
    expect(view.connection?.health.map((h) => [h.key, h.ok])).toEqual([
      ["account", true],
      ["phone", true],
      ["api", true],
      ["webhook", true],
      ["messaging", true],
      ["bot", true],
    ]);
  });

  it("never stores the access token in plain text", async () => {
    const raw = (await (await store()).whatsapp(businessId).get()).data();
    expect(raw?.accessTokenEnc).toMatch(/^v1\./);
    expect(JSON.stringify(raw)).not.toContain("EAAtesttoken");
  });
});

describe("acceptance scenario (spec §61)", () => {
  const kasun = "94771234567";
  let orderId = "";

  it("welcomes a new customer", async () => {
    await customerSends(kasun, "Hi");
    expect(lastSent()).toContain("Welcome to UrbanStyle");
    const customer = (await data.customer(kasun))!;
    expect(customer.profileName).toBe("Kasun Perera");
    expect(customer.phone).toBe("+94771234567");
  });

  it("answers product questions from the real catalog", async () => {
    await customerSends(kasun, "Do you have black t-shirts?");
    const reply = lastSent();
    expect(reply).toContain("Classic Black T-Shirt — Rs. 2,500");
    expect(reply).toContain("Premium Black T-Shirt — Rs. 3,500");
    expect(reply).not.toContain("Slim Fit Jeans"); // out of stock / not matching
  });

  it("collects the order and only asks for what is missing", async () => {
    await customerSends(kasun, "I want 2 classic black t-shirts in large");
    const ask = lastSent();
    expect(ask).toContain("Full Name");
    expect(ask).toContain("Delivery Address");
    expect(ask).not.toContain("Phone Number"); // known from WhatsApp

    await customerSends(kasun, "kasun perera, 12 galle road, colombo 05");
    expect(lastSent()).toContain("Payment Method");
  });

  it("shows a computed review with Confirm / Edit / Cancel buttons", async () => {
    await customerSends(kasun, "Cash on delivery");
    const review = graph.sent().at(-1)!;
    expect(review.type).toBe("interactive");
    const text = sentText(review);
    expect(text).toContain("Classic Black T-Shirt");
    expect(text).toContain("Size: L");
    expect(text).toContain("Quantity: 2");
    expect(text).toContain("Items: Rs. 5,000");
    expect(text).toContain("Delivery: Rs. 350");
    expect(text).toContain("Total: Rs. 5,350");
    const buttons = (review.interactive as { action: { buttons: { reply: { id: string } }[] } }).action.buttons.map((b) => b.reply.id);
    expect(buttons).toEqual(["confirm_order", "edit_order", "cancel_order"]);

    expect(await data.orders()).toHaveLength(0); // still a draft
  });

  it("creates a PENDING order only when the customer confirms, and notifies the dashboard", async () => {
    await customerSends(kasun, { replyId: "confirm_order", title: "Confirm Order" });
    expect(lastSent()).toMatch(/Your order \*#ORD-10001\* has been placed/);

    const [order] = await data.orders();
    orderId = order.id;
    expect(order).toMatchObject({
      orderNumber: "ORD-10001",
      status: "PENDING",
      total: 535000,
      customerName: "Kasun Perera",
      city: "Colombo 05",
      paymentMethod: "Cash on Delivery",
      customerPhone: "+94771234567",
    });
    expect(events.some((e) => e.type === "order.created" && e.orderNumber === "ORD-10001")).toBe(true);
    const [notification] = await data.notifications("new_order");
    expect(notification.title).toBe("New order ORD-10001");

    const detail = await orderDetail(businessId, orderId);
    expect(detail.items[0]).toMatchObject({ name: "Classic Black T-Shirt", quantity: 2, optionValues: { Size: "L" }, lineTotal: 500000 });
    expect(detail.history.map((h) => h.toStatus)).toEqual(["PENDING"]);
  });

  it("reserves stock for the order", async () => {
    const { getProduct } = await import("@/server/commerce/catalog");
    const detail = await orderDetail(businessId, orderId);
    const product = await getProduct(businessId, detail.items[0].productId!);
    const large = product!.variants.find((v) => v.optionValues.Size === "L")!;
    expect(large.stock).toBe(10); // 12 − 2
  });

  it("sends WhatsApp updates as the owner moves the order along", async () => {
    await changeOrderStatus(businessId, orderId, "CONFIRMED", OWNER);
    expect(lastSent()).toContain("Good news! Your order #ORD-10001 has been confirmed.");
    expect(lastSent()).toContain("Total: Rs. 5,350");

    await changeOrderStatus(businessId, orderId, "PROCESSING", OWNER);
    expect(lastSent()).toBe("Your order #ORD-10001 is now being prepared.");

    await changeOrderStatus(businessId, orderId, "DISPATCHED", OWNER, { trackingNumber: "TRK123456" });
    expect(lastSent()).toContain("has been dispatched");
    expect(lastSent()).toContain("TRK123456");
  });

  it("answers 'where is my order?' from the database", async () => {
    await customerSends(kasun, "Where is my order?");
    expect(lastSent()).toContain("#ORD-10001");
    expect(lastSent()).toContain("Dispatched");
    expect(lastSent()).toContain("TRK123456");
  });

  it("completes the order and records the full status history", async () => {
    await changeOrderStatus(businessId, orderId, "DELIVERED", OWNER);
    expect(lastSent()).toBe("Your order #ORD-10001 has been delivered.");
    await changeOrderStatus(businessId, orderId, "COMPLETED", OWNER);
    expect(lastSent()).toContain("has been completed");

    const detail = await orderDetail(businessId, orderId);
    expect(detail.history.map((h) => [h.fromStatus, h.toStatus, h.notification])).toEqual([
      [null, "PENDING", "skipped"],
      ["PENDING", "CONFIRMED", "sent"],
      ["CONFIRMED", "PROCESSING", "sent"],
      ["PROCESSING", "DISPATCHED", "sent"],
      ["DISPATCHED", "DELIVERED", "sent"],
      ["DELIVERED", "COMPLETED", "sent"],
    ]);
    expect(detail.customer.totalOrders).toBe(1);
    expect(detail.customer.totalSpent).toBe(535000);
  });

  it("rejects invalid status jumps", async () => {
    await expect(changeOrderStatus(businessId, orderId, "PROCESSING", OWNER)).rejects.toThrow(/can't go from Completed/);
  });
});

describe("webhook safety", () => {
  it("rejects bad signatures", () => {
    const { raw } = signedWebhook({ object: "whatsapp_business_account", entry: [] });
    expect(verifySignature(raw, "sha256=" + "0".repeat(64))).toBe(false);
    expect(verifySignature(raw, null)).toBe(false);
    expect(verifySignature(raw + " ", signedWebhook({ object: "whatsapp_business_account", entry: [] }).signature)).toBe(false);
  });

  it("processes a retried webhook only once", async () => {
    const waId = "94770000001";
    const payload: WebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                contacts: [{ profile: { name: "Nimal" }, wa_id: waId }],
                messages: [{ id: "wamid.DUPLICATE", from: waId, type: "text", text: { body: "hello there" } }],
              },
            },
          ],
        },
      ],
    };
    const before = graph.sent().length;
    await processWebhook(payload);
    await processWebhook(payload);
    const stored = (await data.messages()).filter((m) => m.waMessageId === "wamid.DUPLICATE");
    expect(stored).toHaveLength(1);
    expect(graph.sent().length - before).toBe(1); // one reply, not two
  });

  it("tracks delivered / read / failed statuses on sent messages", async () => {
    const outbound = (await data.messages()).filter((m) => m.direction === "outbound").at(-1)!;
    const reread = async () => (await data.messages()).find((m) => m.id === outbound.id)!;
    const statusPayload = (status: string, errors?: unknown[]): WebhookPayload => ({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, statuses: [{ id: outbound.waMessageId!, status, errors } as never] } }] }],
    });
    await processWebhook(statusPayload("delivered"));
    await processWebhook(statusPayload("read"));
    await processWebhook(statusPayload("delivered")); // out of order: must not downgrade
    let row = await reread();
    expect(row.status).toBe("read");
    await processWebhook(statusPayload("failed", [{ code: 131026, message: "Undeliverable" }]));
    row = await reread();
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toMatch(/could not be delivered/);
  });

  it("ignores messages for phone numbers that aren't connected", async () => {
    const before = (await data.messages()).length;
    await processWebhook({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "999" }, messages: [{ id: "wamid.X", from: "1", type: "text", text: { body: "hi" } }] } }] }],
    });
    expect((await data.messages()).length).toBe(before);
  });
});

describe("order rules", () => {
  it("never creates an order without a confirmed review", async () => {
    const waId = "94770000002";
    await customerSends(waId, "I want 1 premium black t-shirt in medium", "Amaya");
    await customerSends(waId, "confirm");
    expect(lastSent()).toMatch(/Sorry/);
    expect(await data.ordersOf(waId)).toHaveLength(0);
  });

  it("drops a stale review when the order changes after it was shown", async () => {
    const waId = "94770000003";
    await customerSends(waId, "I want 1 classic black t-shirt in medium", "Ruwan");
    await customerSends(waId, "ruwan silva, 4 lake road, colombo 07");
    await customerSends(waId, "Cash on delivery");
    expect(sentText(graph.sent().at(-1)!)).toContain("Total: Rs. 2,850");
    // The draft changes after the review was shown (no new review sent), then the old Confirm button is tapped.
    const cartRef = (await store()).carts(businessId).doc(waId);
    const cart = fromDoc<Cart>(await cartRef.get())!;
    await cartRef.update({ items: cart.items.map((item) => ({ ...item, quantity: 3 })) });
    await customerSends(waId, { replyId: "confirm_order", title: "Confirm Order" }, "Ruwan");
    expect(lastSent()).toContain("Your order was updated — please check the new summary.");
    expect(lastSent()).toContain("Total: Rs. 7,850");
    expect(await data.ordersOf(waId)).toHaveLength(0);
    // Confirming the refreshed summary places the order with the new quantity.
    await customerSends(waId, { replyId: "confirm_order", title: "Confirm Order" }, "Ruwan");
    expect((await data.ordersOf(waId)).map((o) => o.total)).toEqual([785000]);
  });
});

describe("human handoff", () => {
  it("hands over when the AI fails and stays quiet until resumed", async () => {
    const waId = "94770000004";
    setMockAIHandler(() => {
      throw new Error("provider down");
    });
    await customerSends(waId, "Can I get a custom size?", "Dilini");
    setMockAIHandler(scriptedAI);
    expect(lastSent()).toContain("I'm having trouble processing your request right now.");

    const conversation = (await data.conversation(waId))!;
    expect(conversation.status).toBe("human_required");
    expect(conversation.aiEnabled).toBe(false);
    const alerts = await data.notifications("human_support");
    expect(alerts.length).toBeGreaterThan(0);

    const before = graph.sent().length;
    await customerSends(waId, "hello?", "Dilini");
    expect(graph.sent().length).toBe(before); // AI paused: no automatic reply
  });

  it("lets the customer ask for a person", async () => {
    await customerSends("94770000005", "I want to speak to a manager", "Saman");
    expect(lastSent()).toContain("I'll connect you with our team");
  });
});

describe("24-hour customer service window", () => {
  it("uses an approved template when the window is closed, and warns when none exists", async () => {
    const waId = "94770000006";
    await customerSends(waId, "I want 1 classic black t-shirt in xl", "Old Customer");
    await customerSends(waId, "old customer, 1 temple road, colombo 03");
    await customerSends(waId, "Cash on delivery");
    await customerSends(waId, { replyId: "confirm_order", title: "Confirm Order" }, "Old Customer");
    const [order] = await data.ordersOf(waId);
    const s = await store();

    // Pretend the customer last wrote two days ago.
    await s.conversations(businessId).doc(order.conversationId!).update({ lastInboundAt: new Date(Date.now() - 2 * 86400000) });

    const noTemplate = await changeOrderStatus(businessId, order.id, "CONFIRMED", OWNER);
    expect(noTemplate.notification.notification).toBe("failed");
    const warn = await data.notifications("message_failed");
    expect(warn.some((n) => n.title.includes(order.orderNumber))).toBe(true);

    await s.templates(businessId).doc("order_update_processing__en").set({
      name: "order_update_processing",
      language: "en",
      category: "UTILITY",
      purpose: "order_processing",
      status: "APPROVED",
      body: "Hi {{1}}, order {{2}} is being prepared.",
      variables: ["customer_name", "order_id"],
      metaTemplateId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const viaTemplate = await changeOrderStatus(businessId, order.id, "PROCESSING", OWNER);
    expect(viaTemplate.notification.notification).toBe("template");
    const sent = graph.sent().at(-1)!;
    expect(sent.type).toBe("template");
    expect(sentText(sent)).toBe(`[template order_update_processing] Old | ${order.orderNumber}`);

    const { history } = await orderDetail(businessId, order.id);
    expect(history.map((h) => h.notification)).toEqual(["skipped", "failed", "template"]);
  });
});

describe("tenant isolation", () => {
  it("never lets another business read orders or conversations", async () => {
    const { business: other } = await registerBusiness({ businessName: "Other Shop", name: "Eve", email: "eve@other.test", password: "password123" });
    const [order] = await data.orders();
    await expect(orderDetail(other.id, order.id)).rejects.toThrow("Order not found");
    await expect(loadConversation(other.id, order.conversationId!)).rejects.toThrow("Conversation not found");
    await expect(changeOrderStatus(other.id, order.id, "CANCELLED", OWNER)).rejects.toThrow("Order not found");
  });

  it("refuses to connect a number that belongs to another business", async () => {
    const { business: other } = await registerBusiness({ businessName: "Copycat", name: "Mallory", email: "mallory@copycat.test", password: "password123" });
    await expect(
      connectManually(other.id, { accessToken: "EAAanothertoken000000000000", phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID }, OWNER),
    ).rejects.toThrow(/already connected to another business/);
  });
});

describe("sending failures", () => {
  it("falls back to text when an interactive message is rejected", async () => {
    const waId = "94770000007";
    await customerSends(waId, "I want 1 classic black t-shirt in medium", "Fallback");
    await customerSends(waId, "fallback user, 2 main street, colombo 02");
    graph.failNextSend(131009, "Parameter value is not valid");
    await customerSends(waId, "Cash on delivery");
    const last = graph.sent().at(-1)!;
    expect(last.type).toBe("text");
    expect(sentText(last)).toContain("1. Confirm Order");
  });

  it("marks the message failed and alerts the owner when WhatsApp refuses it", async () => {
    graph.failNextSend(131026, "Message undeliverable");
    await customerSends("94770000008", "Do you have hoodies?", "Unreachable");
    const failed = (await data.messages()).filter((m) => m.status === "failed").at(-1)!;
    expect(failed.errorMessage).toMatch(/could not be delivered/);
    const alerts = await data.notifications("message_failed");
    expect(alerts.some((a) => a.title.includes("Unreachable"))).toBe(true);
  });
});

describe("dashboard reads (every query must have its Firestore index declared)", () => {
  it("serves the orders, inbox, customers, catalog, dashboard, WhatsApp and settings pages", async () => {
    const { listOrders, statusCounts } = await import("@/server/admin/orders");
    const { listConversations, conversationDetail, conversationMessages } = await import("@/server/admin/inbox");
    const { dashboardData } = await import("@/server/admin/dashboard");
    const { whatsappOverview, listTemplates, statusMessagesView } = await import("@/server/admin/whatsapp");
    const { shellCounts, listNotifications } = await import("@/server/queries/shell");
    const { listCustomers, getCustomer } = await import("@/server/admin/customers");
    const { listProducts } = await import("@/server/admin/products");
    const { listServices } = await import("@/server/admin/services");
    const { getBusinessProfile, listMembers, listAuditLogs } = await import("@/server/admin/business-settings");
    const { getBotSettingsView, listKnowledge, getBusinessFacts, getOrderFormView } = await import("@/server/admin/bot");

    for (const status of ["PENDING", "OPEN", "COMPLETED", "ALL", "CONFIRMED"] as const) {
      await listOrders(businessId, { status });
      await listOrders(businessId, { status, includeTest: true });
      await listOrders(businessId, { status, q: "kasun" });
    }
    const all = await listOrders(businessId, { status: "ALL" });
    expect(all.total).toBeGreaterThanOrEqual(3);
    expect(all.orders[0].customer.phone).toMatch(/^\+94/);
    expect((await listOrders(businessId, { status: "ALL", q: "ORD-10001" })).orders.map((o) => o.orderNumber)).toEqual(["ORD-10001"]);
    expect((await statusCounts(businessId)).COMPLETED).toBe(1);
    await statusCounts(businessId, true);

    for (const filter of ["all", "human", "unread", "active", "resolved"] as const) await listConversations(businessId, { filter });
    const inbox = await listConversations(businessId, { q: "771234567" });
    expect(inbox.map((c) => c.displayName)).toEqual(["Kasun Perera"]);
    const detail = await conversationDetail(businessId, inbox[0].id);
    expect(detail.messages.length).toBeGreaterThan(5);
    await conversationMessages(businessId, inbox[0].id, new Date());

    const dash = await dashboardData(businessId, "Asia/Colombo");
    expect(dash.stats.completed).toBe(1);
    expect(dash.stats.customers).toBeGreaterThan(3);
    expect(dash.handoffs.length).toBeGreaterThan(0);

    const overview = await whatsappOverview(businessId);
    expect(overview.stats.messages).toBeGreaterThan(10);
    await listTemplates(businessId);
    await statusMessagesView(businessId);
    const counts = await shellCounts(businessId);
    expect(counts.humanRequired).toBeGreaterThan(0);
    await listNotifications(businessId);

    const customers = await listCustomers(businessId, { query: "771234567" });
    expect(customers.customers.length).toBe(1);
    await getCustomer(businessId, customers.customers[0].id);
    expect((await listProducts(businessId)).length).toBe(5);
    await listProducts(businessId, { status: "out_of_stock" });
    await listServices(businessId);
    await getBusinessProfile(businessId);
    await listMembers(businessId);
    expect((await listAuditLogs(businessId)).length).toBeGreaterThan(0);
    await getBotSettingsView(businessId);
    await listKnowledge(businessId);
    await getBusinessFacts(businessId);
    await getOrderFormView(businessId);
  });
});

describe("dashboard writes (Firestore transactions read before they write)", () => {
  it("edits products, stock, customers, team, FAQs, notes, bot settings and the order form", async () => {
    const products = await import("@/server/admin/products");
    const { updateCustomer } = await import("@/server/admin/customers");
    const settings = await import("@/server/admin/business-settings");
    const bot = await import("@/server/admin/bot");

    const created = await products.createProduct(
      businessId,
      products.ProductInput.parse({ name: "Linen Shirt", price: "4200", options: [{ name: "Size", values: ["M", "L"] }], variants: [] }),
      OWNER,
    );
    const detail = (await products.getProductDetail(businessId, created.id))!;
    const updated = await products.updateProduct(businessId, created.id, { options: [{ name: "Size", values: ["M", "L", "XL"] }] }, OWNER);
    expect(updated.variants.length).toBe(3);
    expect(updated.variants.filter((v) => detail.variants.some((d) => d.id === v.id)).length).toBe(2); // ids kept
    await products.setProductStock(businessId, created.id, { variants: updated.variants.map((v) => ({ id: v.id, stock: 4 })) }, OWNER);
    expect((await products.getProductDetail(businessId, created.id))!.stock).toBe(12);
    await products.deleteProduct(businessId, created.id, OWNER);

    await updateCustomer(businessId, "94771234567", { notes: "VIP" }, OWNER);
    expect((await data.customer("94771234567"))?.notes).toBe("VIP");

    await settings.updateBusinessProfile(businessId, { openingHours: "9–5" }, OWNER);
    const staff = await settings.addStaffMember(businessId, { name: "Nimal", email: "nimal@shop.test", password: "password123" }, OWNER);
    expect((await settings.listMembers(businessId)).length).toBe(2);
    await settings.removeMember(businessId, staff.id, OWNER);
    expect((await settings.listMembers(businessId)).length).toBe(1);

    const faq = await bot.createFaq(businessId, { question: "Gift wrap?", answer: "Yes, free.", enabled: true }, OWNER);
    await bot.updateFaq(businessId, faq.id, { move: "up" }, OWNER);
    await bot.deleteFaq(businessId, faq.id, OWNER);
    const note = await bot.createNote(businessId, { title: "Sizes", content: "Runs small.", enabled: true }, OWNER);
    await bot.updateNote(businessId, note.id, { content: "Runs one size small." }, OWNER);
    await bot.deleteNote(businessId, note.id, OWNER);
    await bot.updateBotSettings(businessId, { botName: "UrbanStyle Assistant" }, OWNER);

    const form = await bot.getOrderFormView(businessId);
    await bot.replaceOrderForm(
      businessId,
      bot.OrderFormInput.parse({
        fields: [...form.fields, { key: "gift_note", label: "Gift note", type: "textarea", required: false, enabled: true, options: [], helpText: "" }],
      }),
      OWNER,
    );
    expect((await bot.getOrderFormView(businessId)).fields.some((f) => f.key === "gift_note")).toBe(true);
  });
});

