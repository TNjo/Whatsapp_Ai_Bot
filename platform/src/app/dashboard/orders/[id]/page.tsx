import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Bell, BellOff, CircleAlert, FileText, MapPin, MessageCircle, Phone, User, Wallet } from "lucide-react";
import { NameAvatar, OrderStatusBadge, SectionCard } from "@/components/app/common";
import { LiveRefresh } from "@/components/app/realtime";
import { QuickOrderActions, StatusChangeDialog } from "@/components/app/order-actions";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime, formatMoney, formatPhone } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/order-status";
import { cn } from "@/lib/utils";
import { getAuth, requirePageAuth } from "@/server/auth";
import { orderDetail } from "@/server/admin/orders";
import { ApiError } from "@/server/http";
import { OrderNotes } from "./order-notes";

export async function generateMetadata(props: PageProps<"/dashboard/orders/[id]">): Promise<Metadata> {
  const auth = await getAuth();
  const { id } = await props.params;
  const order = auth ? await orderDetail(auth.business.id, id).catch(() => null) : null;
  return { title: order ? `Order #${order.order.orderNumber}` : "Order" };
}

const NOTIFY_LABEL = {
  sent: { text: "Customer notified", icon: Bell, className: "text-emerald-600 dark:text-emerald-400" },
  template: { text: "Notified via template", icon: Bell, className: "text-emerald-600 dark:text-emerald-400" },
  failed: { text: "Customer not notified", icon: CircleAlert, className: "text-rose-600 dark:text-rose-400" },
  skipped: { text: "", icon: BellOff, className: "text-muted-foreground" },
} as const;

export default async function OrderPage(props: PageProps<"/dashboard/orders/[id]">) {
  const auth = await requirePageAuth();
  const { id } = await props.params;
  let data: Awaited<ReturnType<typeof orderDetail>>;
  try {
    data = await orderDetail(auth.business.id, id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const { order, customer, items, customFields, history, otherOrders, conversation, recentMessages } = data;
  const tz = auth.business.timezone;
  const money = (minor: number) => formatMoney(minor, order.currency);
  const customerName = order.customerName || customer.displayName || customer.profileName || "Customer";

  return (
    <>
      <LiveRefresh on={["order.updated", "message.created"]} />
      <Link href="/dashboard/orders" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Orders
      </Link>

      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Order #{order.orderNumber}</h1>
            <OrderStatusBadge status={order.status} className="text-sm" />
            {order.isTest ? <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Test order</span> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Received {formatDateTime(order.createdAt, tz)} · {money(order.total)}
          </p>
        </div>
        {order.status === "PENDING" ? (
          <QuickOrderActions orderId={order.id} orderNumber={order.orderNumber} size="default" />
        ) : (
          <StatusChangeDialog orderId={order.id} orderNumber={order.orderNumber} current={order.status} trackingNumber={order.trackingNumber} />
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          <SectionCard title="Products" bodyClassName="p-0">
            <ul className="divide-y">
              {items.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="font-medium">{item.name}</p>
                    {Object.keys(item.optionValues).length ? (
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {Object.entries(item.optionValues)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" · ")}
                      </p>
                    ) : null}
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      Qty {item.quantity} × {money(item.unitPrice)}
                    </p>
                  </div>
                  <p className="font-medium tabular-nums">{money(item.lineTotal)}</p>
                </li>
              ))}
            </ul>
            <dl className="grid gap-1.5 border-t bg-muted/30 px-5 py-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Items</dt>
                <dd className="tabular-nums">{money(order.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Delivery</dt>
                <dd className="tabular-nums">{money(order.deliveryFee)}</dd>
              </div>
              {order.discount ? (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Discount</dt>
                  <dd className="tabular-nums">−{money(order.discount)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t pt-2 text-base font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums">{money(order.total)}</dd>
              </div>
            </dl>
          </SectionCard>

          <SectionCard title="Delivery & payment">
            <div className="grid gap-5 sm:grid-cols-2">
              <Info icon={MapPin} label="Delivery">
                {[order.deliveryAddress, order.city].filter(Boolean).join(", ") || "—"}
              </Info>
              <Info icon={Wallet} label="Payment">
                {order.paymentMethod || "—"}
              </Info>
              {order.trackingNumber ? (
                <Info icon={FileText} label="Tracking">
                  {order.trackingNumber}
                </Info>
              ) : null}
              {customFields.map((field) => (
                <Info key={field.key} icon={FileText} label={field.label}>
                  {field.value}
                </Info>
              ))}
            </div>
            {order.customerNote ? (
              <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
                <p className="mb-0.5 text-xs font-semibold text-amber-800 uppercase dark:text-amber-300">Customer notes</p>
                {order.customerNote}
              </div>
            ) : null}
          </SectionCard>

          <SectionCard title="Status history" description="Every change, who made it, and whether the customer was notified.">
            <ol className="relative flex flex-col gap-5 border-l pl-5">
              {history.map((entry) => {
                const notify = NOTIFY_LABEL[entry.notification];
                return (
                  <li key={entry.id} className="relative">
                    <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-background bg-primary" />
                    <p className="text-sm font-medium">
                      {entry.fromStatus ? `${STATUS_LABEL[entry.fromStatus]} → ${STATUS_LABEL[entry.toStatus]}` : "Order created"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(entry.createdAt, tz)} · {entry.changedBy}
                    </p>
                    {entry.note ? <p className="mt-1 text-sm text-muted-foreground">{entry.note}</p> : null}
                    {notify.text ? (
                      <p className={cn("mt-1 inline-flex items-center gap-1 text-xs font-medium", notify.className)}>
                        <notify.icon className="size-3.5" /> {notify.text}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </SectionCard>

          {conversation ? (
            <SectionCard
              title="Conversation"
              description="Latest messages with this customer."
              actions={
                <Link href={`/dashboard/conversations?c=${conversation.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  <MessageCircle className="size-4" /> Open chat
                </Link>
              }
              bodyClassName="chat-wallpaper flex max-h-96 flex-col gap-2 overflow-y-auto p-4"
            >
              {recentMessages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "max-w-[80%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap shadow-xs",
                    message.direction === "inbound"
                      ? "self-start rounded-tl-sm bg-card"
                      : message.sender === "ai"
                        ? "self-end rounded-tr-sm bg-indigo-50 text-indigo-950 dark:bg-indigo-500/20 dark:text-indigo-50"
                        : "self-end rounded-tr-sm bg-emerald-100 text-emerald-950 dark:bg-emerald-900/60 dark:text-emerald-50",
                  )}
                >
                  {message.content || `[${message.type}]`}
                </div>
              ))}
            </SectionCard>
          ) : null}
        </div>

        <aside className="flex flex-col gap-6">
          <SectionCard title="Customer">
            <div className="flex items-center gap-3">
              <NameAvatar name={customerName} className="size-11 text-sm" />
              <div className="min-w-0">
                <p className="truncate font-medium">{customerName}</p>
                {customer.profileName && customer.profileName !== customerName ? (
                  <p className="truncate text-xs text-muted-foreground">WhatsApp: {customer.profileName}</p>
                ) : null}
              </div>
            </div>
            <div className="mt-4 grid gap-2 text-sm">
              <p className="flex items-center gap-2">
                <Phone className="size-4 text-muted-foreground" /> {order.customerPhone ? formatPhone(order.customerPhone) : customer.phone || "—"}
              </p>
              <p className="flex items-center gap-2">
                <User className="size-4 text-muted-foreground" /> {customer.totalOrders} order{customer.totalOrders === 1 ? "" : "s"} · {money(customer.totalSpent)} spent
              </p>
            </div>
            <Link href={`/dashboard/customers/${customer.id}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-4 w-full")}>
              View customer
            </Link>
          </SectionCard>

          <OrderNotes orderId={order.id} internalNotes={order.internalNotes} trackingNumber={order.trackingNumber} />

          {otherOrders.length > 1 ? (
            <SectionCard title="Order history" bodyClassName="p-0">
              <ul className="divide-y">
                {otherOrders.map((other) => (
                  <li key={other.id}>
                    <Link
                      href={`/dashboard/orders/${other.id}`}
                      className={cn("flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-muted/50", other.id === order.id && "bg-muted/60")}
                    >
                      <span>
                        <span className="font-medium">#{other.orderNumber}</span>
                        <span className="block text-xs text-muted-foreground">{formatDateTime(other.createdAt, tz)}</span>
                      </span>
                      <OrderStatusBadge status={other.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </aside>
      </div>
    </>
  );
}

function Info({ icon: Icon, label, children }: { icon: typeof MapPin; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="text-sm whitespace-pre-wrap">{children}</p>
      </div>
    </div>
  );
}
