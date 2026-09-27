export const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "PROCESSING",
  "READY",
  "DISPATCHED",
  "DELIVERED",
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  PROCESSING: "Processing",
  READY: "Ready",
  DISPATCHED: "Dispatched",
  DELIVERED: "Delivered",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected",
};

/** Default status machine (spec §25). Terminal: COMPLETED, CANCELLED, REJECTED. */
export const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ["CONFIRMED", "REJECTED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "READY", "DISPATCHED", "CANCELLED"],
  PROCESSING: ["READY", "DISPATCHED", "CANCELLED"],
  READY: ["DISPATCHED", "DELIVERED", "COMPLETED", "CANCELLED"],
  DISPATCHED: ["DELIVERED", "CANCELLED"],
  DELIVERED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: [],
};

/** Statuses that count as revenue / customer spend. */
export const REVENUE_STATUSES: OrderStatus[] = ["CONFIRMED", "PROCESSING", "READY", "DISPATCHED", "DELIVERED", "COMPLETED"];
export const OPEN_STATUSES: OrderStatus[] = ["PENDING", "CONFIRMED", "PROCESSING", "READY", "DISPATCHED"];
export const STOCK_RELEASING: OrderStatus[] = ["CANCELLED", "REJECTED"];

export const STATUS_EMOJI: Partial<Record<OrderStatus, string>> = {
  PENDING: "🕒",
  CONFIRMED: "✅",
  PROCESSING: "👩‍🍳",
  READY: "📦",
  DISPATCHED: "🚚",
  DELIVERED: "🏠",
  COMPLETED: "🎉",
  CANCELLED: "✖️",
  REJECTED: "✖️",
};
