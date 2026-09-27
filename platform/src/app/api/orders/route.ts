import { requireApiAuth } from "@/server/auth";
import { listOrders, statusCounts, type OrderFilter } from "@/server/admin/orders";
import { json, pagination, route } from "@/server/http";
import { ORDER_STATUSES } from "@/lib/order-status";

export const GET = route("orders.list", async (request) => {
  const auth = await requireApiAuth(request);
  const url = new URL(request.url);
  const { page, limit } = pagination(url);
  const raw = url.searchParams.get("status")?.toUpperCase();
  const status = raw && (ORDER_STATUSES as readonly string[]).concat(["ALL", "OPEN"]).includes(raw) ? (raw as OrderFilter["status"]) : "ALL";
  const includeTest = url.searchParams.get("test") === "1";
  const [result, counts] = await Promise.all([
    listOrders(auth.business.id, { status, q: url.searchParams.get("q") ?? "", page, limit, includeTest }),
    statusCounts(auth.business.id, includeTest),
  ]);
  return json({ ...result, counts });
});
