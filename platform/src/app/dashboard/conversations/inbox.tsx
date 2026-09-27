"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clock,
  Hand,
  Info,
  Loader2,
  MessageCircle,
  PanelRight,
  RotateCcw,
  Search,
  Send,
  ShoppingBag,
} from "lucide-react";
import { toast } from "sonner";
import { ConversationStatusBadge, EmptyState, NameAvatar, OrderStatusBadge } from "@/components/app/common";
import { MessageList, type ChatMessage } from "@/components/app/chat";
import { NativeSelect } from "@/components/app/controls";
import { useRealtime } from "@/components/app/realtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api-client";
import { formatDateTime, formatMoney, formatPhone, relativeTime } from "@/lib/format";
import type { OrderStatus } from "@/lib/order-status";
import { cn } from "@/lib/utils";

type ListItem = {
  id: string;
  status: "active" | "human_required" | "resolved";
  aiEnabled: boolean;
  unreadCount: number;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastInboundAt: string | null;
  handoffReason: string | null;
  customerId: string;
  displayName: string;
  phone: string;
  windowOpen: boolean;
};

type Detail = {
  conversation: { id: string; status: ListItem["status"]; aiEnabled: boolean; handoffReason: string | null; isTest: boolean };
  customer: { id: string; displayName: string; profileName: string; phone: string; address: string; city: string; totalOrders: number; totalSpent: number; notes: string };
  messages: ChatMessage[];
  orders: { id: string; orderNumber: string; status: OrderStatus; total: number; currency: string; createdAt: string }[];
  draftOrder: { stage: string; items: { name: string; quantity: number; options: Record<string, string>; lineTotal: number }[]; total: number; currency: string; missing: string[] } | null;
  windowOpen: boolean;
  windowClosesAt: string | null;
  templates: { id: string; name: string; language: string; body: string; variables: string[] }[];
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "human", label: "Needs human" },
  { key: "unread", label: "Unread" },
  { key: "resolved", label: "Resolved" },
] as const;

export function Inbox({
  initialList,
  initialSelected,
  timeZone,
  currency,
}: {
  initialList: ListItem[];
  initialSelected: string | null;
  timeZone: string;
  currency: string;
}) {
  const router = useRouter();
  const [list, setList] = useState(initialList);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(Boolean(initialSelected));
  const [showInfo, setShowInfo] = useState(true);
  const [mobileThread, setMobileThread] = useState(Boolean(initialSelected && initialList.length));
  const threadRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const loadList = useCallback(async () => {
    const sp = new URLSearchParams({ filter, q: query });
    const data = await api<{ conversations: ListItem[] }>(`/api/conversations?${sp}`);
    setList(data.conversations);
  }, [filter, query]);

  const loadDetail = useCallback(
    (id: string) =>
      api<Detail>(`/api/conversations/${id}`)
        .then(
          (data) => {
            setDetail(data);
            // Opening a chat marks it read on the server; mirror that in the list.
            setList((items) => items.map((item) => (item.id === id ? { ...item, unreadCount: 0 } : item)));
          },
          (err) => toast.error(errorMessage(err)),
        )
        .finally(() => setLoadingDetail(false)),
    [],
  );

  useEffect(() => {
    const timer = setTimeout(() => void loadList().catch(() => undefined), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [loadList, query]);

  useEffect(() => {
    if (!selected) return;
    stickToBottom.current = true;
    void loadDetail(selected);
    const url = new URL(window.location.href);
    url.searchParams.set("c", selected);
    window.history.replaceState(null, "", url);
  }, [selected, loadDetail]);

  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [detail?.messages]);

  useRealtime((event) => {
    if (event.type === "conversation.updated" || event.type === "message.created" || event.type === "message.status") {
      void loadList().catch(() => undefined);
      if (selected && "conversationId" in event && event.conversationId === selected) {
        const el = threadRef.current;
        stickToBottom.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        void loadDetail(selected);
      }
    }
    if ((event.type === "order.created" || event.type === "order.updated") && selected) void loadDetail(selected);
  });

  const patch = async (body: { aiEnabled?: boolean; status?: "active" | "resolved" }, message: string) => {
    if (!selected) return;
    try {
      await api(`/api/conversations/${selected}`, { method: "PATCH", body });
      toast.success(message);
      await Promise.all([loadDetail(selected), loadList()]);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const current = list.find((c) => c.id === selected);

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100dvh-3.5rem)] overflow-hidden border-t bg-card lg:-mx-8 lg:-my-8">
      {/* Conversation list */}
      <aside className={cn("flex w-full shrink-0 flex-col border-r md:w-80", mobileThread && "hidden md:flex")}>
        <div className="border-b p-3">
          <div className="mb-3 flex items-center justify-between">
            <h1 className="text-lg font-semibold">Conversations</h1>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, number or message" className="pl-8" />
          </div>
          <div className="mt-2 flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted",
                  filter === f.key && "bg-primary/10 text-primary hover:bg-primary/15",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {list.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">{query ? "No conversations match." : "No conversations yet."}</p>
          ) : (
            list.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (item.id !== selected) {
                    setDetail(null);
                    setLoadingDetail(true);
                  }
                  setSelected(item.id);
                  setMobileThread(true);
                }}
                className={cn(
                  "flex w-full gap-3 border-b px-3 py-3 text-left transition-colors hover:bg-muted/60",
                  selected === item.id && "bg-primary/5 hover:bg-primary/10",
                )}
              >
                <NameAvatar name={item.displayName} className="size-10" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className={cn("flex-1 truncate text-sm", item.unreadCount ? "font-semibold" : "font-medium")}>{item.displayName}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(item.lastMessageAt)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className="flex-1 truncate text-xs text-muted-foreground">{item.lastMessagePreview || "No messages"}</span>
                    {item.unreadCount ? (
                      <span className="min-w-5 rounded-full bg-primary px-1.5 text-center text-[11px] font-semibold text-primary-foreground">{item.unreadCount}</span>
                    ) : null}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5">
                    {item.status === "human_required" ? (
                      <span className="inline-flex items-center gap-1 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">
                        <Hand className="size-3" /> Needs human
                      </span>
                    ) : null}
                    {!item.aiEnabled && item.status !== "human_required" ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">AI paused</span>
                    ) : null}
                    {item.status === "resolved" ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">Resolved</span>
                    ) : null}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Thread */}
      <section className={cn("flex min-w-0 flex-1 flex-col", !mobileThread && "hidden md:flex")}>
        {!selected || !current ? (
          <div className="grid flex-1 place-items-center p-6">
            <EmptyState
              icon={MessageCircle}
              title={list.length ? "Select a conversation" : "No conversations yet"}
              description={list.length ? "Pick a chat on the left to read and reply." : "When customers message your WhatsApp number, their chats appear here in real time."}
              className="border-0"
            />
          </div>
        ) : (
          <>
            <header className="flex items-center gap-3 border-b px-4 py-2.5">
              <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setMobileThread(false)} aria-label="Back">
                <ArrowLeft className="size-4" />
              </Button>
              <NameAvatar name={current.displayName} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{current.displayName}</p>
                <p className="truncate text-xs text-muted-foreground">{current.phone ? formatPhone(current.phone) : "Test chat"}</p>
              </div>
              <label className="hidden items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium sm:flex" title="When on, the assistant replies automatically">
                <Bot className="size-3.5" /> AI
                <Switch
                  size="sm"
                  checked={detail?.conversation.aiEnabled ?? current.aiEnabled}
                  onCheckedChange={(checked) => patch({ aiEnabled: checked }, checked ? "AI resumed for this conversation" : "AI paused for this conversation")}
                />
              </label>
              {(detail?.conversation.status ?? current.status) !== "resolved" ? (
                <Button variant="outline" size="sm" onClick={() => patch({ status: "resolved" }, "Marked as resolved")}>
                  <CheckCircle2 className="size-4" /> <span className="hidden sm:inline">Resolve</span>
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => patch({ status: "active" }, "Conversation reopened")}>
                  <RotateCcw className="size-4" /> <span className="hidden sm:inline">Reopen</span>
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" className="hidden xl:inline-flex" onClick={() => setShowInfo((v) => !v)} aria-label="Toggle details">
                <PanelRight className="size-4" />
              </Button>
            </header>

            {detail?.conversation.status === "human_required" ? (
              <div className="flex items-center gap-3 border-b bg-rose-50 px-4 py-2 text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
                <Hand className="size-4 shrink-0" />
                <span className="flex-1">
                  <strong>Human support required.</strong> {detail.conversation.handoffReason}
                </span>
                <Button size="sm" variant="outline" onClick={() => patch({ aiEnabled: true }, "AI resumed")}>
                  Resume AI
                </Button>
              </div>
            ) : detail && !detail.conversation.aiEnabled ? (
              <div className="flex items-center gap-3 border-b bg-muted px-4 py-2 text-sm text-muted-foreground">
                <Bot className="size-4 shrink-0" />
                <span className="flex-1">AI paused for this conversation. You&apos;re handling it.</span>
                <Button size="sm" variant="outline" onClick={() => patch({ aiEnabled: true }, "AI resumed")}>
                  Resume AI
                </Button>
              </div>
            ) : null}

            <div
              ref={threadRef}
              className="chat-wallpaper flex flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-4 scrollbar-thin"
              onScroll={(e) => {
                const el = e.currentTarget;
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
              }}
            >
              {loadingDetail && !detail ? (
                <div className="grid flex-1 place-items-center text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : detail ? (
                <MessageList messages={detail.messages} timeZone={timeZone} />
              ) : null}
            </div>

            {detail ? <Composer detail={detail} onSent={() => loadDetail(detail.conversation.id)} /> : null}
          </>
        )}
      </section>

      {/* Details */}
      {selected && detail && showInfo ? (
        <aside className="hidden w-80 shrink-0 flex-col gap-5 overflow-y-auto border-l p-4 scrollbar-thin xl:flex">
          <div className="flex flex-col items-center text-center">
            <NameAvatar name={current?.displayName ?? "Customer"} className="size-14 text-base" />
            <p className="mt-2 font-semibold">{current?.displayName}</p>
            {detail.customer.phone ? <p className="text-sm text-muted-foreground">{formatPhone(detail.customer.phone)}</p> : null}
            <div className="mt-2">
              <ConversationStatusBadge status={detail.conversation.status} />
            </div>
            <Link href={`/dashboard/customers/${detail.customer.id}`} className="mt-3 text-sm font-medium text-primary hover:underline">
              View customer profile
            </Link>
          </div>

          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded-lg bg-muted/60 p-2.5">
              <p className="text-lg font-semibold tabular-nums">{detail.customer.totalOrders}</p>
              <p className="text-[11px] text-muted-foreground">Orders</p>
            </div>
            <div className="rounded-lg bg-muted/60 p-2.5">
              <p className="text-sm font-semibold tabular-nums">{formatMoney(detail.customer.totalSpent, currency)}</p>
              <p className="text-[11px] text-muted-foreground">Spent</p>
            </div>
          </div>

          {detail.draftOrder ? (
            <div className="rounded-lg border border-dashed p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase">
                <ShoppingBag className="size-3.5" /> Draft order · {detail.draftOrder.stage.replaceAll("_", " ").toLowerCase()}
              </p>
              {detail.draftOrder.items.length ? (
                <ul className="space-y-1 text-sm">
                  {detail.draftOrder.items.map((item, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate">
                        {item.name} × {item.quantity}
                        {Object.values(item.options).length ? <span className="text-muted-foreground"> ({Object.values(item.options).join(", ")})</span> : null}
                      </span>
                      <span className="tabular-nums">{formatMoney(item.lineTotal, detail.draftOrder!.currency)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Browsing — no items yet.</p>
              )}
              {detail.draftOrder.missing.length ? (
                <p className="mt-2 text-xs text-muted-foreground">Still needed: {detail.draftOrder.missing.join(", ")}</p>
              ) : null}
            </div>
          ) : null}

          <div>
            <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase">Orders</p>
            {detail.orders.length ? (
              <ul className="space-y-1.5">
                {detail.orders.map((order) => (
                  <li key={order.id}>
                    <Link href={`/dashboard/orders/${order.id}`} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted/50">
                      <span>
                        <span className="font-medium">#{order.orderNumber}</span>
                        <span className="block text-[11px] text-muted-foreground">{formatDateTime(order.createdAt, timeZone)}</span>
                      </span>
                      <OrderStatusBadge status={order.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No orders yet.</p>
            )}
          </div>

          {detail.customer.address ? (
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground uppercase">Saved address</p>
              <p className="text-sm">{[detail.customer.address, detail.customer.city].filter(Boolean).join(", ")}</p>
            </div>
          ) : null}
          {detail.customer.notes ? (
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground uppercase">Notes</p>
              <p className="text-sm whitespace-pre-wrap">{detail.customer.notes}</p>
            </div>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

function Composer({ detail, onSent }: { detail: Detail; onSent: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [variables, setVariables] = useState<string[]>([]);
  const template = detail.templates.find((t) => t.id === templateId);

  const send = async () => {
    if (sending) return;
    const body = detail.windowOpen ? { text } : { templateId, variables };
    if (detail.windowOpen && !text.trim()) return;
    if (!detail.windowOpen && !templateId) return;
    setSending(true);
    try {
      const result = await api<{ ok: boolean; error?: string; aiPaused: boolean }>(`/api/conversations/${detail.conversation.id}/messages`, { body });
      setText("");
      if (result.aiPaused) toast.info("AI paused for this conversation", { description: "Resume it when you're done." });
      onSent();
    } catch (err) {
      toast.error(errorMessage(err));
      onSent();
    } finally {
      setSending(false);
    }
  };

  if (!detail.windowOpen) {
    return (
      <div className="border-t bg-card p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5" />
          The 24-hour reply window closed. WhatsApp only allows approved templates until the customer writes again.
        </p>
        {detail.templates.length ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <NativeSelect
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                const t = detail.templates.find((x) => x.id === e.target.value);
                setVariables(t ? t.variables.map(() => "") : []);
              }}
              className="sm:w-56"
            >
              <option value="">Choose a template…</option>
              {detail.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language})
                </option>
              ))}
            </NativeSelect>
            {template?.variables.map((name, i) => (
              <Input
                key={name + i}
                placeholder={name}
                value={variables[i] ?? ""}
                onChange={(e) => setVariables((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
                className="sm:w-36"
              />
            ))}
            <Button onClick={send} disabled={!templateId || sending}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Send template
            </Button>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-sm">
            <Info className="size-4 text-muted-foreground" /> No approved templates yet.{" "}
            <Link href="/dashboard/whatsapp?tab=templates" className="font-medium text-primary hover:underline">
              Manage templates
            </Link>
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="flex items-end gap-2 border-t bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        rows={1}
        placeholder={detail.conversation.aiEnabled ? "Reply as your business (this pauses the AI)" : "Type a reply…"}
        className="max-h-40 min-h-10 resize-none rounded-2xl bg-muted/50"
      />
      <Button type="submit" size="icon-lg" className="size-10 shrink-0 rounded-full" disabled={!text.trim() || sending} aria-label="Send">
        {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
      </Button>
    </form>
  );
}
