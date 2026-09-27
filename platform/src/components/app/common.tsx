import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";
import { STATUS_LABEL, type OrderStatus } from "@/lib/order-status";

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

const ORDER_TONE: Record<OrderStatus, string> = {
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  CONFIRMED: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
  PROCESSING: "bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300",
  READY: "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300",
  DISPATCHED: "bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300",
  DELIVERED: "bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300",
  COMPLETED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  CANCELLED: "bg-zinc-200 text-zinc-700 dark:bg-zinc-500/20 dark:text-zinc-300",
  REJECTED: "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300",
};

export function OrderStatusBadge({ status, className }: { status: OrderStatus; className?: string }) {
  return (
    <Badge variant="secondary" className={cn("gap-1.5 border-0 font-medium", ORDER_TONE[status], className)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

const CONVERSATION_TONE = {
  active: { label: "Active", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
  human_required: { label: "Needs a human", className: "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300" },
  resolved: { label: "Resolved", className: "bg-zinc-200 text-zinc-700 dark:bg-zinc-500/20 dark:text-zinc-300" },
} as const;

export function ConversationStatusBadge({ status }: { status: keyof typeof CONVERSATION_TONE }) {
  const tone = CONVERSATION_TONE[status];
  return (
    <Badge variant="secondary" className={cn("border-0 font-medium", tone.className)}>
      {tone.label}
    </Badge>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center", className)}>
      <div className="mb-3 grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <p className="font-medium">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

function hue(value: string) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (Math.imul(h, 31) + value.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** Initials avatar with a stable per-name color. */
export function NameAvatar({ name, className }: { name: string; className?: string }) {
  const h = hue(name || "?");
  return (
    <span
      aria-hidden
      className={cn("grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold", className)}
      style={{ backgroundColor: `oklch(0.93 0.05 ${h})`, color: `oklch(0.4 0.1 ${h})` }}
    >
      {initials(name || "?")}
    </span>
  );
}

export function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  hint?: React.ReactNode;
  tone?: "default" | "warning" | "success" | "info";
}) {
  const toneClass = {
    default: "bg-muted text-muted-foreground",
    warning: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    info: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  }[tone];
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-xs">
      <span className={cn("grid size-10 shrink-0 place-items-center rounded-lg", toneClass)}>
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold tabular-nums tracking-tight">{value}</p>
        {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("rounded-xl border bg-card shadow-xs", className)}>
      {title ? (
        <header className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}
