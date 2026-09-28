"use client";

import Link from "next/link";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Bot, Loader2, RotateCcw, Send, ShoppingBag, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { DaySeparator, MessageBubble, startsNewDay, type ChatMessage } from "@/components/app/chat";
import { OrderStatusBadge } from "@/components/app/common";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api-client";
import { formatMoney } from "@/lib/format";
import type { OrderStatus } from "@/lib/order-status";
import { cn } from "@/lib/utils";

type Chat = {
  conversation: { id: string; aiEnabled: boolean; status: string; handoffReason: string | null };
  messages: ChatMessage[];
  orders: { id: string; orderNumber: string; status: OrderStatus; total: number; currency: string; createdAt: string }[];
  draftOrder: { stage: string; items: { name: string; quantity: number; options: Record<string, string>; lineTotal: number }[]; total: number; currency: string; missing: string[] } | null;
};

const STAGES = ["BROWSING", "PRODUCT_SELECTED", "COLLECTING_INFORMATION", "ORDER_REVIEW", "CUSTOMER_CONFIRMATION"];
const SUGGESTIONS = ["Hi", "Do you have black t-shirts?", "I want 2 in size L", "Where is my order?", "Do you deliver islandwide?"];

export function TestBot({
  initial,
  timeZone,
  botName,
  aiReady,
  aiEnabled,
  aiLabel,
  testCreatesOrders,
}: {
  initial: Chat;
  timeZone: string;
  botName: string;
  aiReady: boolean;
  aiEnabled: boolean;
  aiLabel: string | null;
  testCreatesOrders: boolean;
  productCount: number | null;
}) {
  const [chat, setChat] = useState<Chat>(initial);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<ChatMessage | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [chat.messages, pending]);

  const send = async (body: { text?: string; replyId?: string; replyTitle?: string }) => {
    if (pending) return;
    const optimistic: ChatMessage = {
      id: "pending",
      conversationId: chat.conversation.id,
      direction: "inbound",
      sender: "customer",
      type: body.replyId ? "interactive" : "text",
      content: body.text ?? body.replyTitle ?? "",
      payload: body.replyId ? { interactive: { kind: "reply", replyId: body.replyId } } : {},
      status: "received",
      errorMessage: null,
      createdAt: new Date().toISOString(),
    };
    setPending(optimistic);
    setText("");
    try {
      setChat(await api<Chat>("/api/bot/test", { body }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(null);
    }
  };

  const reset = async () => {
    try {
      setChat(await api<Chat>("/api/bot/test", { method: "DELETE" }));
      toast.success("Test chat cleared");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const messages = pending ? [...chat.messages, pending] : chat.messages;
  const lastInteractive = [...chat.messages].reverse().find((m) => m.direction === "outbound");
  const draft = chat.draftOrder;
  const stageIndex = draft ? STAGES.indexOf(draft.stage) : -1;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="mx-auto flex h-[calc(100dvh-16rem)] min-h-[520px] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border bg-card shadow-sm">
        <header className="flex items-center gap-3 bg-emerald-700 px-4 py-3 text-white dark:bg-emerald-900">
          <span className="grid size-9 place-items-center rounded-full bg-white/20">
            <Bot className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{botName}</p>
            <p className="text-xs text-emerald-100">{pending ? "typing…" : "Test chat · not sent on WhatsApp"}</p>
          </div>
          <Button variant="ghost" size="sm" className="text-white hover:bg-white/15 hover:text-white" onClick={reset} disabled={Boolean(pending)}>
            <RotateCcw className="size-4" /> Reset
          </Button>
        </header>

        {!aiReady || !aiEnabled ? (
          <div className="flex items-start gap-2 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {!aiEnabled ? "The AI assistant is turned off, so it won't reply. " : "No AI API key is configured, so the bot will hand every chat to your team. "}
              <Link href="/dashboard/bot" className="font-medium underline">
                Open bot settings
              </Link>
            </span>
          </div>
        ) : null}
        {chat.conversation.status === "human_required" ? (
          <div className="border-b bg-rose-50 px-4 py-2 text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
            Handed to a human: {chat.conversation.handoffReason}. Reset the chat to test again.
          </div>
        ) : null}

        <div ref={scroller} className="chat-wallpaper flex flex-1 flex-col gap-1.5 overflow-y-auto p-4 scrollbar-thin">
          {messages.length === 0 ? (
            <div className="m-auto max-w-sm text-center">
              <span className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-card shadow-xs">
                <Sparkles className="size-5 text-primary" />
              </span>
              <p className="font-medium">Say hi to your assistant</p>
              <p className="mt-1 text-sm text-muted-foreground">Try a product question, place an order, then ask where it is.</p>
            </div>
          ) : (
            messages.map((message, index) => {
              const separator = startsNewDay(messages, index);
              const tappable = message.id === lastInteractive?.id && message.payload.interactive && !pending;
              return (
                <Fragment key={message.id}>
                  {separator ? <DaySeparator date={message.createdAt} timeZone={timeZone} /> : null}
                  <MessageBubble message={message} timeZone={timeZone} />
                  {tappable && message.payload.interactive?.kind === "buttons" ? (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {message.payload.interactive.buttons?.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => send({ replyId: b.id, replyTitle: b.title })}
                          className="rounded-full border border-sky-300 bg-card px-3 py-1 text-xs font-semibold text-sky-700 shadow-xs hover:bg-sky-50 dark:border-sky-700 dark:text-sky-300 dark:hover:bg-sky-950"
                        >
                          {b.title}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {tappable && message.payload.interactive?.kind === "list" ? (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {message.payload.interactive.sections?.flatMap((s) => s.rows).map((row) => (
                        <button
                          key={row.id}
                          type="button"
                          onClick={() => send({ replyId: row.id, replyTitle: row.title })}
                          className="rounded-full border border-sky-300 bg-card px-3 py-1 text-xs font-semibold text-sky-700 shadow-xs hover:bg-sky-50 dark:border-sky-700 dark:text-sky-300 dark:hover:bg-sky-950"
                        >
                          {row.title}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </Fragment>
              );
            })
          )}
          {pending ? (
            <div className="flex justify-end">
              <span className="flex items-center gap-1 rounded-xl bg-card px-3 py-2 text-xs text-muted-foreground shadow-xs">
                <Loader2 className="size-3 animate-spin" /> {botName} is replying…
              </span>
            </div>
          ) : null}
        </div>

        {messages.length === 0 ? (
          <div className="flex flex-wrap gap-1.5 border-t px-3 pt-3">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" onClick={() => send({ text: s })} className="rounded-full border px-3 py-1 text-xs hover:bg-muted">
                {s}
              </button>
            ))}
          </div>
        ) : null}
        <form
          className="flex items-center gap-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void send({ text: text.trim() });
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message as a customer…" className="h-10 rounded-full bg-muted/50 px-4" />
          <Button type="submit" size="icon-lg" className="size-10 shrink-0 rounded-full" disabled={!text.trim() || Boolean(pending)} aria-label="Send">
            <Send className="size-4" />
          </Button>
        </form>
      </div>

      <aside className="flex flex-col gap-4">
        <div className="rounded-xl border bg-card p-4 shadow-xs">
          <p className="text-sm font-semibold">Order state</p>
          <p className="mb-3 text-xs text-muted-foreground">Tracked in the database, not in the AI&apos;s memory.</p>
          <ol className="grid gap-2">
            {[...STAGES, "PENDING"].map((stage, i) => {
              const done = draft ? i < stageIndex : false;
              const current = draft ? i === stageIndex : i === 0;
              return (
                <li key={stage} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "grid size-5 place-items-center rounded-full border text-[10px] font-semibold",
                      done && "border-emerald-500 bg-emerald-500 text-white",
                      current && "border-primary text-primary",
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className={cn("font-medium", !done && !current && "text-muted-foreground")}>{stage.replaceAll("_", " ")}</span>
                </li>
              );
            })}
          </ol>
          {draft?.items.length ? (
            <div className="mt-4 border-t pt-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase">
                <ShoppingBag className="size-3.5" /> Draft order
              </p>
              <ul className="space-y-1 text-sm">
                {draft.items.map((item, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate">
                      {item.name} × {item.quantity}
                      {Object.values(item.options).length ? <span className="text-muted-foreground"> ({Object.values(item.options).join(", ")})</span> : null}
                    </span>
                    <span className="tabular-nums">{formatMoney(item.lineTotal, draft.currency)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 flex justify-between border-t pt-2 text-sm font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{formatMoney(draft.total, draft.currency)}</span>
              </p>
              {draft.missing.length ? <p className="mt-2 text-xs text-muted-foreground">Still asking for: {draft.missing.join(", ")}</p> : null}
            </div>
          ) : null}
        </div>

        {chat.orders.length ? (
          <div className="rounded-xl border bg-card p-4 shadow-xs">
            <p className="mb-2 text-sm font-semibold">Orders from this chat</p>
            <ul className="space-y-1.5">
              {chat.orders.map((order) => (
                <li key={order.id}>
                  <Link href={`/dashboard/orders/${order.id}`} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-muted/50">
                    <span className="font-medium">#{order.orderNumber}</span>
                    <OrderStatusBadge status={order.status} />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">Change an order&apos;s status to see the customer notification appear here.</p>
          </div>
        ) : null}

        <div className="rounded-xl border bg-card p-4 text-sm shadow-xs">
          <p className="font-semibold">Test settings</p>
          <dl className="mt-2 grid gap-1.5 text-muted-foreground">
            <div className="flex justify-between gap-2">
              <dt>AI</dt>
              <dd className="truncate text-right text-foreground">{aiLabel ?? "Not configured"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Orders from tests</dt>
              <dd className="text-right text-foreground">{testCreatesOrders ? "Real orders" : "Marked TEST"}</dd>
            </div>
          </dl>
          <Link href="/dashboard/bot" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-3 w-full")}>
            Bot settings
          </Link>
        </div>
      </aside>
    </div>
  );
}
