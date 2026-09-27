"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { formatMoney } from "@/lib/format";

/** Mirrors server/events.ts RealtimeEvent. */
export type RealtimeEvent =
  | { type: "message.created"; conversationId: string; messageId: string; direction: "inbound" | "outbound" }
  | { type: "message.status"; conversationId: string; messageId: string; status: string }
  | { type: "conversation.updated"; conversationId: string }
  | { type: "order.created"; orderId: string; orderNumber: string; total: number; currency: string; isTest: boolean }
  | { type: "order.updated"; orderId: string; orderNumber: string; status: string }
  | { type: "notification.created"; notificationId: string; title: string; body: string; link: string | null; kind: string }
  | { type: "whatsapp.updated" };

type Listener = (event: RealtimeEvent) => void;

const RealtimeContext = createContext<{ subscribe: (listener: Listener) => () => void; connected: boolean }>({
  subscribe: () => () => {},
  connected: false,
});

/** One EventSource per tab, shared by every component that listens. */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event.type === "order.created" && !event.isTest) {
        toast(`🔔 New order ${event.orderNumber}`, {
          description: formatMoney(event.total, event.currency),
          action: { label: "View order", onClick: () => router.push(`/dashboard/orders/${event.orderId}`) },
          duration: 12_000,
        });
      }
      if (event.type === "notification.created" && ["human_support", "message_failed", "low_stock"].includes(event.kind)) {
        const show = event.kind === "low_stock" ? toast.warning : toast.error;
        show(event.title, {
          description: event.body,
          action: event.link ? { label: "Open", onClick: () => router.push(event.link!) } : undefined,
        });
      }
      for (const listener of listeners.current) listener(event);
    };
    return () => source.close();
  }, [router]);

  const subscribe = (listener: Listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  };

  return <RealtimeContext.Provider value={{ subscribe, connected }}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(listener: Listener) {
  const { subscribe } = useContext(RealtimeContext);
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  });
  useEffect(() => subscribe((event) => ref.current(event)), [subscribe]);
}

export function useRealtimeConnected() {
  return useContext(RealtimeContext).connected;
}

/** Re-renders the current server page (debounced) when matching events arrive. */
export function useRefreshOn(types: RealtimeEvent["type"][]) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = types.join(",");
  useRealtime((event) => {
    if (!key.split(",").includes(event.type)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => router.refresh(), 400);
  });
}

/** Drop-in component for server pages: <LiveRefresh on={["order.created"]} /> */
export function LiveRefresh({ on }: { on: RealtimeEvent["type"][] }) {
  useRefreshOn(on);
  return null;
}
