import "server-only";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { categories, services } from "@/db/schema";
import { audit, type AuditActor } from "../audit";
import { cleanText, notFound } from "../http";
import { resolveCategory } from "./categories";

/** Prices arrive in major units from forms ("1500") and are stored in minor units. */
const money = z.coerce.number().min(0).max(100_000_000).transform((v) => Math.round(v * 100));

export const ServiceInput = z.object({
  name: cleanText(120).pipe(z.string().min(1, "Name is required")),
  description: cleanText(2000).default(""),
  category: cleanText(60).optional(),
  price: money,
  durationMinutes: z.coerce.number().int().min(0).max(24 * 60).nullable().optional(),
  availability: cleanText(200).default(""),
  status: z.enum(["active", "disabled"]).default("active"),
});

export async function listServices(businessId: string, query = "") {
  const db = await getDb();
  const q = query.trim();
  return db
    .select({
      id: services.id,
      name: services.name,
      description: services.description,
      price: services.price,
      durationMinutes: services.durationMinutes,
      availability: services.availability,
      status: services.status,
      category: categories.name,
      updatedAt: services.updatedAt,
    })
    .from(services)
    .leftJoin(categories, eq(categories.id, services.categoryId))
    .where(and(eq(services.businessId, businessId), q ? or(ilike(services.name, `%${q}%`), ilike(services.description, `%${q}%`)) : undefined))
    .orderBy(asc(services.name));
}

export type ServiceRow = Awaited<ReturnType<typeof listServices>>[number];

export async function createService(businessId: string, input: z.infer<typeof ServiceInput>, actor: AuditActor) {
  const db = await getDb();
  const categoryId = await resolveCategory(businessId, "service", input.category);
  const [row] = await db
    .insert(services)
    .values({ businessId, categoryId, ...input, durationMinutes: input.durationMinutes ?? null })
    .returning();
  await audit(businessId, actor, "service.created", { type: "service", id: row.id }, { name: row.name });
  return row;
}

export async function updateService(businessId: string, id: string, input: Partial<z.infer<typeof ServiceInput>>, actor: AuditActor) {
  const db = await getDb();
  const { category, ...rest } = input;
  const set: Partial<typeof services.$inferInsert> = { ...rest };
  if (category !== undefined) set.categoryId = await resolveCategory(businessId, "service", category);
  const [row] = await db
    .update(services)
    .set(set)
    .where(and(eq(services.id, id), eq(services.businessId, businessId)))
    .returning();
  if (!row) throw notFound("Service not found");
  await audit(businessId, actor, "service.updated", { type: "service", id }, { fields: Object.keys(input) });
  return row;
}

export async function deleteService(businessId: string, id: string, actor: AuditActor) {
  const db = await getDb();
  const [row] = await db.delete(services).where(and(eq(services.id, id), eq(services.businessId, businessId))).returning();
  if (!row) throw notFound("Service not found");
  await audit(businessId, actor, "service.deleted", { type: "service", id }, { name: row.name });
}
