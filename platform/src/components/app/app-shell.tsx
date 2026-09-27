"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useTheme } from "next-themes";
import {
  Bell,
  Bot,
  Boxes,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  Moon,
  Package,
  Scissors,
  Settings,
  ShoppingBag,
  Smartphone,
  Sun,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api-client";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NameAvatar } from "./common";
import { RealtimeProvider, useRealtime, useRealtimeConnected } from "./realtime";

type Counts = { pendingOrders: number; humanRequired: number; unreadNotifications: number; whatsappStatus: string };
type ShellProps = {
  user: { name: string; email: string };
  business: { name: string };
  role: "owner" | "staff";
  counts: Counts;
  children: React.ReactNode;
};

type NavItem = { href: string; label: string; icon: typeof Bell; badge?: (c: Counts) => number; match?: string[] };

const NAV: { heading?: string; items: NavItem[] }[] = [
  {
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/dashboard/conversations", label: "Conversations", icon: MessageCircle, badge: (c) => c.humanRequired },
      { href: "/dashboard/orders", label: "Orders", icon: ShoppingBag, badge: (c) => c.pendingOrders },
      { href: "/dashboard/customers", label: "Customers", icon: Users },
    ],
  },
  {
    heading: "Catalog",
    items: [
      { href: "/dashboard/products", label: "Products", icon: Package },
      { href: "/dashboard/services", label: "Services", icon: Scissors },
    ],
  },
  {
    heading: "Assistant",
    items: [
      { href: "/dashboard/bot", label: "Bot", icon: Bot },
      { href: "/dashboard/whatsapp", label: "WhatsApp", icon: Smartphone },
      { href: "/dashboard/settings", label: "Settings", icon: Settings },
    ],
  },
];

function isActive(pathname: string, href: string) {
  return href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function Brand({ business }: { business: string }) {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 px-2">
      <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <MessageCircle className="size-4 fill-current" />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block text-sm font-semibold">Chatdesk</span>
        <span className="block truncate text-xs text-muted-foreground">{business}</span>
      </span>
    </Link>
  );
}

function SidebarNav({ counts, onNavigate }: { counts: Counts; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-5">
      {NAV.map((group, index) => (
        <div key={index} className="flex flex-col gap-0.5">
          {group.heading ? (
            <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{group.heading}</p>
          ) : null}
          {group.items.map((item) => {
            const active = isActive(pathname, item.href);
            const badge = item.badge?.(counts) ?? 0;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className="size-4" />
                <span className="flex-1">{item.label}</span>
                {item.href === "/dashboard/whatsapp" ? (
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      counts.whatsappStatus === "connected" ? "bg-emerald-500" : counts.whatsappStatus === "error" ? "bg-rose-500" : "bg-zinc-300 dark:bg-zinc-600",
                    )}
                    title={`WhatsApp ${counts.whatsappStatus}`}
                  />
                ) : badge > 0 ? (
                  <span className="min-w-5 rounded-full bg-primary px-1.5 text-center text-[11px] font-semibold text-primary-foreground tabular-nums">
                    {badge > 99 ? "99+" : badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

type NotificationRow = { id: string; type: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string };

function NotificationsBell({ unread, onCounts }: { unread: number; onCounts: (c: Counts) => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[] | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    const data = await api<{ notifications: NotificationRow[]; counts: Counts }>("/api/notifications");
    setItems(data.notifications);
    onCounts(data.counts);
  }, [onCounts]);


  const markAll = async () => {
    await api("/api/notifications/read", { body: { all: true } });
    await load();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
    >
      <PopoverTrigger render={<Button variant="ghost" size="icon" aria-label="Notifications" className="relative" />}>
        <Bell className="size-4" />
        {unread > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-rose-500 px-1 text-[10px] leading-4 font-semibold text-white tabular-nums">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-semibold">Notifications</p>
          <Button variant="ghost" size="sm" onClick={markAll} disabled={!unread}>
            Mark all read
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto scrollbar-thin">
          {!items ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : !items.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">You&apos;re all caught up.</p>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={async () => {
                  if (!item.readAt) await api("/api/notifications/read", { body: { ids: [item.id] } }).catch(() => undefined);
                  setOpen(false);
                  if (item.link) router.push(item.link);
                  void load();
                }}
                className="flex w-full gap-3 border-b px-4 py-3 text-left last:border-0 hover:bg-muted/60"
              >
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", item.readAt ? "bg-transparent" : "bg-primary")} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.title}</span>
                  {item.body ? <span className="line-clamp-2 block text-xs text-muted-foreground">{item.body}</span> : null}
                  <span className="mt-1 block text-[11px] text-muted-foreground">{relativeTime(item.createdAt)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <Sun className="size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
    </Button>
  );
}

function LiveDot() {
  const connected = useRealtimeConnected();
  return (
    <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex" title={connected ? "Live updates on" : "Reconnecting…"}>
      <span className={cn("size-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500")} />
      {connected ? "Live" : "Reconnecting"}
    </span>
  );
}

function ShellInner({ user, business, role, counts: initialCounts, children }: ShellProps) {
  const [counts, setCounts] = useState(initialCounts);
  const [seenInitial, setSeenInitial] = useState(initialCounts);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Server re-renders (router.refresh) bring fresh counts: adopt them during render.
  if (seenInitial !== initialCounts) {
    setSeenInitial(initialCounts);
    setCounts(initialCounts);
  }
  const router = useRouter();
  const onCounts = useCallback((c: Counts) => setCounts(c), []);

  useRealtime((event) => {
    if (["order.created", "order.updated", "conversation.updated", "notification.created", "whatsapp.updated"].includes(event.type)) {
      api<{ counts: Counts }>("/api/notifications")
        .then((data) => setCounts(data.counts))
        .catch(() => undefined);
    }
  });

  const logout = async () => {
    await api("/api/auth/logout", { body: {} }).catch(() => undefined);
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col gap-6 border-r bg-sidebar px-3 py-4 lg:flex">
        <Brand business={business.name} />
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <SidebarNav counts={counts} />
        </div>
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 gap-6 p-4">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Brand business={business.name} />
          <SidebarNav counts={counts} onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur supports-backdrop-filter:bg-background/70 lg:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
            <Menu className="size-4" />
          </Button>
          <div className="flex-1" />
          <LiveDot />
          <ThemeToggle />
          <NotificationsBell unread={counts.unreadNotifications} onCounts={onCounts} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" className="h-9 gap-2 px-1.5" />}>
              <NameAvatar name={user.name} className="size-7 text-[10px]" />
              <span className="hidden text-sm font-medium sm:inline">{user.name}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <span className="block text-sm font-medium text-foreground">{user.name}</span>
                <span className="block text-xs">{user.email}</span>
                <span className="mt-1 block text-xs capitalize">{role}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push("/dashboard/settings")}>
                <Settings className="size-4" /> Settings
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push("/dashboard/bot/test")}>
                <Boxes className="size-4" /> Test the bot
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout} variant="destructive">
                <LogOut className="size-4" /> Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

export function AppShell(props: ShellProps) {
  return (
    <RealtimeProvider>
      <ShellInner {...props} />
    </RealtimeProvider>
  );
}
