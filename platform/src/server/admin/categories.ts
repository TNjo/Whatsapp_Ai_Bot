import "server-only";
import { fromDocs, keyId, store } from "@/db";
import type { Category } from "@/db/schema";

export async function listCategories(businessId: string, kind: "product" | "service") {
  const s = await store();
  return fromDocs<Category>(await s.categories(businessId).where("kind", "==", kind).get())
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Finds a category by name for this business, creating it when new. The id is
 * derived from kind + name, so the same name can't be created twice.
 */
export async function resolveCategory(
  businessId: string,
  kind: "product" | "service",
  name: string | null | undefined,
): Promise<string | null> {
  const clean = name?.trim();
  if (!clean) return null;
  const s = await store();
  const id = keyId(`${kind}:${clean.toLowerCase()}`);
  const ref = s.categories(businessId).doc(id);
  if (!(await ref.get()).exists) await ref.set({ name: clean, kind, createdAt: new Date() });
  return id;
}
