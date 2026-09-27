import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { conversations, customers, messages, orders, orderStatusHistory, whatsappConnections } from "@/db/schema";
import { setMockAIHandler } from "@/server/ai/service";
import { registerBusiness } from "@/server/business";
import { changeOrderStatus } from "@/server/commerce/orders";
import { loadSampleData } from "@/server/sample-data";
import { connectionView, connectManually, disconnect } from "@/server/whatsapp/connection";
import { linkState, setWebDriver, startLink, type WebClientLike, type WebMessage } from "@/server/whatsapp/web";
import { scriptedAI } from "./helpers/scripted-ai";

/** Stands in for whatsapp-web.js: emits the same events and records what the platform sends. */
class FakeClient extends EventEmitter implements WebClientLike {
  sent: { chatId: string; content: string; id: string }[] = [];
  seen: string[] = [];
  loggedOut = false;
  destroyed = false;
  info?: WebClientLike["info"];
  lidToPhone = new Map<string, string>();
  private seq = 0;

  async initialize() {}
  async destroy() {
    this.destroyed = true;
  }
  async logout() {
    this.loggedOut = true;
  }
  async sendMessage(chatId: string, content: unknown) {
    const id = `true_${chatId}_OUT${++this.seq}`;
    this.sent.push({ chatId, content: String(content), id });
    // Real clients echo our own sends through message_create.
    this.emit("message_create", { id: { _serialized: id }, fromMe: true, from: "me", to: chatId, body: String(content), type: "chat", timestamp: Date.now() / 1000 });
    return { id: { _serialized: id } };
  }
  async sendSeen(chatId: string) {
    this.seen.push(chatId);
    return true;
  }
  async getContactLidAndPhone(ids: string[]) {
    return ids.map((lid) => ({ lid, pn: this.lidToPhone.get(lid) ?? "" }));
  }
}

const clients: FakeClient[] = [];
let client: FakeClient;
let businessId: string;
let inSeq = 0;
const OWNER = { name: "Owner" };

function incoming(from: string, body: string, name = "Kasun Perera"): WebMessage {
  return {
    id: { _serialized: `false_${from}_IN${++inSeq}` },
    from,
    to: "94770001111@c.us",
    fromMe: false,
    body,
    type: "chat",
    timestamp: Date.now() / 1000,
    _data: { notifyName: name },
  };
}

/** Sends a customer message and waits until the bot has replied. */
async function customerSays(from: string, body: string, name?: string) {
  const before = client.sent.length;
  client.emit("message", incoming(from, body, name));
  await vi.waitFor(() => expect(client.sent.length).toBeGreaterThan(before), { timeout: 5000 });
  return client.sent.at(-1)!;
}

beforeAll(async () => {
  setWebDriver({
    createClient: () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
    mediaFromFile: (p) => ({ file: p }),
    mediaFromUrl: async (u) => ({ url: u }),
  });
  setMockAIHandler(scriptedAI);
  const { business } = await registerBusiness({ businessName: "UrbanStyle", name: "Tharuka", email: "owner@web.test", password: "password123" });
  businessId = business.id;
  await loadSampleData(businessId, OWNER);
});

afterAll(async () => {
  setWebDriver(undefined);
  setMockAIHandler(undefined);
  await closeDb();
});

describe("linking a normal WhatsApp number by QR code", () => {
  it("shows a QR code, then connects when the phone scans it", async () => {
    await startLink(businessId, OWNER);
    client = clients.at(-1)!;
    expect(linkState(businessId).status).toBe("starting");

    client.emit("qr", "2@fake-qr-payload");
    await vi.waitFor(() => expect(linkState(businessId).status).toBe("qr"));
    expect(linkState(businessId).qr).toMatch(/^data:image\/png;base64,/);
    expect((await connectionView(businessId)).status).toBe("connecting");

    client.info = { wid: { user: "94770001111" }, pushname: "UrbanStyle Shop" };
    client.emit("authenticated");
    client.emit("ready");
    await vi.waitFor(async () => expect((await connectionView(businessId)).status).toBe("connected"));

    const view = await connectionView(businessId);
    expect(view.mode).toBe("qr");
    expect(view.connection?.displayPhoneNumber).toBe("+94770001111");
    expect(view.connection?.verifiedName).toBe("UrbanStyle Shop");
    expect(view.connection?.health.every((h) => h.ok)).toBe(true);
  });

  it("refuses the official API while a number is linked", async () => {
    await expect(
      connectManually(businessId, { accessToken: "EAAtesttoken0000000000000000", phoneNumberId: "123456", wabaId: "654321" }, OWNER),
    ).rejects.toThrow(/Unlink the linked WhatsApp/);
  });
});

describe("the assistant on a linked number", () => {
  const kasun = "94771234567@c.us";

  it("replies in the customer's chat and marks it read", async () => {
    const reply = await customerSays(kasun, "Hi");
    expect(reply.chatId).toBe(kasun);
    expect(reply.content).toContain("Welcome to UrbanStyle");
    expect(client.seen).toContain(kasun);
    const db = await getDb();
    const [customer] = await db.select().from(customers).where(and(eq(customers.businessId, businessId), eq(customers.waId, "94771234567")));
    expect(customer).toMatchObject({ phone: "+94771234567", waChatId: kasun, profileName: "Kasun Perera" });
  });

  it("sends options as numbered text and accepts '1' as the Confirm button", async () => {
    await customerSays(kasun, "I want 2 classic black t-shirts in large");
    await customerSays(kasun, "kasun perera, 12 galle road, colombo 05");
    const review = await customerSays(kasun, "Cash on delivery");
    expect(review.content).toContain("Total: Rs. 5,350");
    expect(review.content).toContain("1. Confirm Order");
    expect(review.content).toContain("3. Cancel");

    const placed = await customerSays(kasun, "1");
    expect(placed.content).toMatch(/Your order \*#ORD-10001\* has been placed/);
    const db = await getDb();
    const [order] = await db.select().from(orders).where(eq(orders.businessId, businessId));
    expect(order).toMatchObject({ status: "PENDING", total: 535000 });
  });

  it("updates customers even days later — no 24-hour window or templates", async () => {
    const db = await getDb();
    const [order] = await db.select().from(orders).where(eq(orders.businessId, businessId));
    await db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 3 * 86400000) }).where(eq(conversations.id, order.conversationId!));
    const before = client.sent.length;
    const result = await changeOrderStatus(businessId, order.id, "CONFIRMED", OWNER);
    expect(result.notification.notification).toBe("sent");
    expect(client.sent.length).toBe(before + 1);
    expect(client.sent.at(-1)!.content).toContain("has been confirmed");
    const history = await db.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, order.id));
    expect(history.at(-1)?.notification).toBe("sent");
  });

  it("tracks delivered and read ticks from WhatsApp acks", async () => {
    const last = client.sent.at(-1)!;
    client.emit("message_ack", { id: { _serialized: last.id } }, 2);
    client.emit("message_ack", { id: { _serialized: last.id } }, 3);
    const db = await getDb();
    await vi.waitFor(async () => {
      const [row] = await db.select().from(messages).where(eq(messages.waMessageId, last.id));
      expect(row.status).toBe("read");
    });
  });

  it("doesn't mistake its own messages for the owner typing", async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const db = await getDb();
    const agent = await db.select().from(messages).where(and(eq(messages.businessId, businessId), eq(messages.sender, "agent")));
    expect(agent).toHaveLength(0);
  });

  it("records replies the owner sends from the phone and pauses the AI for that chat", async () => {
    client.emit("message_create", {
      id: { _serialized: "true_owner_PHONE1" },
      fromMe: true,
      from: "94770001111@c.us",
      to: kasun,
      body: "Hi Kasun, I'll call you in 5 minutes",
      type: "chat",
      timestamp: Date.now() / 1000,
    });
    const db = await getDb();
    await vi.waitFor(async () => {
      const [row] = await db.select().from(messages).where(eq(messages.waMessageId, "true_owner_PHONE1"));
      expect(row).toMatchObject({ sender: "agent", direction: "outbound", status: "sent" });
    });
    const [customer] = await db.select().from(customers).where(and(eq(customers.businessId, businessId), eq(customers.waId, "94771234567")));
    const [conversation] = await db.select().from(conversations).where(eq(conversations.customerId, customer.id));
    expect(conversation.aiEnabled).toBe(false);

    const before = client.sent.length;
    client.emit("message", incoming(kasun, "ok thanks"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.sent.length).toBe(before); // human has taken over
  });

  it("ignores groups and status updates", async () => {
    const db = await getDb();
    const count = async () => (await db.select().from(messages).where(eq(messages.businessId, businessId))).length;
    const before = await count();
    client.emit("message", incoming("120363000000000000@g.us", "hello group"));
    client.emit("message", { ...incoming("status@broadcast", "my status"), isStatus: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await count()).toBe(before);
  });

  it("resolves hidden-number (@lid) contacts to their phone number and replies to the right chat", async () => {
    client.lidToPhone.set("201234567890123@lid", "94775556666@c.us");
    const reply = await customerSays("201234567890123@lid", "Do you have hoodies?", "Amaya");
    expect(reply.chatId).toBe("201234567890123@lid");
    const db = await getDb();
    const [customer] = await db.select().from(customers).where(and(eq(customers.businessId, businessId), eq(customers.waId, "94775556666")));
    expect(customer.waChatId).toBe("201234567890123@lid");
    expect(customer.phone).toBe("+94775556666");
  });
});

describe("disconnecting", () => {
  it("won't let another business link the same number", async () => {
    const { business: other } = await registerBusiness({ businessName: "Copycat", name: "Mallory", email: "mallory@web.test", password: "password123" });
    await startLink(other.id, OWNER);
    const copy = clients.at(-1)!;
    copy.info = { wid: { user: "94770001111" }, pushname: "Stolen" };
    copy.emit("ready");
    await vi.waitFor(async () => expect((await connectionView(other.id)).status).toBe("error"));
    expect((await connectionView(other.id)).connection?.lastError).toMatch(/already connected to another business/);
    expect(copy.loggedOut).toBe(true);
  });

  it("marks the connection when the phone removes the linked device", async () => {
    client.emit("disconnected", "LOGOUT");
    await vi.waitFor(async () => expect((await connectionView(businessId)).status).toBe("disconnected"));
    expect(client.destroyed).toBe(true);
  });

  it("unlinks cleanly from the dashboard", async () => {
    await startLink(businessId, OWNER);
    client = clients.at(-1)!;
    client.info = { wid: { user: "94770001111" }, pushname: "UrbanStyle Shop" };
    client.emit("ready");
    await vi.waitFor(async () => expect((await connectionView(businessId)).status).toBe("connected"));
    await disconnect(businessId, OWNER);
    expect(client.loggedOut).toBe(true);
    const db = await getDb();
    const [row] = await db.select().from(whatsappConnections).where(eq(whatsappConnections.businessId, businessId));
    expect(row).toMatchObject({ status: "disconnected", connectedVia: null });
    const recent = await db.select().from(messages).where(eq(messages.businessId, businessId)).orderBy(desc(messages.createdAt)).limit(1);
    expect(recent.length).toBe(1); // history is kept
  });
});
