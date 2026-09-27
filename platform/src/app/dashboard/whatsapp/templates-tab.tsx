"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, SectionCard } from "@/components/app/common";
import { ConfirmButton, Field, NativeSelect } from "@/components/app/controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export type Template = {
  id: string;
  name: string;
  language: string;
  category: string;
  purpose: string;
  body: string;
  variables: string[];
  status: "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "UNKNOWN";
  metaTemplateId: string | null;
};

const PURPOSE_LABEL: Record<string, string> = {
  order_confirmed: "Order confirmation",
  order_processing: "Order processing",
  order_ready: "Order ready",
  order_dispatched: "Order dispatched",
  order_delivered: "Order delivered",
  order_completed: "Order completed",
  order_rejected: "Order rejected",
  order_cancelled: "Order cancelled",
  payment_received: "Payment received",
  other: "Other",
};
const VARIABLES = ["customer_name", "order_id", "total", "tracking", "business_name", "status"];

const STATUS_TONE: Record<Template["status"], string> = {
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
  PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  REJECTED: "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300",
  PAUSED: "bg-zinc-200 text-zinc-700",
  UNKNOWN: "bg-muted text-muted-foreground",
};

export function TemplatesTab({ templates, isOwner, connected }: { templates: Template[]; isOwner: boolean; connected: boolean }) {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<Template | "new" | null>(null);

  const sync = async () => {
    setSyncing(true);
    try {
      const data = await api<{ synced: number }>("/api/whatsapp/templates/sync", { body: {} });
      toast.success(`Synced ${data.synced} template${data.synced === 1 ? "" : "s"} from Meta`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <SectionCard
        title="Message templates"
        description="WhatsApp only allows approved templates when more than 24 hours have passed since the customer's last message."
        actions={
          isOwner ? (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
                <Plus className="size-4" /> Add
              </Button>
              <Button size="sm" onClick={sync} disabled={!connected || syncing}>
                {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Sync from Meta
              </Button>
            </div>
          ) : null
        }
        bodyClassName="p-0"
      >
        {templates.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No templates yet"
            description={connected ? "Create templates in WhatsApp Manager, then sync them here." : "Connect WhatsApp, then sync the templates from your account."}
            className="m-5"
          />
        ) : (
          <ul className="divide-y">
            {templates.map((template) => (
              <li key={template.id}>
                <button
                  type="button"
                  onClick={() => isOwner && setEditing(template)}
                  className="flex w-full items-start gap-4 px-5 py-4 text-left hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-medium">{template.name}</span>
                      <span className="text-xs text-muted-foreground">{template.language}</span>
                      <Badge variant="secondary" className={cn("border-0", STATUS_TONE[template.status])}>
                        {template.status.toLowerCase()}
                      </Badge>
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{template.body || "No body text synced."}</p>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    <p className="font-medium text-foreground">{PURPOSE_LABEL[template.purpose] ?? template.purpose}</p>
                    {template.variables.length ? <p>{template.variables.map((v, i) => `{{${i + 1}}} ${v}`).join(", ")}</p> : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title="How templates are used">
        <ul className="grid gap-3 text-sm text-muted-foreground">
          <li>Inside the 24-hour window, order updates use your editable status messages.</li>
          <li>Outside it, the system sends the approved template whose purpose matches the update — e.g. “Order dispatched”.</li>
          <li>Map each <code>{"{{1}}"}</code>, <code>{"{{2}}"}</code>… placeholder to order data like the customer name or order number.</li>
          <li>If no approved template matches, the order still updates and you get a notification that the customer wasn&apos;t messaged.</li>
        </ul>
      </SectionCard>
      <TemplateDialog
        key={editing === "new" ? "new" : (editing?.id ?? "none")}
        template={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function TemplateDialog({ template, onClose, onSaved }: { template: Template | "new" | null; onClose: () => void; onSaved: () => void }) {
  const existing = template && template !== "new" ? template : null;
  const placeholderCount = existing ? new Set(existing.body.match(/\{\{\d+\}\}/g) ?? []).size : 0;
  const [variables, setVariables] = useState<string[]>(existing?.variables.length ? existing.variables : Array.from({ length: placeholderCount }, () => VARIABLES[0]));
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setSaving(true);
    try {
      if (existing) {
        await api(`/api/whatsapp/templates/${existing.id}`, { method: "PATCH", body: { purpose: form.purpose, variables } });
      } else {
        await api("/api/whatsapp/templates", {
          body: { name: form.name, language: form.language, purpose: form.purpose, body: form.body, variables, status: form.status },
        });
      }
      toast.success("Template saved");
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={template !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{existing ? existing.name : "Add a template"}</DialogTitle>
            <DialogDescription>
              {existing ? "Choose what this template is for and map its placeholders." : "Register a template you already created and got approved in WhatsApp Manager."}
            </DialogDescription>
          </DialogHeader>
          {!existing ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Template name" htmlFor="tpl-name">
                  <Input id="tpl-name" name="name" required pattern="[a-z0-9_]+" placeholder="order_confirmed" className="font-mono" />
                </Field>
                <Field label="Language" htmlFor="tpl-lang">
                  <Input id="tpl-lang" name="language" required defaultValue="en" />
                </Field>
              </div>
              <Field label="Body" htmlFor="tpl-body" hint="Paste the body text, e.g. Hello {{1}}, your order {{2}} has been confirmed.">
                <Textarea
                  id="tpl-body"
                  name="body"
                  rows={3}
                  onChange={(e) => {
                    const n = new Set(e.target.value.match(/\{\{\d+\}\}/g) ?? []).size;
                    setVariables((v) => Array.from({ length: n }, (_, i) => v[i] ?? VARIABLES[0]));
                  }}
                />
              </Field>
              <Field label="Approval status" htmlFor="tpl-status">
                <NativeSelect id="tpl-status" name="status" defaultValue="APPROVED">
                  <option value="APPROVED">Approved</option>
                  <option value="PENDING">Pending</option>
                </NativeSelect>
              </Field>
            </>
          ) : (
            <p className="rounded-lg bg-muted/60 p-3 text-sm whitespace-pre-wrap">{existing.body || "No body text."}</p>
          )}
          <Field label="Used for" htmlFor="tpl-purpose">
            <NativeSelect id="tpl-purpose" name="purpose" defaultValue={existing?.purpose ?? "order_confirmed"}>
              {Object.entries(PURPOSE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {variables.length ? (
            <div className="grid gap-2">
              <p className="text-sm font-medium">Placeholders</p>
              {variables.map((variable, i) => (
                <div key={i} className="flex items-center gap-3">
                  <code className="w-12 text-sm">{`{{${i + 1}}}`}</code>
                  <NativeSelect value={variable} onChange={(e) => setVariables((v) => v.map((x, j) => (j === i ? e.target.value : x)))}>
                    {VARIABLES.map((name) => (
                      <option key={name} value={name}>
                        {name.replace("_", " ")}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ))}
            </div>
          ) : null}
          <DialogFooter className="gap-2 sm:justify-between">
            {existing ? (
              <ConfirmButton
                type="button"
                variant="ghost"
                className="text-destructive"
                title={`Remove ${existing.name}?`}
                description="This only removes it from this dashboard. It stays in WhatsApp Manager and returns on the next sync."
                confirmLabel="Remove"
                destructive
                onConfirm={async () => {
                  await api(`/api/whatsapp/templates/${existing.id}`, { method: "DELETE" });
                  onSaved();
                }}
              >
                Remove
              </ConfirmButton>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null} Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
