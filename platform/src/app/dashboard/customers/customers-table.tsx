"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2, Search, Users } from "lucide-react";
import { EmptyState, NameAvatar, PageHeader } from "@/components/app/common";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoney, formatPhone, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Customer = {
  id: string;
  phone: string;
  profileName: string;
  displayName: string;
  totalOrders: number;
  totalSpent: number;
  firstInteractionAt: string;
  lastInteractionAt: string;
};

function href(pathname: string, query: string, page: number) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}

export function CustomersTable({
  customers,
  total,
  page,
  pageSize,
  query,
  currency,
}: {
  customers: Customer[];
  total: number;
  page: number;
  pageSize: number;
  query: string;
  currency: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = useState(query);
  const [pending, startTransition] = useTransition();
  const lastPushed = useRef(query);

  // Debounced URL update: the server component re-runs the search.
  useEffect(() => {
    const next = search.trim();
    if (next === lastPushed.current) return;
    const timer = setTimeout(() => {
      lastPushed.current = next;
      startTransition(() => router.replace(href(pathname, next, 1), { scroll: false }));
    }, 300);
    return () => clearTimeout(timer);
  }, [search, pathname, router]);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);

  return (
    <>
      <PageHeader title="Customers" description="Everyone who has messaged your WhatsApp number, with their orders and spend." />

      {total === 0 && !query ? (
        <EmptyState
          icon={Users}
          title="No customers yet"
          description="Customers appear here automatically the first time someone messages your WhatsApp number."
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-xs">
          <div className="flex items-center gap-2 border-b p-3">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or phone"
                className="pl-8"
                aria-label="Search customers"
              />
            </div>
            {pending ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Customer</TableHead>
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="text-right">Total spent</TableHead>
                <TableHead>Last interaction</TableHead>
                <TableHead className="hidden md:table-cell">First seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((customer) => {
                const name = customer.displayName || customer.profileName || (customer.phone ? formatPhone(customer.phone) : "Unknown customer");
                return (
                  <TableRow key={customer.id} className="cursor-pointer" onClick={() => router.push(`/dashboard/customers/${customer.id}`)}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-3">
                        <NameAvatar name={name} className="size-8" />
                        <div className="min-w-0">
                          <Link
                            href={`/dashboard/customers/${customer.id}`}
                            className="block truncate font-medium hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {name}
                          </Link>
                          <p className="truncate text-xs text-muted-foreground">{formatPhone(customer.phone)}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{customer.totalOrders}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(customer.totalSpent, currency)}</TableCell>
                    <TableCell className="text-muted-foreground" suppressHydrationWarning>
                      {relativeTime(customer.lastInteractionAt)}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell" suppressHydrationWarning>
                      {new Date(customer.firstInteractionAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!customers.length ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    {query ? <>No customers match “{query}”.</> : "No customers on this page."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          {total > 0 ? (
            <div className="flex flex-col gap-2 border-t px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <p className="tabular-nums">
                {from}–{to} of {total} customer{total === 1 ? "" : "s"}
              </p>
              {pages > 1 ? (
                <div className="flex items-center gap-2">
                  <PageLink disabled={page <= 1} href={href(pathname, query, page - 1)} label="Previous page">
                    <ChevronLeft className="size-4" /> Previous
                  </PageLink>
                  <span className="tabular-nums">
                    Page {page} of {pages}
                  </span>
                  <PageLink disabled={page >= pages} href={href(pathname, query, page + 1)} label="Next page">
                    Next <ChevronRight className="size-4" />
                  </PageLink>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

function PageLink({ href, disabled, label, children }: { href: string; disabled: boolean; label: string; children: React.ReactNode }) {
  const className = cn(buttonVariants({ variant: "outline", size: "sm" }), disabled && "pointer-events-none opacity-50");
  if (disabled) {
    return (
      <span aria-disabled className={className} aria-label={label}>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} className={className} aria-label={label} scroll={false}>
      {children}
    </Link>
  );
}
