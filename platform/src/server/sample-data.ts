import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { businesses, categories, faqs, orderFormFields, productVariants, products, services } from "@/db/schema";
import { audit, type AuditActor } from "./audit";
import { ensureOrderForm } from "./commerce/order-form";

type SampleProduct = {
  name: string;
  category: string;
  description: string;
  price: number;
  discountPrice?: number;
  sku: string;
  options: { name: string; values: string[] }[];
  stockPerVariant: number;
};

const PRODUCTS: SampleProduct[] = [
  {
    name: "Classic Black T-Shirt",
    category: "T-Shirts",
    description: "100% cotton crew-neck tee with a relaxed fit. Machine washable.",
    price: 250000,
    sku: "TS-CLS-BLK",
    options: [{ name: "Size", values: ["M", "L", "XL"] }],
    stockPerVariant: 12,
  },
  {
    name: "Premium Black T-Shirt",
    category: "T-Shirts",
    description: "Heavyweight premium cotton tee with a structured collar.",
    price: 350000,
    sku: "TS-PRM-BLK",
    options: [{ name: "Size", values: ["S", "M", "L"] }],
    stockPerVariant: 6,
  },
  {
    name: "Nike Sport T-Shirt",
    category: "T-Shirts",
    description: "Breathable Dri-FIT sports tee.",
    price: 300000,
    discountPrice: 250000,
    sku: "TS-NIKE",
    options: [
      { name: "Color", values: ["Black", "White", "Blue"] },
      { name: "Size", values: ["S", "M", "L", "XL"] },
    ],
    stockPerVariant: 4,
  },
  {
    name: "Everyday Hoodie",
    category: "Hoodies",
    description: "Fleece-lined pullover hoodie with front pocket.",
    price: 550000,
    sku: "HD-EVD",
    options: [
      { name: "Color", values: ["Grey", "Navy"] },
      { name: "Size", values: ["M", "L", "XL"] },
    ],
    stockPerVariant: 3,
  },
  {
    name: "Slim Fit Jeans",
    category: "Jeans",
    description: "Stretch denim slim-fit jeans, dark wash.",
    price: 750000,
    sku: "JN-SLIM",
    options: [{ name: "Waist", values: ["30", "32", "34"] }],
    stockPerVariant: 0,
  },
];

function combinations(options: { name: string; values: string[] }[]): Record<string, string>[] {
  return options.reduce<Record<string, string>[]>(
    (acc, option) => acc.flatMap((combo) => option.values.map((value) => ({ ...combo, [option.name]: value }))),
    [{}],
  );
}

/** Loads a small clothing-store catalog so the owner can try the bot immediately. */
export async function loadSampleData(businessId: string, actor: AuditActor) {
  const db = await getDb();
  const existing = await db.select({ id: products.id }).from(products).where(eq(products.businessId, businessId)).limit(1);
  if (existing.length) return { added: false };

  await db.transaction(async (tx) => {
    const categoryIds = new Map<string, string>();
    for (const name of [...new Set(PRODUCTS.map((p) => p.category))]) {
      const [row] = await tx.insert(categories).values({ businessId, name, kind: "product" }).onConflictDoNothing().returning();
      if (row) categoryIds.set(name, row.id);
    }
    for (const sample of PRODUCTS) {
      const combos = combinations(sample.options);
      const [product] = await tx
        .insert(products)
        .values({
          businessId,
          categoryId: categoryIds.get(sample.category) ?? null,
          name: sample.name,
          description: sample.description,
          price: sample.price,
          discountPrice: sample.discountPrice ?? null,
          sku: sample.sku,
          options: sample.options,
          stock: combos.length * sample.stockPerVariant,
        })
        .returning();
      await tx.insert(productVariants).values(
        combos.map((combo) => ({
          businessId,
          productId: product.id,
          optionValues: combo,
          stock: sample.stockPerVariant,
          sku: `${sample.sku}-${Object.values(combo).join("-").toUpperCase()}`,
        })),
      );
    }
    const [svcCat] = await tx.insert(categories).values({ businessId, name: "Alterations", kind: "service" }).onConflictDoNothing().returning();
    await tx.insert(services).values({
      businessId,
      categoryId: svcCat?.id ?? null,
      name: "Trouser Hemming",
      description: "Hem any trousers or jeans to your length.",
      price: 80000,
      durationMinutes: 45,
      availability: "Mon–Sat, 10 AM – 6 PM",
    });
    await tx.insert(faqs).values([
      { businessId, question: "Do you deliver islandwide?", answer: "Yes, we deliver throughout Sri Lanka within 2–4 working days.", sortOrder: 0 },
      { businessId, question: "Can I exchange a size?", answer: "Yes, unworn items can be exchanged within 7 days with the receipt.", sortOrder: 1 },
    ]);
    // Only fill profile fields the owner hasn't written yet.
    const [current] = await tx.select().from(businesses).where(eq(businesses.id, businessId));
    const defaults = {
      description: "A clothing store selling men's and women's fashion products in Sri Lanka.",
      openingHours: "Monday–Friday: 9 AM – 7 PM\nSaturday: 9 AM – 2 PM",
      deliveryInfo: "Islandwide delivery in 2–4 working days.",
      returnPolicy: "Returns accepted within 7 days for unworn items with tags.",
      exchangePolicy: "Size exchanges within 7 days.",
    } as const;
    const fill: Partial<typeof businesses.$inferInsert> = {};
    for (const [key, value] of Object.entries(defaults) as [keyof typeof defaults, string][]) {
      if (!current[key]?.trim()) fill[key] = value;
    }
    if (!current.deliveryFee) fill.deliveryFee = 35000;
    if (Object.keys(fill).length) await tx.update(businesses).set(fill).where(eq(businesses.id, businessId));

    const form = await ensureOrderForm(businessId, tx);
    const [existingField] = await tx
      .select()
      .from(orderFormFields)
      .where(and(eq(orderFormFields.formId, form.id), eq(orderFormFields.key, "delivery_time")));
    if (!existingField) {
      await tx.insert(orderFormFields).values({
        businessId,
        formId: form.id,
        key: "delivery_time",
        label: "Preferred delivery time",
        type: "select",
        required: false,
        options: ["Morning", "Afternoon", "Evening"],
        sortOrder: 20,
      });
    }
  });
  await audit(businessId, actor, "business.sample_data_loaded", { type: "business", id: businessId });
  return { added: true };
}
