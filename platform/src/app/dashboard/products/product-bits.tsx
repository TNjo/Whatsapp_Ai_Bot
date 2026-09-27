import { ImageIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type ProductVariantRow = {
  id: string;
  optionValues: Record<string, string>;
  price: number | null;
  stock: number;
  sku: string;
  active: boolean;
};

export type StockState = "untracked" | "out" | "low" | "ok";

export function stockState(product: { trackStock: boolean; stock: number }, lowStockThreshold: number): StockState {
  if (!product.trackStock) return "untracked";
  if (product.stock <= 0) return "out";
  if (product.stock <= lowStockThreshold) return "low";
  return "ok";
}

export function ProductThumb({ src, name, className }: { src?: string; name: string; className?: string }) {
  return (
    <span className={cn("grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border bg-muted text-muted-foreground", className)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} className="size-full object-cover" loading="lazy" />
      ) : (
        <ImageIcon className="size-4" aria-hidden />
      )}
    </span>
  );
}

export function StatusBadge({ status }: { status: "active" | "disabled" }) {
  return status === "active" ? (
    <Badge className="border-0 bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">Active</Badge>
  ) : (
    <Badge variant="secondary">Disabled</Badge>
  );
}

export function StockBadge({ state }: { state: StockState }) {
  if (state === "out") {
    return <Badge className="border-0 bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300">Out of stock</Badge>;
  }
  if (state === "low") {
    return <Badge className="border-0 bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">Low</Badge>;
  }
  return null;
}
