import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Ban, CalendarClock, CheckCircle2, ChevronLeft, Clock, MessageCircle, ShoppingBag, Wallet } from "lucide-react";
import { EmptyState, NameAvatar, OrderStatusBadge, PageHeader, SectionCard, StatCard } from "@/components/app/common";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatMoney, formatPhone, relativeTime } from "@/lib/format";
import { requirePageAuth } from "@/server/auth";
import { getCustomer } from "@/server/admin/customers";
import { CustomerDetailsCard, CustomerNotesCard } from "./customer-editor";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage(props: PageProps<"/dashboard/customers/[id]">) {
  const auth = await requirePageAuth();
  const { id } = await props.params;
  const detail = await getCustomer(auth.business.id, id);
  if (!detail) notFound();

  const { customer, stats, orders, conversationId } = detail;
  const currency = auth.business.currency;
  const timeZone = auth.business.timezone;
  const name = customer.displayName || customer.profileName || (customer.phone ? formatPhone(customer.phone) : "Unknown customer");
  const showProfileName = customer.displayName && customer.profileName && customer.profileName !== customer.displayName;

  return (
    <>
      <Link
        href="/dashboard/customers"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-4" /> Customers
      </Link>

      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <NameAvatar name={name} className="size-11 text-sm" />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="truncate">{name}</span>
                {customer.isTest ? <Badge variant="secondary">Test</Badge> : null}
              </span>
              <span className="block text-sm font-normal tracking-normal text-muted-foreground">
                {customer.phone ? <>WhatsApp {formatPhone(customer.phone)}</> : "Test chat — no WhatsApp number"}
                {showProfileName ? <> · Profile name “{customer.profileName}”</> : null}
              </span>
            </span>
          </span>
        }
        actions={
          conversationId ? (
            <Link href={`/dashboard/conversations?c=${conversationId}`} className={buttonVariants()}>
              <MessageCircle className="size-4" /> Open conversation
            </Link>
          ) : null
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Total orders" value={stats.totalOrders} icon={ShoppingBag} />
        <StatCard label="Completed" value={stats.completed} icon={CheckCircle2} tone="success" />
        <StatCard label="Pending" value={stats.pending} icon={Clock} tone="warning" />
        <StatCard label="Cancelled" value={stats.cancelled} icon={Ban} hint="Cancelled or rejected" />
        <StatCard label="Total spent" value={formatMoney(stats.totalSpent, currency)} icon={Wallet} tone="info" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <SectionCard title="Order history" description={`${orders.length} order${orders.length === 1 ? "" : "s"}`} bodyClassName="p-0">
            {orders.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Order</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="pr-5">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orders.map((order) => (
                    <TableRow key={order.id}>
                      <TableCell className="pl-5">
                        <Link href={`/dashboard/orders/${order.id}`} className="font-medium hover:underline">
                          #{order.orderNumber}
                        </Link>
                        {order.isTest ? (
                          <Badge variant="secondary" className="ml-2">
                            Test
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(order.createdAt, timeZone)}</TableCell>
                      <TableCell className="text-right tabular-nums">{order.items}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(order.total, order.currency)}</TableCell>
                      <TableCell className="pr-5">
                        <OrderStatusBadge status={order.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                icon={ShoppingBag}
                title="No orders yet"
                description="Orders this customer places through WhatsApp will show up here."
                className="m-5"
              />
            )}
          </SectionCard>
        </div>

        <div className="grid content-start gap-6">
          <CustomerDetailsCard
            customerId={customer.id}
            initial={{ displayName: customer.displayName, email: customer.email, address: customer.address, city: customer.city }}
            profileName={customer.profileName}
          />
          <CustomerNotesCard customerId={customer.id} initial={customer.notes} />
          <SectionCard title="Timeline">
            <dl className="grid gap-3 text-sm">
              <div className="flex items-start gap-3">
                <CalendarClock className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <dt className="text-muted-foreground">First interaction</dt>
                  <dd className="font-medium">{formatDateTime(customer.firstInteractionAt, timeZone)}</dd>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MessageCircle className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <dt className="text-muted-foreground">Last interaction</dt>
                  <dd className="font-medium">
                    {formatDateTime(customer.lastInteractionAt, timeZone)}{" "}
                    <span className="font-normal text-muted-foreground">({relativeTime(customer.lastInteractionAt)})</span>
                  </dd>
                </div>
              </div>
            </dl>
          </SectionCard>
        </div>
      </div>
    </>
  );
}
