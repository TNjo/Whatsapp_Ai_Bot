import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { categories } from "@/db/schema";

export async function listCategories(businessId: string, kind: "product" | "service") {
  const db = await getDb();
  return db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.businessId, businessId), eq(categories.kind, kind)))
    .orderBy(asc(categories.name));
}

/** Finds a category by name for this business, creating it when new. Empty name → no category. */
export async function resolveCategory(
  businessId: string,
  kind: "product" | "service",
  name: string | null | undefined,
): Promise<string | null> {
  const clean = name?.trim();
  if (!clean) return null;
  const db = await getDb();
  const [existing] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.businessId, businessId), eq(categories.kind, kind), eq(categories.name, clean)));
  if (existing) return existing.id;
  const [created] = await db.insert(categories).values({ businessId, kind, name: clean }).onConflictDoNothing().returning({ id: categories.id });
  return created?.id ?? (await resolveCategory(businessId, kind, clean));
}
