import "server-only";
import { fromDoc, newId, store } from "@/db";
import type { Business, Product } from "@/db/schema";
import { audit, type AuditActor } from "./audit";
import { resolveCategory } from "./admin/categories";
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
  const s = await store();
  const existing = await s.products(businessId).limit(1).get();
  if (!existing.empty) return { added: false };

  const now = new Date();
  const batch = s.db.batch();
  for (const sample of PRODUCTS) {
    const combos = combinations(sample.options);
    const categoryId = await resolveCategory(businessId, "product", sample.category);
    const product: Omit<Product, "id"> = {
      businessId,
      categoryId,
      name: sample.name,
      description: sample.description,
      price: sample.price,
      discountPrice: sample.discountPrice ?? null,
      sku: sample.sku,
      stock: combos.length * sample.stockPerVariant,
      trackStock: true,
      images: [],
      options: sample.options,
      variants: combos.map((combo) => ({
        id: newId(),
        optionValues: combo,
        price: null,
        stock: sample.stockPerVariant,
        sku: `${sample.sku}-${Object.values(combo).join("-").toUpperCase()}`,
        active: true,
      })),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    batch.set(s.products(businessId).doc(newId()), product);
  }
  const serviceCategory = await resolveCategory(businessId, "service", "Alterations");
  batch.set(s.services(businessId).doc(newId()), {
    businessId,
    categoryId: serviceCategory,
    name: "Trouser Hemming",
    description: "Hem any trousers or jeans to your length.",
    price: 80000,
    durationMinutes: 45,
    availability: "Mon–Sat, 10 AM – 6 PM",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  [
    { question: "Do you deliver islandwide?", answer: "Yes, we deliver throughout Sri Lanka within 2–4 working days." },
    { question: "Can I exchange a size?", answer: "Yes, unworn items can be exchanged within 7 days with the receipt." },
  ].forEach((faq, sortOrder) => batch.set(s.faqs(businessId).doc(newId()), { ...faq, enabled: true, sortOrder, createdAt: now, updatedAt: now }));

  // Only fill profile fields the owner hasn't written yet.
  const current = fromDoc<Business>(await s.businesses.doc(businessId).get())!;
  const defaults = {
    description: "A clothing store selling men's and women's fashion products in Sri Lanka.",
    openingHours: "Monday–Friday: 9 AM – 7 PM\nSaturday: 9 AM – 2 PM",
    deliveryInfo: "Islandwide delivery in 2–4 working days.",
    returnPolicy: "Returns accepted within 7 days for unworn items with tags.",
    exchangePolicy: "Size exchanges within 7 days.",
  } as const;
  const fill: Partial<Business> = {};
  for (const [key, value] of Object.entries(defaults) as [keyof typeof defaults, string][]) {
    if (!current[key]?.trim()) fill[key] = value;
  }
  if (!current.deliveryFee) fill.deliveryFee = 35000;
  if (Object.keys(fill).length) batch.update(s.businesses.doc(businessId), { ...fill, updatedAt: now });

  const form = await ensureOrderForm(businessId);
  if (!form.fields.some((field) => field.key === "delivery_time")) {
    batch.update(s.orderForm(businessId), {
      fields: [
        ...form.fields,
        {
          id: newId(),
          key: "delivery_time",
          label: "Preferred delivery time",
          type: "select",
          required: false,
          enabled: true,
          system: false,
          options: ["Morning", "Afternoon", "Evening"],
          helpText: "",
          sortOrder: form.fields.length,
        },
      ],
      updatedAt: now,
    });
  }
  await batch.commit();
  await audit(businessId, actor, "business.sample_data_loaded", { type: "business", id: businessId });
  return { added: true };
}
