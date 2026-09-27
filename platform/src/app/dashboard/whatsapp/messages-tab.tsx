"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { WhatsAppText } from "@/components/app/chat";
import { SectionCard } from "@/components/app/common";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export type StatusMessage = { key: string; label: string; text: string; isDefault: boolean; defaultText: string };

const SAMPLE: Record<string, string> = {
  customer_name: "Kasun",
  order_id: "ORD-10025",
  total: "Rs. 5,350",
  tracking: "TRK123456",
  business_name: "Your store",
  status: "Dispatched",
};

function preview(text: string) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => SAMPLE[name] ?? `{{${name}}}`);
}

export function MessagesTab({ messages, isOwner }: { messages: StatusMessage[]; isOwner: boolean }) {
  const router = useRouter();
  const [values, setValues] = useState(() => Object.fromEntries(messages.map((m) => [m.key, m.text])));
  const [active, setActive] = useState(messages[0]?.key ?? "");
  const [saving, setSaving] = useState(false);
  const changed = useMemo(() => messages.filter((m) => values[m.key] !== m.text).map((m) => m.key), [messages, values]);
  const current = messages.find((m) => m.key === active);

  const save = async () => {
    setSaving(true);
    try {
      await api("/api/whatsapp/messages", { method: "PUT", body: { messages: Object.fromEntries(changed.map((key) => [key, values[key]])) } });
      toast.success("Messages saved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)_320px]">
      <nav className="flex gap-1 overflow-x-auto lg:flex-col">
        {messages.map((message) => (
          <button
            key={message.key}
            type="button"
            onClick={() => setActive(message.key)}
            className={cn(
              "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium whitespace-nowrap text-muted-foreground hover:bg-muted",
              active === message.key && "bg-primary/10 text-primary hover:bg-primary/15",
            )}
          >
            {message.label}
            {changed.includes(message.key) ? <span className="size-1.5 rounded-full bg-amber-500" /> : !message.isDefault ? <span className="text-[10px]">edited</span> : null}
          </button>
        ))}
      </nav>
      {current ? (
        <SectionCard
          title={current.label}
          description="Sent automatically when you move an order to this status (inside the 24-hour window)."
          actions={
            isOwner ? (
              <Button variant="ghost" size="sm" onClick={() => setValues((v) => ({ ...v, [current.key]: current.defaultText }))}>
                <RotateCcw className="size-3.5" /> Default
              </Button>
            ) : null
          }
        >
          <Textarea
            rows={10}
            value={values[current.key]}
            disabled={!isOwner}
            onChange={(e) => setValues((v) => ({ ...v, [current.key]: e.target.value }))}
            className="font-mono text-sm"
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Variables: {Object.keys(SAMPLE).map((name) => `{{${name}}}`).join("  ")}. A line whose only variable is empty (e.g. no tracking number) is left out.
          </p>
          {isOwner ? (
            <div className="mt-4 flex items-center justify-end gap-3">
              {changed.length ? <span className="text-sm text-muted-foreground">{changed.length} unsaved change{changed.length > 1 ? "s" : ""}</span> : null}
              <Button onClick={save} disabled={!changed.length || saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null} Save messages
              </Button>
            </div>
          ) : null}
        </SectionCard>
      ) : null}
      {current ? (
        <div className="chat-wallpaper h-fit rounded-xl border p-4">
          <p className="mb-3 text-center text-xs font-medium text-muted-foreground">Preview</p>
          <div className="ml-auto max-w-[90%] rounded-xl rounded-tr-sm bg-emerald-100 px-3 py-2 text-sm whitespace-pre-wrap text-emerald-950 shadow-xs dark:bg-emerald-900/70 dark:text-emerald-50">
            <WhatsAppText text={preview(values[current.key] ?? "")} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
