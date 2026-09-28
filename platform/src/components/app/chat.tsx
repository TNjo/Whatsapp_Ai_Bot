"use client";

import { Fragment } from "react";
import { AlertCircle, Check, CheckCheck, Clock, FileText, List, MapPin, Mic, Sparkles, UserRound, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export type ChatMessage = {
  id: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  sender: "customer" | "ai" | "agent" | "system";
  type: string;
  content: string;
  payload: {
    media?: { id: string; mimeType?: string; filename?: string; caption?: string; link?: string };
    location?: { latitude: number; longitude: number; name?: string; address?: string };
    interactive?: {
      kind: "buttons" | "list" | "reply";
      buttons?: { id: string; title: string }[];
      sections?: { title?: string; rows: { id: string; title: string; description?: string }[] }[];
      buttonText?: string;
      replyId?: string;
    };
    template?: { name: string; language: string; variables: string[] };
  };
  status: string;
  errorMessage: string | null;
  createdAt: string;
};

/** WhatsApp formatting: *bold*, _italic_, ~strike~, ```mono``` — rendered as React nodes (no HTML injection). */
export function WhatsAppText({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|```[^`]+```)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (/^\*[^*]+\*$/.test(part)) return <strong key={i}>{part.slice(1, -1)}</strong>;
        if (/^_[^_]+_$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
        if (/^~[^~]+~$/.test(part)) return <s key={i}>{part.slice(1, -1)}</s>;
        if (/^```[^`]+```$/.test(part)) return <code key={i} className="font-mono text-[0.9em]">{part.slice(3, -3)}</code>;
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

function StatusTick({ status, error }: { status: string; error: string | null }) {
  if (status === "failed")
    return (
      <span title={error ?? "Failed"} className="inline-flex text-rose-600 dark:text-rose-400">
        <AlertCircle className="size-3.5" />
      </span>
    );
  if (status === "pending") return <Clock className="size-3 opacity-60" aria-label="Sending" />;
  if (status === "sent") return <Check className="size-3.5 opacity-70" aria-label="Sent" />;
  if (status === "delivered") return <CheckCheck className="size-3.5 opacity-70" aria-label="Delivered" />;
  if (status === "read") return <CheckCheck className="size-3.5 text-sky-500" aria-label="Read" />;
  return null;
}

const SENDER_LABEL = {
  ai: { text: "Assistant", icon: Sparkles, className: "text-indigo-600 dark:text-indigo-300" },
  agent: { text: "Team", icon: UserRound, className: "text-emerald-700 dark:text-emerald-300" },
  system: { text: "Automatic", icon: Zap, className: "text-emerald-700 dark:text-emerald-300" },
} as const;

export function MessageBubble({ message, timeZone, showSender = true }: { message: ChatMessage; timeZone?: string; showSender?: boolean }) {
  const inbound = message.direction === "inbound";
  const label = !inbound && showSender ? SENDER_LABEL[message.sender as keyof typeof SENDER_LABEL] : null;
  const media = message.payload.media;
  const interactive = message.payload.interactive;
  const imageSrc = inbound ? (media?.id ? `/api/media/${message.conversationId}/${message.id}` : null) : (media?.link ?? null);
  const time = new Date(message.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });

  return (
    <div className={cn("flex w-full", inbound ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "relative max-w-[82%] rounded-xl px-3 py-2 text-sm shadow-xs sm:max-w-[70%]",
          inbound
            ? "rounded-tl-sm bg-card"
            : message.sender === "ai"
              ? "rounded-tr-sm bg-indigo-50 text-indigo-950 dark:bg-indigo-500/20 dark:text-indigo-50"
              : "rounded-tr-sm bg-emerald-100 text-emerald-950 dark:bg-emerald-900/70 dark:text-emerald-50",
          message.status === "failed" && "ring-1 ring-rose-400/60",
        )}
      >
        {label ? (
          <span className={cn("mb-0.5 flex items-center gap-1 text-[11px] font-semibold", label.className)}>
            <label.icon className="size-3" /> {label.text}
          </span>
        ) : null}

        {message.type === "image" && imageSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageSrc} alt={media?.caption || "Image"} className="mb-1 max-h-72 w-full rounded-lg object-cover" loading="lazy" />
        ) : null}
        {message.type === "document" ? (
          <a
            href={inbound ? `/api/media/${message.conversationId}/${message.id}` : (media?.link ?? "#")}
            target="_blank"
            rel="noreferrer"
            className="mb-1 flex items-center gap-2 rounded-lg bg-background/60 px-2.5 py-2 text-xs font-medium hover:underline"
          >
            <FileText className="size-4" /> {media?.filename || "Document"}
          </a>
        ) : null}
        {message.type === "audio" ? (
          inbound && media?.id ? (
            <audio controls src={`/api/media/${message.conversationId}/${message.id}`} className="mb-1 h-9 max-w-full" />
          ) : (
            <span className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Mic className="size-3.5" /> Voice message
            </span>
          )
        ) : null}
        {message.type === "location" && message.payload.location ? (
          <a
            href={`https://www.google.com/maps?q=${message.payload.location.latitude},${message.payload.location.longitude}`}
            target="_blank"
            rel="noreferrer"
            className="mb-1 flex items-center gap-2 rounded-lg bg-background/60 px-2.5 py-2 text-xs font-medium hover:underline"
          >
            <MapPin className="size-4 text-rose-500" /> {message.content || "Shared location"}
          </a>
        ) : null}
        {message.type === "template" ? (
          <span className="mb-1 inline-flex rounded bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase opacity-80">
            Template · {message.payload.template?.name}
          </span>
        ) : null}
        {interactive?.kind === "reply" ? (
          <span className="mb-0.5 block text-[11px] font-medium text-muted-foreground">Tapped a button</span>
        ) : null}

        {message.type !== "location" && message.content ? (
          <p className="break-words whitespace-pre-wrap">
            <WhatsAppText text={interactive && interactive.kind !== "reply" ? stripOptions(message.content, interactive) : message.content} />
          </p>
        ) : message.type === "sticker" ? (
          <p className="text-muted-foreground italic">Sticker</p>
        ) : message.type === "unsupported" ? (
          <p className="text-muted-foreground italic">Unsupported message type</p>
        ) : null}

        {interactive?.kind === "buttons" && interactive.buttons?.length ? (
          <div className="mt-2 flex flex-col gap-1 border-t border-current/10 pt-2">
            {interactive.buttons.map((button) => (
              <span key={button.id} className="rounded-md bg-background/70 py-1.5 text-center text-xs font-semibold text-sky-700 dark:text-sky-300">
                {button.title}
              </span>
            ))}
          </div>
        ) : null}
        {interactive?.kind === "list" ? (
          <div className="mt-2 border-t border-current/10 pt-2">
            <span className="flex items-center justify-center gap-1.5 rounded-md bg-background/70 py-1.5 text-xs font-semibold text-sky-700 dark:text-sky-300">
              <List className="size-3.5" /> {interactive.buttonText || "View options"}
            </span>
            <ul className="mt-1.5 space-y-0.5 text-xs opacity-80">
              {interactive.sections?.flatMap((s) => s.rows).map((row) => (
                <li key={row.id}>• {row.title}{row.description ? ` — ${row.description}` : ""}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <span className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-60">
          {time}
          {!inbound ? <StatusTick status={message.status} error={message.errorMessage} /> : null}
        </span>
        {message.status === "failed" && message.errorMessage ? (
          <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-300">{message.errorMessage}</p>
        ) : null}
      </div>
    </div>
  );
}

/** The stored plain-text fallback lists options as "1. …"; the bubble shows real buttons instead. */
function stripOptions(content: string, interactive: NonNullable<ChatMessage["payload"]["interactive"]>) {
  if (interactive.kind === "buttons") {
    const lines = interactive.buttons?.map((b, i) => `${i + 1}. ${b.title}`).join("\n");
    return lines ? content.replace(`\n\n${lines}`, "") : content;
  }
  if (interactive.kind === "list") {
    const cut = content.search(/\n\n1\. /);
    return cut > 0 ? content.slice(0, cut) : content;
  }
  return content;
}

export function DaySeparator({ date, timeZone }: { date: string; timeZone?: string }) {
  const d = new Date(date);
  const today = new Date();
  const label =
    d.toDateString() === today.toDateString() ? "Today" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone });
  return (
    <div className="my-2 flex justify-center">
      <span className="rounded-md bg-card px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground shadow-xs">{label}</span>
    </div>
  );
}

export function startsNewDay(messages: ChatMessage[], index: number) {
  const day = new Date(messages[index].createdAt).toDateString();
  return index === 0 || new Date(messages[index - 1].createdAt).toDateString() !== day;
}

export function MessageList({ messages, timeZone }: { messages: ChatMessage[]; timeZone?: string }) {
  return (
    <>
      {messages.map((message, index) => {
        const separator = startsNewDay(messages, index);
        return (
          <Fragment key={message.id}>
            {separator ? <DaySeparator date={message.createdAt} timeZone={timeZone} /> : null}
            <MessageBubble message={message} timeZone={timeZone} />
          </Fragment>
        );
      })}
    </>
  );
}
