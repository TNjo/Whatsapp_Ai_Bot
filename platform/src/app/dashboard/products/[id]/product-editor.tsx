"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ImagePlus, Layers, Loader2, Plus, Star, Trash2, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/app/common";
import { ConfirmButton, Field, NativeSelect } from "@/components/app/controls";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api-client";
import { formatMoney, parseMoney, toMajor } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusBadge, type ProductVariantRow } from "../product-bits";

type EditableProduct = {
  id: string;
  name: string;
  description: string;
  category: string | null;
  price: number;
  discountPrice: number | null;
  sku: string;
  stock: number;
  trackStock: boolean;
  images: string[];
  options: { name: string; values: string[] }[];
  status: "active" | "disabled";
  variants: ProductVariantRow[];
};

type OptionDraft = { uid: number; name: string; values: string[] };
type VariantDraft = { price: string; stock: string; sku: string; active: boolean };

const MAX_IMAGES = 10;
const MAX_OPTIONS = 3;
const MAX_VARIANTS = 250;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const OPTION_SUGGESTIONS = ["Size", "Color", "Material", "Style"];
const EMPTY_VARIANT: VariantDraft = { price: "", stock: "0", sku: "", active: true };

let optionUid = 0;
const nextUid = () => ++optionUid;

/** Order-independent identity of a combination — mirrors the server's variantKey. */
function variantKey(values: Record<string, string>) {
  return Object.entries(values)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}\u0000${v}`)
    .join("\u0001");
}

function combinations(options: { name: string; values: string[] }[]): Record<string, string>[] {
  if (!options.length) return [];
  return options.reduce<Record<string, string>[]>(
    (acc, option) => acc.flatMap((combo) => option.values.map((value) => ({ ...combo, [option.name]: value }))),
    [{}],
  );
}

export function ProductEditor({ product, categories, currency }: { product: EditableProduct | null; categories: string[]; currency: string }) {
  const router = useRouter();
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [category, setCategory] = useState(product?.category ?? "");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [status, setStatus] = useState<"active" | "disabled">(product?.status ?? "active");
  const [price, setPrice] = useState(toMajor(product?.price));
  const [discountPrice, setDiscountPrice] = useState(toMajor(product?.discountPrice));
  const [trackStock, setTrackStock] = useState(product?.trackStock ?? true);
  const [stock, setStock] = useState(String(product?.stock ?? 0));
  const [images, setImages] = useState<string[]>(product?.images ?? []);
  const [uploading, setUploading] = useState(0);
  const [options, setOptions] = useState<OptionDraft[]>(() => (product?.options ?? []).map((o) => ({ uid: nextUid(), ...o })));
  // Never pruned: removing a value and adding it back restores that variant's data.
  const [variantData, setVariantData] = useState<Record<string, VariantDraft>>(() =>
    Object.fromEntries(
      (product?.variants ?? []).map((v) => [variantKey(v.optionValues), { price: toMajor(v.price), stock: String(v.stock), sku: v.sku, active: v.active }]),
    ),
  );
  const [saving, setSaving] = useState(false);

  const priceMinor = parseMoney(price);
  const discountMinor = discountPrice.trim() ? parseMoney(discountPrice) : null;
  const discountError = discountMinor !== null && priceMinor !== null && discountMinor >= priceMinor ? "Must be lower than the price" : null;
  const basePrice = discountMinor !== null && priceMinor !== null && discountMinor < priceMinor ? discountMinor : priceMinor;

  const usableOptions = useMemo(
    () => options.filter((o) => o.name.trim() && o.values.length).map((o) => ({ name: o.name.trim(), values: o.values })),
    [options],
  );
  const combos = useMemo(() => combinations(usableOptions), [usableOptions]);
  const hasVariants = combos.length > 0;
  const variantRows = combos.map((combo) => {
    const key = variantKey(combo);
    return { key, combo, data: variantData[key] ?? EMPTY_VARIANT };
  });
  const variantTotal = variantRows.reduce((sum, row) => sum + (Number(row.data.stock) || 0), 0);

  const setVariant = (key: string, patch: Partial<VariantDraft>) =>
    setVariantData((current) => ({ ...current, [key]: { ...(current[key] ?? EMPTY_VARIANT), ...patch } }));

  const updateOption = (uid: number, patch: Partial<OptionDraft>) =>
    setOptions((current) => current.map((o) => (o.uid === uid ? { ...o, ...patch } : o)));

  /* ------------------------------ Images ------------------------------ */

  const upload = async (files: FileList | File[]) => {
    const room = MAX_IMAGES - images.length - uploading;
    const list = Array.from(files);
    if (list.length > room) toast.error(`You can add up to ${MAX_IMAGES} images per product.`);
    for (const file of list.slice(0, Math.max(0, room))) {
      if (!IMAGE_TYPES.includes(file.type)) {
        toast.error(`${file.name}: only PNG, JPEG or WebP images are supported.`);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(`${file.name} is larger than 5 MB.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.set("file", file);
        const { url } = await api<{ url: string }>("/api/uploads", { body: form });
        setImages((current) => [...current, url]);
      } catch (err) {
        toast.error(`${file.name}: ${errorMessage(err)}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  /* ------------------------------- Save ------------------------------- */

  const validate = (): string | null => {
    if (!name.trim()) return "Give the product a name.";
    if (priceMinor === null) return "Enter a valid price.";
    if (discountPrice.trim() && discountMinor === null) return "Enter a valid discount price, or leave it blank.";
    if (discountError) return "Discount price must be lower than the regular price.";
    const seen = new Set<string>();
    for (const option of options) {
      const optionName = option.name.trim();
      if (!optionName && !option.values.length) continue;
      if (!optionName) return "Every option needs a name, like “Size”.";
      if (!option.values.length) return `Add at least one value for “${optionName}”.`;
      if (seen.has(optionName.toLowerCase())) return `The option “${optionName}” is listed twice.`;
      seen.add(optionName.toLowerCase());
    }
    if (combos.length > MAX_VARIANTS) return `These options make ${combos.length} variants — the limit is ${MAX_VARIANTS}.`;
    for (const row of variantRows) {
      if (row.data.price.trim() && parseMoney(row.data.price) === null) return `Check the price for ${Object.values(row.combo).join(" / ")}.`;
    }
    return null;
  };

  const save = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const problem = validate();
    if (problem) {
      toast.error(problem);
      return;
    }
    if (uploading) {
      toast.error("Wait for the images to finish uploading.");
      return;
    }
    const body = {
      name,
      description,
      category,
      sku,
      status,
      price,
      discountPrice: discountPrice.trim() || null,
      trackStock,
      stock: Math.max(0, Math.floor(Number(stock) || 0)),
      images,
      options: usableOptions,
      variants: variantRows.map((row) => ({
        optionValues: row.combo,
        price: row.data.price.trim() || null,
        stock: Math.max(0, Math.floor(Number(row.data.stock) || 0)),
        sku: row.data.sku,
        active: row.data.active,
      })),
    };
    setSaving(true);
    try {
      if (product) {
        await api(`/api/products/${product.id}`, { method: "PATCH", body });
        toast.success("Product saved");
        router.refresh();
      } else {
        const { product: created } = await api<{ product: { id: string } }>("/api/products", { body });
        toast.success("Product added");
        router.replace(`/dashboard/products/${created.id}`);
        router.refresh();
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!product) return;
    try {
      await api(`/api/products/${product.id}`, { method: "DELETE" });
      toast.success("Product deleted");
      router.push("/dashboard/products");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const saveButton = (
    <Button type="submit" disabled={saving || uploading > 0}>
      {saving ? <Loader2 className="size-4 animate-spin" /> : null}
      {product ? "Save changes" : "Add product"}
    </Button>
  );

  return (
    <form onSubmit={save} className="grid gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <Link href="/dashboard/products" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> Products
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{product ? product.name : "Add product"}</h1>
            {product ? <StatusBadge status={product.status} /> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {product ? "Changes apply to the WhatsApp assistant as soon as you save." : "The assistant uses these details, photos and prices when customers ask."}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {product ? (
            <ConfirmButton
              type="button"
              variant="ghost"
              className="text-destructive"
              title={`Delete ${product.name}?`}
              description="The assistant will stop offering this product and it is removed from open carts. Past orders keep their details."
              confirmLabel="Delete"
              destructive
              onConfirm={remove}
            >
              <Trash2 className="size-4" /> Delete
            </ConfirmButton>
          ) : null}
          <Link href="/dashboard/products" className={buttonVariants({ variant: "outline" })}>
            Cancel
          </Link>
          {saveButton}
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="grid min-w-0 gap-6 lg:col-span-2">
          {/* Basics */}
          <SectionCard title="Basics" description="What the product is and how customers find it." bodyClassName="grid gap-4">
            <Field label="Name" htmlFor="p-name">
              <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Classic Cotton T-Shirt" />
            </Field>
            <Field label="Description" htmlFor="p-desc" hint="Material, fit, sizing notes — the assistant quotes this when customers ask.">
              <Textarea id="p-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={4000} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Category" htmlFor="p-category">
                <Input id="p-category" value={category} onChange={(e) => setCategory(e.target.value)} list="product-categories" maxLength={60} placeholder="T-Shirts" />
                <datalist id="product-categories">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
              <Field label="SKU" htmlFor="p-sku">
                <Input id="p-sku" value={sku} onChange={(e) => setSku(e.target.value)} maxLength={60} placeholder="TS-001" />
              </Field>
              <Field label="Status" htmlFor="p-status">
                <NativeSelect id="p-status" value={status} onChange={(e) => setStatus(e.target.value as "active" | "disabled")}>
                  <option value="active">Active</option>
                  <option value="disabled">Disabled</option>
                </NativeSelect>
              </Field>
            </div>
          </SectionCard>

          {/* Images */}
          <SectionCard
            title="Images"
            description="The first image is the cover the assistant sends on WhatsApp."
            actions={<span className="text-xs text-muted-foreground tabular-nums">{images.length}/{MAX_IMAGES}</span>}
          >
            <ImagesField images={images} uploading={uploading} onUpload={upload} onChange={setImages} />
          </SectionCard>

          {/* Options & variants */}
          <SectionCard
            title="Options & variants"
            description="Add options like Size or Color. A variant is created for every combination."
            bodyClassName="grid gap-4"
          >
            {options.length ? (
              <div className="grid gap-3">
                {options.map((option, index) => (
                  <div key={option.uid} className="grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-[10rem_1fr_auto] sm:items-start">
                    <Input
                      aria-label={`Option ${index + 1} name`}
                      value={option.name}
                      onChange={(e) => updateOption(option.uid, { name: e.target.value })}
                      placeholder="Option name"
                      maxLength={40}
                      className="bg-background"
                    />
                    <ValuesInput
                      label={`${option.name || `Option ${index + 1}`} values`}
                      values={option.values}
                      onChange={(values) => updateOption(option.uid, { values })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${option.name || "option"}`}
                      className="justify-self-end text-muted-foreground hover:text-destructive"
                      onClick={() => setOptions((current) => current.filter((o) => o.uid !== option.uid))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-8 text-center">
                <span className="mb-2 grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <Layers className="size-4" />
                </span>
                <p className="text-sm font-medium">No options</p>
                <p className="mt-0.5 max-w-sm text-sm text-muted-foreground">This product is sold as a single item. Add options if it comes in sizes, colors or styles.</p>
              </div>
            )}

            {options.length < MAX_OPTIONS ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setOptions((current) => [...current, { uid: nextUid(), name: "", values: [] }])}>
                  <Plus className="size-3.5" /> Add option
                </Button>
                {OPTION_SUGGESTIONS.filter((s) => !options.some((o) => o.name.trim().toLowerCase() === s.toLowerCase()))
                  .slice(0, 3)
                  .map((suggestion) => (
                    <Button
                      key={suggestion}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      onClick={() => setOptions((current) => [...current, { uid: nextUid(), name: suggestion, values: [] }])}
                    >
                      + {suggestion}
                    </Button>
                  ))}
              </div>
            ) : null}

            {hasVariants ? (
              <VariantsTable
                rows={variantRows}
                currency={currency}
                basePrice={basePrice}
                productSku={sku}
                total={variantTotal}
                trackStock={trackStock}
                onChange={setVariant}
              />
            ) : null}
          </SectionCard>
        </div>

        <div className="grid min-w-0 gap-6">
          {/* Pricing */}
          <SectionCard title="Pricing" bodyClassName="grid gap-4">
            <Field label={`Price (${currency})`} htmlFor="p-price">
              <Input id="p-price" type="number" min={0} step="0.01" inputMode="decimal" required value={price} onChange={(e) => setPrice(e.target.value)} placeholder="2500" />
            </Field>
            <Field
              label="Discount price"
              htmlFor="p-discount"
              hint={discountError ? <span className="text-destructive">{discountError}</span> : "Optional. Shown as the sale price with the regular price struck through."}
            >
              <Input
                id="p-discount"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={discountPrice}
                onChange={(e) => setDiscountPrice(e.target.value)}
                aria-invalid={discountError ? true : undefined}
                placeholder="—"
              />
            </Field>
            {priceMinor !== null ? (
              <div className="flex items-baseline justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Customers pay</span>
                <span className="flex items-baseline gap-2 tabular-nums">
                  {basePrice !== priceMinor ? <span className="text-xs text-muted-foreground line-through">{formatMoney(priceMinor, currency)}</span> : null}
                  <span className="font-semibold">{formatMoney(basePrice ?? 0, currency)}</span>
                </span>
              </div>
            ) : null}
          </SectionCard>

          {/* Inventory */}
          <SectionCard title="Inventory" bodyClassName="grid gap-4">
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">Track stock</span>
                <span className="block text-xs text-muted-foreground">
                  {trackStock ? "The assistant won't sell more than you have." : "Always available — stock isn't checked."}
                </span>
              </span>
              <Switch checked={trackStock} onCheckedChange={setTrackStock} aria-label="Track stock" />
            </label>
            {hasVariants ? (
              <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                <div className="flex items-baseline justify-between">
                  <span className="text-muted-foreground">Total stock</span>
                  <span className="font-semibold tabular-nums">{variantTotal}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">Sum of all variants — set stock per variant below.</p>
              </div>
            ) : (
              <Field label="Quantity in stock" htmlFor="p-stock">
                <Input
                  id="p-stock"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={stock}
                  onChange={(e) => setStock(e.target.value)}
                  disabled={!trackStock}
                  className="tabular-nums"
                />
              </Field>
            )}
          </SectionCard>
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t pt-4">
        <Link href="/dashboard/products" className={buttonVariants({ variant: "outline" })}>
          Cancel
        </Link>
        {saveButton}
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------- */
/* Images                                                               */
/* -------------------------------------------------------------------- */

function ImagesField({
  images,
  uploading,
  onUpload,
  onChange,
}: {
  images: string[];
  uploading: number;
  onUpload: (files: FileList | File[]) => void;
  onChange: (images: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const full = images.length + uploading >= MAX_IMAGES;

  return (
    <div
      className={cn("grid grid-cols-3 gap-3 rounded-lg sm:grid-cols-4 md:grid-cols-5", dragging && "ring-2 ring-primary/40 ring-offset-4 ring-offset-card")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) onUpload(e.dataTransfer.files);
      }}
    >
      {images.map((url, index) => (
        <div key={url} className="group relative aspect-square overflow-hidden rounded-lg border bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={`Product image ${index + 1}`} className="size-full object-cover" />
          {index === 0 ? (
            <Badge className="absolute bottom-1.5 left-1.5 border-0 bg-background/90 text-foreground shadow-xs backdrop-blur">Cover</Badge>
          ) : (
            <button
              type="button"
              onClick={() => onChange([url, ...images.filter((u) => u !== url)])}
              className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-0.5 text-xs font-medium shadow-xs backdrop-blur transition-opacity hover:bg-background sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
            >
              <Star className="size-3" /> Make cover
            </button>
          )}
          <button
            type="button"
            aria-label={`Remove image ${index + 1}`}
            onClick={() => onChange(images.filter((u) => u !== url))}
            className="absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full bg-background/90 text-foreground shadow-xs backdrop-blur transition-colors hover:bg-destructive hover:text-white"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      {Array.from({ length: uploading }).map((_, i) => (
        <div key={`uploading-${i}`} className="grid aspect-square place-items-center rounded-lg border border-dashed bg-muted/40 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ))}
      {!full ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={cn(
            "flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted/40 hover:text-foreground",
            !images.length && !uploading && "col-span-3 aspect-auto py-8 sm:col-span-4 md:col-span-5",
          )}
        >
          <ImagePlus className="size-5" />
          <span className="text-xs font-medium">{images.length ? "Add" : "Upload images"}</span>
          {!images.length && !uploading ? <span className="text-xs">PNG, JPEG or WebP · up to 5 MB each · or drop files here</span> : null}
        </button>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onUpload(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Option values (chips)                                                */
/* -------------------------------------------------------------------- */

function ValuesInput({ label, values, onChange }: { label: string; values: string[]; onChange: (values: string[]) => void }) {
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const incoming = raw
      .split(",")
      .map((v) => v.trim().slice(0, 40))
      .filter(Boolean);
    if (!incoming.length) return;
    const next = [...values];
    for (const value of incoming) if (!next.some((v) => v.toLowerCase() === value.toLowerCase())) next.push(value);
    onChange(next);
    setDraft("");
  };

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
      {values.map((value) => (
        <span key={value} className="inline-flex h-6 items-center gap-1 rounded-md bg-secondary pr-1 pl-2 text-xs font-medium text-secondary-foreground">
          {value}
          <button
            type="button"
            aria-label={`Remove ${value}`}
            onClick={() => onChange(values.filter((v) => v !== value))}
            className="grid size-4 place-items-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        value={draft}
        onChange={(e) => {
          const value = e.target.value;
          if (value.includes(",")) add(value);
          else setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => add(draft)}
        placeholder={values.length ? "Add value" : "e.g. S, M, L, XL"}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Variants                                                             */
/* -------------------------------------------------------------------- */

function VariantsTable({
  rows,
  currency,
  basePrice,
  productSku,
  total,
  trackStock,
  onChange,
}: {
  rows: { key: string; combo: Record<string, string>; data: VariantDraft }[];
  currency: string;
  basePrice: number | null;
  productSku: string;
  total: number;
  trackStock: boolean;
  onChange: (key: string, patch: Partial<VariantDraft>) => void;
}) {
  const [bulkStock, setBulkStock] = useState("");
  const [bulkPrice, setBulkPrice] = useState("");
  const pricePlaceholder = basePrice !== null ? toMajor(basePrice) : "Product price";
  const canGenerateSku = productSku.trim().length > 0 && rows.some((r) => !r.data.sku.trim());

  const applyBulk = () => {
    for (const row of rows) {
      const patch: Partial<VariantDraft> = {};
      if (bulkStock.trim()) patch.stock = bulkStock.trim();
      if (bulkPrice.trim()) patch.price = bulkPrice.trim();
      onChange(row.key, patch);
    }
    setBulkStock("");
    setBulkPrice("");
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {rows.length} {rows.length === 1 ? "variant" : "variants"}
          <span className="ml-2 font-normal text-muted-foreground">· {total} in stock</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Price for all variants"
            type="number"
            min={0}
            step="0.01"
            value={bulkPrice}
            onChange={(e) => setBulkPrice(e.target.value)}
            placeholder="All prices"
            className="h-7 w-28 text-xs"
          />
          <Input
            aria-label="Stock for all variants"
            type="number"
            min={0}
            step={1}
            value={bulkStock}
            onChange={(e) => setBulkStock(e.target.value)}
            placeholder="All stock"
            className="h-7 w-28 text-xs"
          />
          <Button type="button" variant="outline" size="sm" disabled={!bulkStock.trim() && !bulkPrice.trim()} onClick={applyBulk}>
            Apply
          </Button>
          {canGenerateSku ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                for (const row of rows) {
                  if (row.data.sku.trim()) continue;
                  const suffix = Object.values(row.combo)
                    .map((v) => v.replace(/[^A-Za-z0-9]+/g, "").toUpperCase())
                    .join("-");
                  onChange(row.key, { sku: `${productSku.trim()}-${suffix}`.slice(0, 60) });
                }
              }}
            >
              <Wand2 className="size-3.5" /> Fill SKUs
            </Button>
          ) : null}
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[36rem] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Variant</th>
              <th className="w-32 px-2 py-2 font-medium">Price</th>
              <th className="w-24 px-2 py-2 font-medium">Stock</th>
              <th className="w-36 px-2 py-2 font-medium">SKU</th>
              <th className="w-16 px-3 py-2 text-center font-medium">Active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, combo, data }) => {
              const label = Object.values(combo).join(" / ");
              return (
                <tr key={key} className={cn("border-t", !data.active && "bg-muted/30")}>
                  <td className="px-3 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(combo).map(([optionName, value]) => (
                        <span
                          key={optionName}
                          title={optionName}
                          className={cn("rounded-md border bg-background px-1.5 py-0.5 text-xs", !data.active && "text-muted-foreground")}
                        >
                          {value}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      aria-label={`Price for ${label}`}
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      value={data.price}
                      onChange={(e) => onChange(key, { price: e.target.value })}
                      placeholder={pricePlaceholder}
                      title={data.price.trim() ? undefined : `Uses the product price (${basePrice !== null ? formatMoney(basePrice, currency) : "not set"})`}
                      className="h-7 tabular-nums"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      aria-label={`Stock for ${label}`}
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      value={data.stock}
                      onChange={(e) => onChange(key, { stock: e.target.value })}
                      className={cn("h-7 tabular-nums", trackStock && Number(data.stock) <= 0 && data.active && "text-rose-600 dark:text-rose-400")}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input aria-label={`SKU for ${label}`} value={data.sku} maxLength={60} onChange={(e) => onChange(key, { sku: e.target.value })} className="h-7" />
                  </td>
                  <td className="px-3 py-1.5 text-center">
                    <Switch size="sm" checked={data.active} onCheckedChange={(active) => onChange(key, { active })} aria-label={`${label} active`} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Leave a variant&apos;s price blank to use the product price. Inactive variants are never offered to customers.</p>
    </div>
  );
}
