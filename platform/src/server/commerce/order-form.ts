import "server-only";
import { fromDoc, isAlreadyExists, newId, store } from "@/db";
import type { OrderFieldType, OrderForm, OrderFormField } from "@/db/schema";

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

function defaultFields(): OrderFormField[] {
  return SYSTEM_FIELDS.map((field, index) => ({
    id: newId(),
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    enabled: true,
    system: true,
    options: [],
    helpText: field.helpText ?? "",
    sortOrder: index,
  }));
}

/** settings/orderForm holds the whole field list in one document. */
export async function ensureOrderForm(businessId: string): Promise<OrderForm> {
  const s = await store();
  const ref = s.orderForm(businessId);
  const snap = await ref.get();
  if (snap.exists) return fromDoc<OrderForm & { id: string }>(snap)!;
  const form: OrderForm = { name: "Order information", fields: defaultFields(), updatedAt: new Date() };
  try {
    await ref.create(form);
    return form;
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    return fromDoc<OrderForm & { id: string }>(await ref.get())!;
  }
}

export type FormField = OrderFormField;

/** Enabled fields in display order. */
export async function getOrderFields(businessId: string, { includeDisabled = false } = {}): Promise<FormField[]> {
  const form = await ensureOrderForm(businessId);
  const fields = [...form.fields].sort((a, b) => a.sortOrder - b.sortOrder);
  return includeDisabled ? fields : fields.filter((field) => field.enabled);
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
