import type { Metadata } from "next";
import Link from "next/link";
import { ShoppingBag } from "lucide-react";
import { EmptyState, NameAvatar, OrderStatusBadge, PageHeader } from "@/components/app/common";
import { LiveRefresh } from "@/components/app/realtime";
import { QuickOrderActions } from "@/components/app/order-actions";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime, formatMoney } from "@/lib/format";
import { ORDER_STATUSES, STATUS_LABEL, type OrderStatus } from "@/lib/order-status";
import { cn } from "@/lib/utils";
import { requirePageAuth } from "@/server/auth";
import { listOrders, statusCounts, type OrderFilter } from "@/server/admin/orders";
import { OrdersToolbar } from "./orders-toolbar";

export const metadata: Metadata = { title: "Orders" };

const TABS: { key: OrderFilter["status"]; label: string }[] = [
  { key: "PENDING", label: "Pending" },
  { key: "OPEN", label: "In progress" },
  { key: "COMPLETED", label: "Completed" },
  { key: "ALL", label: "All" },
];

export default async function OrdersPage(props: PageProps<"/dashboard/orders">) {
  const auth = await requirePageAuth();
  const params = await props.searchParams;
  const one = (key: string) => (Array.isArray(params[key]) ? params[key]![0] : (params[key] as string | undefined));
  const rawStatus = one("status")?.toUpperCase();
  const status = (rawStatus && ([...ORDER_STATUSES, "ALL", "OPEN"] as string[]).includes(rawStatus) ? rawStatus : "PENDING") as OrderFilter["status"];
  const q = one("q") ?? "";
  const page = Math.max(1, Number(one("page")) || 1);
  const includeTest = one("test") === "1";

  const [result, counts] = await Promise.all([
    listOrders(auth.business.id, { status, q, page, includeTest }),
    statusCounts(auth.business.id, includeTest),
  ]);
  const openCount = counts.CONFIRMED + counts.PROCESSING + counts.READY + counts.DISPATCHED;
  const tabCount = (key: OrderFilter["status"]) =>
    key === "PENDING" ? counts.PENDING : key === "OPEN" ? openCount : key === "COMPLETED" ? counts.COMPLETED : Object.values(counts).reduce((a, b) => a + b, 0);

  const href = (next: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams();
    const merged = { status, q, test: includeTest ? "1" : undefined, ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined || value === "" || (key === "page" && Number(value) === 1)) continue;
      sp.set(key, String(value));
    }
    return `/dashboard/orders?${sp.toString()}`;
  };
  const pages = Math.max(1, Math.ceil(result.total / result.limit));

  return (
    <>
      <LiveRefresh on={["order.created", "order.updated"]} />
      <PageHeader title="Orders" description="Orders placed through WhatsApp. New orders stay pending until you confirm them." />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <nav className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1">
          {TABS.map((tab) => {
            const active = status === tab.key;
            const n = tabCount(tab.key);
            return (
              <Link
                key={tab.key}
                href={href({ status: tab.key, page: undefined })}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
                  active && "bg-background text-foreground shadow-sm",
                )}
              >
                {tab.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 text-xs tabular-nums",
                    tab.key === "PENDING" && n > 0 ? "bg-amber-500 text-white" : "bg-muted-foreground/15",
                  )}
                >
                  {n}
                </span>
              </Link>
            );
          })}
          {!TABS.some((t) => t.key === status) ? (
            <span className="rounded-md bg-background px-3 py-1.5 text-sm font-medium shadow-sm">{STATUS_LABEL[status as OrderStatus]}</span>
          ) : null}
        </nav>
        <OrdersToolbar q={q} status={status ?? "PENDING"} includeTest={includeTest} />
      </div>

      {result.orders.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title={status === "PENDING" ? "No pending orders" : "No orders here"}
          description={
            q
              ? `Nothing matches “${q}”.`
              : "When a customer confirms an order on WhatsApp it appears here instantly. Try it from Bot → Test bot."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <div className="divide-y">
            {result.orders.map((order) => {
              const name = order.customerName || order.customer.displayName || order.customer.profileName || order.customer.phone;
              const itemsText = order.items.map((i) => `${i.name} × ${i.quantity}`).join(", ");
              return (
                <div key={order.id} className="group relative flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-muted/40 sm:flex-row sm:items-center">
                  <Link href={`/dashboard/orders/${order.id}`} className="absolute inset-0" aria-label={`Open ${order.orderNumber}`} />
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <NameAvatar name={name} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">#{order.orderNumber}</span>
                        <OrderStatusBadge status={order.status} />
                        {order.isTest ? <span className="rounded bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">TEST</span> : null}
                      </div>
                      <p className="truncate text-sm text-muted-foreground">
                        {name} · {itemsText || "No items"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4 sm:justify-end">
                    <div className="text-right">
                      <p className="font-semibold tabular-nums">{formatMoney(order.total, order.currency)}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(order.createdAt, auth.business.timezone)}</p>
                    </div>
                    {order.status === "PENDING" ? (
                      <div className="relative z-10">
                        <QuickOrderActions orderId={order.id} orderNumber={order.orderNumber} />
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          {pages > 1 ? (
            <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
              <span>
                Page {page} of {pages} · {result.total} orders
              </span>
              <div className="flex gap-2">
                <Link aria-disabled={page <= 1} className={cn(buttonVariants({ variant: "outline", size: "sm" }), page <= 1 && "pointer-events-none opacity-50")} href={href({ page: page - 1 })}>
                  Previous
                </Link>
                <Link aria-disabled={page >= pages} className={cn(buttonVariants({ variant: "outline", size: "sm" }), page >= pages && "pointer-events-none opacity-50")} href={href({ page: page + 1 })}>
                  Next
                </Link>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
