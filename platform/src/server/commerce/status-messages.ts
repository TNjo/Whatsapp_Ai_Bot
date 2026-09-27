import type { StatusMessageKey } from "@/db/schema";
import type { OrderStatus } from "@/lib/order-status";

/** Default customer notifications (spec §26–27). Editable per business under WhatsApp → Messages. */
export const DEFAULT_STATUS_MESSAGES: Record<StatusMessageKey, string> = {
  order_confirmed:
    "Hi {{customer_name}} 👋\n\nGood news! Your order #{{order_id}} has been confirmed.\n\nTotal: {{total}}\n\nWe'll keep you updated about your order.\n\nThank you for ordering with us!",
  order_processing: "Your order #{{order_id}} is now being prepared.",
  order_ready: "Your order #{{order_id}} is ready.",
  order_dispatched: "Your order #{{order_id}} has been dispatched. 🚚\n\nTracking:\n{{tracking}}",
  order_delivered: "Your order #{{order_id}} has been delivered.",
  order_completed: "Your order #{{order_id}} has been completed.\n\nThank you for choosing us! ❤️",
  order_rejected: "We're sorry, but we couldn't process order #{{order_id}}.\n\nPlease contact us if you need assistance.",
  order_cancelled: "Your order #{{order_id}} has been cancelled.\n\nPlease contact us if you have any questions.",
};

export const STATUS_MESSAGE_LABELS: Record<StatusMessageKey, string> = {
  order_confirmed: "Order confirmed",
  order_processing: "Processing",
  order_ready: "Ready",
  order_dispatched: "Dispatched",
  order_delivered: "Delivered",
  order_completed: "Completed",
  order_rejected: "Rejected",
  order_cancelled: "Cancelled",
};

export function statusMessageKey(status: OrderStatus): StatusMessageKey | null {
  const key = `order_${status.toLowerCase()}` as StatusMessageKey;
  return key in DEFAULT_STATUS_MESSAGES ? key : null;
}

export type MessageVars = {
  customer_name: string;
  order_id: string;
  total: string;
  tracking: string;
  business_name: string;
  status: string;
};

/** Fills {{variables}}. Lines whose only variable is empty (e.g. no tracking number) are dropped. */
export function renderMessage(template: string, vars: MessageVars): string {
  const lines = template.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const names = [...line.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1] as keyof MessageVars);
    if (names.length && names.every((name) => !vars[name])) {
      // Also drop a preceding "Label:" line that only introduced this value.
      if (out.length && /:\s*$/.test(out[out.length - 1])) out.pop();
      continue;
    }
    out.push(line.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: keyof MessageVars) => vars[name] ?? ""));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/Hi\s+👋/, "Hi 👋")
    .trim();
}
