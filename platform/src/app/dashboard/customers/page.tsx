import type { Metadata } from "next";
import { requirePageAuth } from "@/server/auth";
import { listCustomers } from "@/server/admin/customers";
import { CustomersTable } from "./customers-table";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage(props: PageProps<"/dashboard/customers">) {
  const auth = await requirePageAuth();
  const searchParams = await props.searchParams;
  const query = typeof searchParams.q === "string" ? searchParams.q : "";
  const page = Math.max(1, Number(searchParams.page) || 1);
  const result = await listCustomers(auth.business.id, { query, page });
  return (
    <CustomersTable
      currency={auth.business.currency}
      query={query}
      page={result.page}
      pageSize={result.pageSize}
      total={result.total}
      customers={result.customers.map((c) => ({
        ...c,
        firstInteractionAt: c.firstInteractionAt.toISOString(),
        lastInteractionAt: c.lastInteractionAt.toISOString(),
      }))}
    />
  );
}
