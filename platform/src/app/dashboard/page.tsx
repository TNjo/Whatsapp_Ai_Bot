import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Banknote,
  BellRing,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Hand,
  Hourglass,
  MessageCircle,
  PackageCheck,
  ShoppingBag,
  Users,
} from "lucide-react";
import { EmptyState, NameAvatar, OrderStatusBadge, PageHeader, SectionCard, StatCard } from "@/components/app/common";
import { LiveRefresh } from "@/components/app/realtime";
import { QuickOrderActions } from "@/components/app/order-actions";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime, formatMoney, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { requirePageAuth } from "@/server/auth";
import { dashboardData } from "@/server/admin/dashboard";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const auth = await requirePageAuth();
  const data = await dashboardData(auth.business.id, auth.business.timezone);
  const money = (minor: number) => formatMoney(minor, auth.business.currency);
  const tz = auth.business.timezone;
  const firstName = auth.user.name.split(" ")[0];

  return (
    <>
      <LiveRefresh on={["order.created", "order.updated", "conversation.updated", "notification.created"]} />
      <PageHeader
        title={`Hi ${firstName} 👋`}
        description={`Here's what's happening with ${auth.business.name} on WhatsApp today.`}
        actions={
          <>
            <Link href="/dashboard/conversations" className={buttonVariants({ variant: "outline" })}>
              <MessageCircle className="size-4" /> Inbox
            </Link>
            <Link href="/dashboard/orders" className={buttonVariants()}>
              <ShoppingBag className="size-4" /> Orders
            </Link>
          </>
        }
      />

      {data.setup ? (
        <div className="mb-6 rounded-xl border border-primary/20 bg-primary/5 p-5">
          <p className="font-semibold">Finish setting up your WhatsApp assistant</p>
          <p className="text-sm text-muted-foreground">
            {data.setup.filter((s) => s.done).length} of {data.setup.length} done
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {data.setup.map((step) => (
              <Link
                key={step.key}
                href={step.href}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 text-sm transition-colors hover:border-primary/40",
                  step.done && "text-muted-foreground",
                )}
              >
                {step.done ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" /> : <Circle className="size-4 shrink-0 text-muted-foreground/50" />}
                <span className={cn("flex-1", step.done && "line-through")}>{step.label}</span>
                {!step.done ? <ArrowRight className="size-3.5 text-muted-foreground" /> : null}
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-7">
        <StatCard label="Today's orders" value={data.stats.todayOrders} icon={ShoppingBag} />
        <StatCard label="Pending" value={data.stats.pending} icon={Hourglass} tone={data.stats.pending ? "warning" : "default"} />
        <StatCard label="Confirmed" value={data.stats.confirmed} icon={ClipboardCheck} tone="info" hint="In progress" />
        <StatCard label="Completed" value={data.stats.completed} icon={PackageCheck} tone="success" />
        <StatCard label="Today's revenue" value={money(data.stats.todayRevenue)} icon={Banknote} tone="success" />
        <StatCard label="Customers" value={data.stats.customers.toLocaleString()} icon={Users} />
        <StatCard label="Active conversations" value={data.stats.activeConversations} icon={MessageCircle} hint="Last 24 hours" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6">
          <SectionCard
            title={
              <span className="flex items-center gap-2">
                Pending orders
                {data.stats.pending ? (
                  <span className="rounded-full bg-amber-500 px-2 text-xs font-semibold text-white tabular-nums">{data.stats.pending}</span>
                ) : null}
              </span>
            }
            description="Confirm or reject — the customer is notified on WhatsApp automatically."
            actions={
              <Link href="/dashboard/orders?status=PENDING" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                View all <ArrowRight className="size-3.5" />
              </Link>
            }
            bodyClassName="p-0"
          >
            {data.pending.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="You're all caught up" description="New WhatsApp orders will appear here the moment a customer confirms." className="m-5" />
            ) : (
              <ul className="divide-y">
                {data.pending.map((order) => (
                  <li key={order.id} className="relative flex flex-col gap-3 px-5 py-4 hover:bg-muted/40 sm:flex-row sm:items-center">
                    <Link href={`/dashboard/orders/${order.id}`} className="absolute inset-0" aria-label={`Open ${order.orderNumber}`} />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">#{order.orderNumber}</span>
                        <span className="text-sm text-muted-foreground">{order.displayName}</span>
                      </p>
                      <p className="truncate text-sm text-muted-foreground">{order.items.map((i) => `${i.name} × ${i.quantity}`).join(", ")}</p>
                      <p className="text-xs text-muted-foreground">Received {formatDateTime(order.createdAt, tz)}</p>
                    </div>
                    <div className="flex items-center justify-between gap-4 sm:justify-end">
                      <span className="font-semibold tabular-nums">{money(order.total)}</span>
                      <div className="relative z-10">
                        <QuickOrderActions orderId={order.id} orderNumber={order.orderNumber} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Recent orders"
            actions={
              <Link href="/dashboard/orders?status=ALL" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                All orders <ArrowRight className="size-3.5" />
              </Link>
            }
            bodyClassName="p-0"
          >
            {data.recent.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted-foreground">No orders yet.</p>
            ) : (
              <ul className="divide-y">
                {data.recent.map((order) => (
                  <li key={order.id}>
                    <Link href={`/dashboard/orders/${order.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-muted/40">
                      <NameAvatar name={order.displayName} className="size-8" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">#{order.orderNumber}</span>
                        <span className="block truncate text-xs text-muted-foreground">{order.displayName}</span>
                      </span>
                      <span className="text-sm font-medium tabular-nums">{money(order.total)}</span>
                      <OrderStatusBadge status={order.status} className="hidden sm:inline-flex" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        <div className="flex flex-col gap-6">
          <SectionCard title="Needs a human" description="Conversations the assistant handed to your team." bodyClassName="p-0">
            {data.handoffs.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-muted-foreground">Nobody is waiting. 🎉</p>
            ) : (
              <ul className="divide-y">
                {data.handoffs.map((h) => (
                  <li key={h.id}>
                    <Link href={`/dashboard/conversations?c=${h.id}`} className="flex gap-3 px-5 py-3 hover:bg-muted/40">
                      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300">
                        <Hand className="size-4" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{h.displayName}</span>
                        <span className="line-clamp-2 block text-xs text-muted-foreground">{h.reason}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Notifications" bodyClassName="p-0">
            {data.notifications.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-muted-foreground">Nothing new.</p>
            ) : (
              <ul className="divide-y">
                {data.notifications.map((n) => (
                  <li key={n.id}>
                    <Link href={n.link ?? "#"} className="flex gap-3 px-5 py-3 hover:bg-muted/40">
                      <BellRing className={cn("mt-0.5 size-4 shrink-0", n.readAt ? "text-muted-foreground" : "text-primary")} />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{n.title}</span>
                        {n.body ? <span className="line-clamp-1 block text-xs text-muted-foreground">{n.body}</span> : null}
                        <span className="block text-[11px] text-muted-foreground">{relativeTime(n.createdAt)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>
    </>
  );
}
