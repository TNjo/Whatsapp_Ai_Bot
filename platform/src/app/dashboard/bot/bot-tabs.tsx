"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, FlaskConical, ListChecks, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/dashboard/bot", label: "Settings", icon: SlidersHorizontal },
  { href: "/dashboard/bot/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/dashboard/bot/order-form", label: "Order form", icon: ListChecks },
  { href: "/dashboard/bot/test", label: "Test bot", icon: FlaskConical },
] as const;

/** Sub-navigation shared by every page under /dashboard/bot. */
export function BotTabs({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Bot sections" className={cn("-mt-2 mb-6 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none]", className)}>
      <div className="flex min-w-max gap-1">
        {TABS.map((tab) => {
          const active =
            tab.href === "/dashboard/bot" ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex items-center gap-2 px-3 pt-1 pb-2.5 text-sm font-medium transition-colors",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <tab.icon className="size-4" />
              {tab.label}
              {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" aria-hidden /> : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
