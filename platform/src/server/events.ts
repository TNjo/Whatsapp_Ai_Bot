import "server-only";
import { EventEmitter } from "node:events";

/**
 * Real-time events pushed to the dashboard over Server-Sent Events.
 * In-process bus: one Node server instance. Swap for Firestore listeners, Pub/Sub
 * or Redis pub/sub when running several instances.
 */
export type RealtimeEvent =
  | { type: "message.created"; conversationId: string; messageId: string; direction: "inbound" | "outbound" }
  | { type: "message.status"; conversationId: string; messageId: string; status: string }
  | { type: "conversation.updated"; conversationId: string }
  | { type: "order.created"; orderId: string; orderNumber: string; total: number; currency: string; isTest: boolean }
  | { type: "order.updated"; orderId: string; orderNumber: string; status: string }
  | { type: "notification.created"; notificationId: string; title: string; body: string; link: string | null; kind: string }
  | { type: "whatsapp.updated" };

const globalRef = globalThis as unknown as { __wabBus?: EventEmitter };
const bus = (globalRef.__wabBus ??= new EventEmitter().setMaxListeners(1000));

export function publish(businessId: string, event: RealtimeEvent) {
  bus.emit(`business:${businessId}`, event);
}

export function subscribe(businessId: string, listener: (event: RealtimeEvent) => void): () => void {
  const channel = `business:${businessId}`;
  bus.on(channel, listener);
  return () => bus.off(channel, listener);
}
