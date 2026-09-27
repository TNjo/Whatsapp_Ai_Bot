import type { Metadata } from "next";
import { requirePageAuth } from "@/server/auth";
import { listCategories } from "@/server/admin/categories";
import { listServices } from "@/server/admin/services";
import { ServicesManager } from "./services-manager";

export const metadata: Metadata = { title: "Services" };

export default async function ServicesPage() {
  const auth = await requirePageAuth();
  const [services, categories] = await Promise.all([listServices(auth.business.id), listCategories(auth.business.id, "service")]);
  return (
    <ServicesManager
      currency={auth.business.currency}
      initial={services.map((s) => ({ ...s, updatedAt: s.updatedAt.toISOString() }))}
      categories={categories.map((c) => c.name)}
    />
  );
}
