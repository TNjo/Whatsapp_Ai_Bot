import "server-only";
import { z } from "zod";
import { fromDoc, fromDocs, newId, store, toDoc } from "@/db";
import type { Service } from "@/db/schema";
import { categoryNames } from "../commerce/catalog";
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
  const s = await store();
  const [rows, cats] = await Promise.all([fromDocs<Service>(await s.services(businessId).get()), categoryNames(businessId)]);
  const q = query.trim().toLowerCase();
  return rows
    .filter((row) => !q || `${row.name} ${row.description}`.toLowerCase().includes(q))
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      price: row.price,
      durationMinutes: row.durationMinutes,
      availability: row.availability,
      status: row.status,
      category: row.categoryId ? (cats.get(row.categoryId) ?? null) : null,
      updatedAt: row.updatedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type ServiceRow = Awaited<ReturnType<typeof listServices>>[number];

export async function createService(businessId: string, input: z.infer<typeof ServiceInput>, actor: AuditActor) {
  const s = await store();
  const categoryId = await resolveCategory(businessId, "service", input.category);
  const { category: _category, ...rest } = input;
  void _category;
  const now = new Date();
  const row: Service = { id: newId(), businessId, categoryId, ...rest, durationMinutes: input.durationMinutes ?? null, createdAt: now, updatedAt: now };
  await s.services(businessId).doc(row.id).set(toDoc(row));
  await audit(businessId, actor, "service.created", { type: "service", id: row.id }, { name: row.name });
  return row;
}

export async function updateService(businessId: string, id: string, input: Partial<z.infer<typeof ServiceInput>>, actor: AuditActor) {
  const s = await store();
  const ref = s.services(businessId).doc(id);
  const current = fromDoc<Service>(await ref.get());
  if (!current) throw notFound("Service not found");
  const { category, ...rest } = input;
  const patch: Partial<Service> = { ...rest, updatedAt: new Date() };
  if (category !== undefined) patch.categoryId = await resolveCategory(businessId, "service", category);
  await ref.update(patch);
  await audit(businessId, actor, "service.updated", { type: "service", id }, { fields: Object.keys(input) });
  return { ...current, ...patch };
}

export async function deleteService(businessId: string, id: string, actor: AuditActor) {
  const s = await store();
  const ref = s.services(businessId).doc(id);
  const current = fromDoc<Service>(await ref.get());
  if (!current) throw notFound("Service not found");
  await ref.delete();
  await audit(businessId, actor, "service.deleted", { type: "service", id }, { name: current.name });
}
