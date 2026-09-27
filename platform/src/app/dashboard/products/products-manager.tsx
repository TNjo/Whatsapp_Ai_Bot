"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Layers, Loader2, MoreHorizontal, Package, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageHeader } from "@/components/app/common";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api-client";
import { formatMoney, variantLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ProductThumb, StatusBadge, StockBadge, stockState, type ProductVariantRow } from "./product-bits";

type Product = {
  id: string;
  name: string;
  description: string;
  price: number;
  discountPrice: number | null;
  sku: string;
  stock: number;
  trackStock: boolean;
  images: string[];
  options: { name: string; values: string[] }[];
  status: "active" | "disabled";
  category: string | null;
  updatedAt: string;
  variants: ProductVariantRow[];
};

type Filter = "all" | "active" | "disabled" | "out";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
  { value: "out", label: "Out of stock" },
];

export function ProductsManager({ initial, currency, lowStockThreshold }: { initial: Product[]; currency: string; lowStockThreshold: number }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [stockFor, setStockFor] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [busy, setBusy] = useState(false);

  const counts = useMemo(
    () => ({
      all: initial.length,
      active: initial.filter((p) => p.status === "active").length,
      disabled: initial.filter((p) => p.status === "disabled").length,
      out: initial.filter((p) => stockState(p, lowStockThreshold) === "out").length,
    }),
    [initial, lowStockThreshold],
  );

  const products = useMemo(() => {
    const q = query.trim().toLowerCase();
    return initial.filter((p) => {
      if (filter === "active" && p.status !== "active") return false;
      if (filter === "disabled" && p.status !== "disabled") return false;
      if (filter === "out" && stockState(p, lowStockThreshold) !== "out") return false;
      return !q || `${p.name} ${p.description} ${p.category ?? ""} ${p.sku}`.toLowerCase().includes(q);
    });
  }, [initial, query, filter, lowStockThreshold]);

  const toggle = async (product: Product) => {
    try {
      await api(`/api/products/${product.id}`, { method: "PATCH", body: { status: product.status === "active" ? "disabled" : "active" } });
      toast.success(product.status === "active" ? "Product disabled" : "Product enabled");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/api/products/${deleting.id}`, { method: "DELETE" });
      toast.success("Product deleted");
      setDeleting(null);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addButton = (label: string) => (
    <Link href="/dashboard/products/new" className={buttonVariants()}>
      <Plus className="size-4" /> {label}
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Products"
        description="Everything the assistant can show, price and take orders for on WhatsApp."
        actions={addButton("Add product")}
      />

      {initial.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No products yet"
          description="Add your first product with photos, a price and stock. Add options like Size or Color and the assistant will ask customers which one they want."
          action={addButton("Add your first product")}
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-xs">
          <div className="flex flex-col gap-3 border-b p-3 md:flex-row md:items-center md:justify-between">
            <div className="relative w-full md:max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, category or SKU" className="pl-8" />
            </div>
            <div role="tablist" aria-label="Filter products" className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                    filter === f.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {f.label}
                  <span className={cn("tabular-nums", filter === f.value ? "opacity-80" : "opacity-60")}>{counts[f.value]}</span>
                </button>
              ))}
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Product</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => {
                const state = stockState(product, lowStockThreshold);
                const hasDiscount = product.discountPrice !== null && product.discountPrice < product.price;
                return (
                  <TableRow key={product.id} className="cursor-pointer" onClick={() => router.push(`/dashboard/products/${product.id}`)}>
                    <TableCell className="pl-4">
                      <div className="flex min-w-40 items-center gap-3">
                        <ProductThumb src={product.images[0]} name={product.name} />
                        <div className="min-w-0">
                          <Link
                            href={`/dashboard/products/${product.id}`}
                            className="block max-w-xs truncate font-medium hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {product.name}
                          </Link>
                          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                            <span className="truncate">{product.category ?? "Uncategorized"}</span>
                            {product.variants.length ? (
                              <span className="inline-flex shrink-0 items-center gap-1">
                                · <Layers className="size-3" /> {product.variants.length} variants
                              </span>
                            ) : null}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">
                      {hasDiscount ? (
                        <div className="flex flex-col items-end">
                          <span className="font-medium">{formatMoney(product.discountPrice!, currency)}</span>
                          <span className="text-xs text-muted-foreground line-through">{formatMoney(product.price, currency)}</span>
                        </div>
                      ) : (
                        formatMoney(product.price, currency)
                      )}
                    </TableCell>
                    <TableCell>
                      {state === "untracked" ? (
                        <span className="text-xs text-muted-foreground">Not tracked</span>
                      ) : (
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          {state !== "out" ? <span className="tabular-nums">{product.stock}</span> : null}
                          <StockBadge state={state} />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <StatusBadge status={product.status} />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${product.name}`} />}>
                          <MoreHorizontal className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => router.push(`/dashboard/products/${product.id}`)}>Edit</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setStockFor(product)}>Update stock</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => toggle(product)}>{product.status === "active" ? "Disable" : "Enable"}</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(product)}>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!products.length ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    {query.trim() ? `No products match “${query.trim()}”.` : "No products in this view."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}

      <StockDialog
        key={stockFor?.id ?? "none"}
        product={stockFor}
        onClose={() => setStockFor(null)}
        onSaved={() => {
          setStockFor(null);
          router.refresh();
        }}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && !busy && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The assistant will stop offering this product and it is removed from open carts. Past orders keep their details.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={busy} onClick={remove}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function StockDialog({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => void }) {
  const [stock, setStock] = useState(String(product?.stock ?? 0));
  const [variantStock, setVariantStock] = useState<Record<string, string>>(() =>
    Object.fromEntries((product?.variants ?? []).map((v) => [v.id, String(v.stock)])),
  );
  const [saving, setSaving] = useState(false);
  const variants = product?.variants ?? [];
  const total = variants.reduce((sum, v) => sum + (Number(variantStock[v.id]) || 0), 0);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!product) return;
    const body = variants.length
      ? { variants: variants.map((v) => ({ id: v.id, stock: Number(variantStock[v.id] || 0) })) }
      : { stock: Number(stock || 0) };
    setSaving(true);
    try {
      await api(`/api/products/${product.id}/stock`, { method: "PUT", body });
      toast.success("Stock updated");
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={product !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Update stock</DialogTitle>
            <DialogDescription>
              {product?.name}
              {product && !product.trackStock ? " — stock isn't tracked for this product, so it's always shown as available." : null}
            </DialogDescription>
          </DialogHeader>
          {variants.length ? (
            <div className="max-h-80 overflow-y-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Variant</th>
                    <th className="w-28 px-3 py-2 font-medium">In stock</th>
                  </tr>
                </thead>
                <tbody>
                  {variants.map((v) => (
                    <tr key={v.id} className="border-t">
                      <td className="px-3 py-1.5">
                        <span className={cn(!v.active && "text-muted-foreground line-through")}>{Object.values(v.optionValues).join(" / ")}</span>
                        <span className="sr-only">{variantLabel(v.optionValues)}</span>
                      </td>
                      <td className="px-3 py-1.5">
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          aria-label={`Stock for ${variantLabel(v.optionValues)}`}
                          value={variantStock[v.id] ?? ""}
                          onChange={(e) => setVariantStock((s) => ({ ...s, [v.id]: e.target.value }))}
                          className="h-7 tabular-nums"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/40 text-xs">
                    <td className="px-3 py-2 font-medium">Total</td>
                    <td className="px-3 py-2 font-medium tabular-nums">{total}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <label htmlFor="quick-stock" className="text-sm font-medium">
                Quantity in stock
              </label>
              <Input
                id="quick-stock"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                required
                autoFocus
                value={stock}
                onChange={(e) => setStock(e.target.value)}
                className="tabular-nums"
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Save stock
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
