import "server-only";
import { asc, eq } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/db";
import { orderFormFields, orderForms, type OrderFieldType } from "@/db/schema";

/** System fields map onto order columns. Product and quantity live on the cart items themselves. */
export const SYSTEM_FIELDS: {
  key: string;
  label: string;
  type: OrderFieldType;
  required: boolean;
  helpText?: string;
}[] = [
  { key: "name", label: "Full Name", type: "text", required: true },
  { key: "phone", label: "Phone Number", type: "phone", required: true, helpText: "Filled automatically from WhatsApp." },
  { key: "address", label: "Delivery Address", type: "textarea", required: true },
  { key: "city", label: "City", type: "text", required: true },
  { key: "payment_method", label: "Payment Method", type: "select", required: true, helpText: "Options come from the payment methods in Settings." },
  { key: "note", label: "Customer Note", type: "textarea", required: false },
];

export const SYSTEM_KEYS = new Set(SYSTEM_FIELDS.map((field) => field.key));

export async function ensureOrderForm(businessId: string, tx?: DbOrTx) {
  const db = tx ?? (await getDb());
  const [existing] = await db.select().from(orderForms).where(eq(orderForms.businessId, businessId));
  if (existing) return existing;
  const [form] = await db.insert(orderForms).values({ businessId }).onConflictDoNothing().returning();
  if (!form) {
    const [raced] = await db.select().from(orderForms).where(eq(orderForms.businessId, businessId));
    return raced;
  }
  await db.insert(orderFormFields).values(
    SYSTEM_FIELDS.map((field, index) => ({
      businessId,
      formId: form.id,
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      enabled: true,
      system: true,
      helpText: field.helpText ?? "",
      sortOrder: index,
    })),
  );
  return form;
}

export type FormField = typeof orderFormFields.$inferSelect;

/** Enabled fields in display order. */
export async function getOrderFields(businessId: string, { includeDisabled = false } = {}): Promise<FormField[]> {
  await ensureOrderForm(businessId);
  const db = await getDb();
  const rows = await db
    .select()
    .from(orderFormFields)
    .where(eq(orderFormFields.businessId, businessId))
    .orderBy(asc(orderFormFields.sortOrder), asc(orderFormFields.createdAt));
  return includeDisabled ? rows : rows.filter((row) => row.enabled);
}

export function slugKey(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "field"
  );
}
