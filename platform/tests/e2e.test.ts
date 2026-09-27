import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { conversations, customers, messages, notifications, orders, orderStatusHistory, whatsappTemplates } from "@/db/schema";
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
    const db = await getDb();
    const rows = await db.execute("select access_token_enc from whatsapp_connections");
    expect(JSON.stringify(rows)).not.toContain("EAAtesttoken");
  });
});

describe("acceptance scenario (spec §61)", () => {
  const kasun = "94771234567";
  let orderId = "";

  it("welcomes a new customer", async () => {
    await customerSends(kasun, "Hi");
    expect(lastSent()).toContain("Welcome to UrbanStyle");
    const db = await getDb();
    const [customer] = await db.select().from(customers).where(and(eq(customers.businessId, businessId), eq(customers.waId, kasun)));
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

    const db = await getDb();
    expect(await db.select().from(orders).where(eq(orders.businessId, businessId))).toHaveLength(0); // still a draft
  });

  it("creates a PENDING order only when the customer confirms, and notifies the dashboard", async () => {
    await customerSends(kasun, { replyId: "confirm_order", title: "Confirm Order" });
    expect(lastSent()).toMatch(/Your order \*#ORD-10001\* has been placed/);

    const db = await getDb();
    const [order] = await db.select().from(orders).where(eq(orders.businessId, businessId));
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
    const [notification] = await db.select().from(notifications).where(and(eq(notifications.businessId, businessId), eq(notifications.type, "new_order")));
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
    const db = await getDb();
    const stored = await db.select().from(messages).where(eq(messages.waMessageId, "wamid.DUPLICATE"));
    expect(stored).toHaveLength(1);
    expect(graph.sent().length - before).toBe(1); // one reply, not two
  });

  it("tracks delivered / read / failed statuses on sent messages", async () => {
    const db = await getDb();
    const [outbound] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.businessId, businessId), eq(messages.direction, "outbound")))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const statusPayload = (status: string, errors?: unknown[]): WebhookPayload => ({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, statuses: [{ id: outbound.waMessageId!, status, errors } as never] } }] }],
    });
    await processWebhook(statusPayload("delivered"));
    await processWebhook(statusPayload("read"));
    await processWebhook(statusPayload("delivered")); // out of order: must not downgrade
    let [row] = await db.select().from(messages).where(eq(messages.id, outbound.id));
    expect(row.status).toBe("read");
    await processWebhook(statusPayload("failed", [{ code: 131026, message: "Undeliverable" }]));
    [row] = await db.select().from(messages).where(eq(messages.id, outbound.id));
    expect(row.status).toBe("failed");
    expect(row.errorMessage).toMatch(/could not be delivered/);
  });

  it("ignores messages for phone numbers that aren't connected", async () => {
    const db = await getDb();
    const before = (await db.select().from(messages)).length;
    await processWebhook({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "999" }, messages: [{ id: "wamid.X", from: "1", type: "text", text: { body: "hi" } }] } }] }],
    });
    expect((await db.select().from(messages)).length).toBe(before);
  });
});

describe("order rules", () => {
  it("never creates an order without a confirmed review", async () => {
    const waId = "94770000002";
    await customerSends(waId, "I want 1 premium black t-shirt in medium", "Amaya");
    await customerSends(waId, "confirm");
    expect(lastSent()).toMatch(/Sorry/);
    const db = await getDb();
    const customerOrders = await db
      .select()
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(eq(customers.waId, waId));
    expect(customerOrders).toHaveLength(0);
  });

  it("drops a stale review when the order changes after it was shown", async () => {
    const waId = "94770000003";
    await customerSends(waId, "I want 1 classic black t-shirt in medium", "Ruwan");
    await customerSends(waId, "ruwan silva, 4 lake road, colombo 07");
    await customerSends(waId, "Cash on delivery");
    expect(sentText(graph.sent().at(-1)!)).toContain("Total: Rs. 2,850");
    // The draft changes after the review was shown (no new review sent), then the old Confirm button is tapped.
    const db = await getDb();
    const { cartItems, carts } = await import("@/db/schema");
    const [cart] = await db
      .select({ id: carts.id })
      .from(carts)
      .innerJoin(customers, eq(customers.id, carts.customerId))
      .where(and(eq(customers.waId, waId), eq(carts.status, "open")));
    await db.update(cartItems).set({ quantity: 3 }).where(eq(cartItems.cartId, cart.id));
    await customerSends(waId, { replyId: "confirm_order", title: "Confirm Order" }, "Ruwan");
    expect(lastSent()).toContain("Your order was updated — please check the new summary.");
    expect(lastSent()).toContain("Total: Rs. 7,850");
    const db2 = await getDb();
    expect(await db2.select().from(orders).innerJoin(customers, eq(customers.id, orders.customerId)).where(eq(customers.waId, waId))).toHaveLength(0);
    // Confirming the refreshed summary places the order with the new quantity.
    await customerSends(waId, { replyId: "confirm_order", title: "Confirm Order" }, "Ruwan");
    const rows = await db.select({ order: orders }).from(orders).innerJoin(customers, eq(customers.id, orders.customerId)).where(eq(customers.waId, waId));
    expect(rows.map((r) => r.order.total)).toEqual([785000]);
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

    const db = await getDb();
    const [customer] = await db.select().from(customers).where(and(eq(customers.businessId, businessId), eq(customers.waId, waId)));
    const [conversation] = await db.select().from(conversations).where(eq(conversations.customerId, customer.id));
    expect(conversation.status).toBe("human_required");
    expect(conversation.aiEnabled).toBe(false);
    const alerts = await db.select().from(notifications).where(and(eq(notifications.businessId, businessId), eq(notifications.type, "human_support")));
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
    const db = await getDb();
    const [row] = await db
      .select({ order: orders })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(eq(customers.waId, waId));
    const order = row.order;

    // Pretend the customer last wrote two days ago.
    await db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 2 * 86400000) }).where(eq(conversations.id, order.conversationId!));

    const noTemplate = await changeOrderStatus(businessId, order.id, "CONFIRMED", OWNER);
    expect(noTemplate.notification.notification).toBe("failed");
    const warn = await db.select().from(notifications).where(and(eq(notifications.businessId, businessId), eq(notifications.type, "message_failed")));
    expect(warn.some((n) => n.title.includes(order.orderNumber))).toBe(true);

    await db.insert(whatsappTemplates).values({
      businessId,
      name: "order_update_processing",
      language: "en",
      purpose: "order_processing",
      status: "APPROVED",
      body: "Hi {{1}}, order {{2}} is being prepared.",
      variables: ["customer_name", "order_id"],
    });
    const viaTemplate = await changeOrderStatus(businessId, order.id, "PROCESSING", OWNER);
    expect(viaTemplate.notification.notification).toBe("template");
    const sent = graph.sent().at(-1)!;
    expect(sent.type).toBe("template");
    expect(sentText(sent)).toBe(`[template order_update_processing] Old | ${order.orderNumber}`);

    const history = await db.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, order.id));
    expect(history.map((h) => h.notification)).toEqual(["skipped", "failed", "template"]);
  });
});

describe("tenant isolation", () => {
  it("never lets another business read orders or conversations", async () => {
    const { business: other } = await registerBusiness({ businessName: "Other Shop", name: "Eve", email: "eve@other.test", password: "password123" });
    const db = await getDb();
    const [order] = await db.select().from(orders).where(eq(orders.businessId, businessId)).limit(1);
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
    const db = await getDb();
    const [failed] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.businessId, businessId), eq(messages.status, "failed")))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    expect(failed.errorMessage).toMatch(/could not be delivered/);
    const alerts = await db.select().from(notifications).where(and(eq(notifications.businessId, businessId), eq(notifications.type, "message_failed")));
    expect(alerts.some((a) => a.title.includes("Unreachable"))).toBe(true);
  });
});
