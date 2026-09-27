"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown, ChevronUp, Lock, Plus, Smartphone, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/app/common";
import { NativeSelect } from "@/components/app/controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { OrderFieldView } from "@/server/admin/bot";
import { SaveBar } from "../save-bar";

type FieldType = OrderFieldView["type"];
type EditField = OrderFieldView & { uid: string; autoKey?: boolean };

const TYPE_LABELS: Record<FieldType, string> = {
  text: "Short text",
  textarea: "Long text",
  select: "Choice list",
  number: "Number",
  date: "Date",
  time: "Time",
  phone: "Phone",
  email: "Email",
};

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

const PRESETS: { label: string; key: string; type: FieldType; required: boolean; options?: string[]; helpText?: string }[] = [
  { label: "Size", key: "size", type: "select", required: true, options: ["Small", "Medium", "Large"] },
  { label: "Color", key: "color", type: "select", required: true },
  { label: "Delivery date", key: "delivery_date", type: "date", required: true },
  { label: "Preferred time", key: "preferred_time", type: "time", required: false },
  { label: "Message on cake", key: "message_on_cake", type: "text", required: false, helpText: "Text to write on the cake." },
  { label: "Special instructions", key: "special_instructions", type: "textarea", required: false },
];

/** Mirrors slugKey() in src/server/commerce/order-form.ts, plus the "must start with a letter" rule. */
function slugKey(label: string) {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "field";
  return /^[a-z]/.test(slug) ? slug : `f_${slug}`.slice(0, 40);
}

function uniqueKey(base: string, taken: Set<string>) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base.slice(0, 40 - String(n).length - 1)}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const uid = () => Math.random().toString(36).slice(2);
const toEdit = (fields: OrderFieldView[]): EditField[] => fields.map((f) => ({ ...f, uid: f.id }));
const snapshot = (fields: EditField[]) =>
  JSON.stringify(fields.map((f) => [f.id, f.key, f.label, f.type, f.required, f.enabled, f.options, f.helpText]));

export function OrderFormEditor({
  initial,
  paymentMethods,
  businessName,
  canEdit,
}: {
  initial: OrderFieldView[];
  paymentMethods: string[];
  businessName: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [baseline, setBaseline] = useState(() => toEdit(initial));
  const [fields, setFields] = useState(() => toEdit(initial));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = useMemo(() => snapshot(fields) !== snapshot(baseline), [fields, baseline]);

  const keyCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of fields) counts.set(f.key, (counts.get(f.key) ?? 0) + 1);
    return counts;
  }, [fields]);

  const update = (id: string, patch: Partial<EditField>) =>
    setFields((list) =>
      list.map((f) => {
        if (f.uid !== id) return f;
        const next = { ...f, ...patch };
        // New custom fields follow their label until the key is edited by hand.
        if (patch.label !== undefined && f.autoKey) {
          next.key = uniqueKey(slugKey(patch.label), new Set(list.filter((o) => o.uid !== id).map((o) => o.key)));
        }
        return next;
      }),
    );

  const move = (index: number, delta: number) =>
    setFields((list) => {
      const next = [...list];
      const target = index + delta;
      if (target < 0 || target >= next.length) return list;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const add = (preset?: (typeof PRESETS)[number]) => {
    const taken = new Set(fields.map((f) => f.key));
    const label = preset?.label ?? "New field";
    setFields((list) => [
      ...list,
      {
        uid: uid(),
        id: "",
        key: uniqueKey(preset?.key ?? slugKey(label), taken),
        label,
        type: preset?.type ?? "text",
        required: preset?.required ?? false,
        enabled: true,
        system: false,
        options: preset?.options ?? [],
        helpText: preset?.helpText ?? "",
        autoKey: !preset,
      },
    ]);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const body = {
        fields: fields.map((f) => ({
          id: f.id || undefined,
          key: f.key,
          label: f.label,
          type: f.type,
          required: f.required,
          enabled: f.enabled,
          options: f.options,
          helpText: f.helpText,
        })),
      };
      const data = await api<{ fields: OrderFieldView[] }>("/api/bot/order-form", { method: "PUT", body });
      setBaseline(toEdit(data.fields));
      setFields(toEdit(data.fields));
      toast.success("Order form saved");
      router.refresh();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const existingKeys = new Set(fields.map((f) => f.key));

  return (
    <div>
      {!canEdit ? (
        <div className="mb-6 flex items-center gap-2 rounded-xl border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <Lock className="size-4 shrink-0" /> Only the business owner can change the order form. You can view it here.
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <SectionCard
          title="Order fields"
          description="Tick “Collect” for every detail the assistant should ask for. Product and quantity are always collected with the cart."
          bodyClassName="p-3 sm:p-4"
          actions={
            canEdit ? (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
                  <Plus className="size-3.5" /> Add field
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  {PRESETS.map((preset) => (
                    <DropdownMenuItem key={preset.key} disabled={existingKeys.has(preset.key)} onClick={() => add(preset)}>
                      {preset.label}
                      <span className="ml-auto text-xs text-muted-foreground">{TYPE_LABELS[preset.type]}</span>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => add()}>Custom field…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null
          }
        >
          <fieldset disabled={!canEdit} className="min-w-0">
            <ol className="grid gap-3">
              {fields.map((field, index) => (
                <FieldRow
                  key={field.uid}
                  field={field}
                  index={index}
                  count={fields.length}
                  duplicate={(keyCounts.get(field.key) ?? 0) > 1}
                  paymentMethods={paymentMethods}
                  canEdit={canEdit}
                  onChange={(patch) => update(field.uid, patch)}
                  onMove={(delta) => move(index, delta)}
                  onDelete={() => setFields((list) => list.filter((f) => f.uid !== field.uid))}
                />
              ))}
            </ol>
          </fieldset>
        </SectionCard>

        <Preview fields={fields} paymentMethods={paymentMethods} businessName={businessName} />
      </div>

      {canEdit ? (
        <SaveBar
          error={saveError}
          dirty={dirty}
          saving={saving}
          onSave={save}
          onDiscard={() => {
            setFields(baseline);
            setSaveError(null);
          }}
        />
      ) : null}
    </div>
  );
}

function FieldRow({
  field,
  index,
  count,
  duplicate,
  paymentMethods,
  canEdit,
  onChange,
  onMove,
  onDelete,
}: {
  field: EditField;
  index: number;
  count: number;
  duplicate: boolean;
  paymentMethods: string[];
  canEdit: boolean;
  onChange: (patch: Partial<EditField>) => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
}) {
  const isPhone = field.key === "phone" && field.system;
  const isPayment = field.key === "payment_method" && field.system;
  const keyInvalid = !KEY_PATTERN.test(field.key);
  const needsOptions = field.type === "select" && !isPayment && field.options.length === 0;

  return (
    <li className={cn("rounded-xl border bg-card p-3 transition-colors", !field.enabled && "bg-muted/40")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Checkbox
            checked={field.enabled}
            disabled={isPhone || !canEdit}
            onCheckedChange={(checked) => onChange({ enabled: checked })}
            aria-label={`Collect ${field.label}`}
          />
          <span className="hidden sm:inline">Collect</span>
        </label>
        <Input
          value={field.label}
          maxLength={80}
          aria-label="Field label"
          onChange={(e) => onChange({ label: e.target.value })}
          className={cn("min-w-40 flex-1 font-medium", !field.enabled && "text-muted-foreground")}
        />
        <NativeSelect
          aria-label="Field type"
          value={field.type}
          disabled={field.system || !canEdit}
          onChange={(e) => onChange({ type: e.target.value as FieldType })}
          className="w-32"
        >
          {(Object.keys(TYPE_LABELS) as FieldType[]).map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]}
            </option>
          ))}
        </NativeSelect>
        <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label="Required or optional">
          {[true, false].map((value) => (
            <button
              key={String(value)}
              type="button"
              disabled={isPhone || !canEdit}
              aria-pressed={field.required === value}
              onClick={() => onChange({ required: value })}
              className={cn(
                "rounded-md px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed",
                field.required === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value ? "Required" : "Optional"}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            <ChevronUp className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
            <ChevronDown className="size-4" />
          </Button>
          {field.system ? (
            <span className="grid size-7 place-items-center text-muted-foreground/60" title="Built-in fields can't be deleted">
              <Lock className="size-3.5" />
            </span>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Delete field"
              className="text-muted-foreground hover:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)] sm:pl-6">
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">Key</span>
          <Input
            value={field.key}
            readOnly={field.system}
            maxLength={40}
            aria-label="Field key"
            aria-invalid={keyInvalid || duplicate || undefined}
            onChange={(e) => onChange({ key: e.target.value.toLowerCase(), autoKey: false })}
            className={cn("h-7 font-mono text-xs", field.system && "bg-muted/50 text-muted-foreground")}
          />
          {duplicate ? (
            <span className="text-xs text-destructive">Another field uses this key.</span>
          ) : keyInvalid ? (
            <span className="text-xs text-destructive">Use a–z, 0–9 and _, starting with a letter.</span>
          ) : null}
        </div>
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">Help text for the assistant (optional)</span>
          <Input
            value={field.helpText}
            maxLength={200}
            aria-label="Help text"
            placeholder="e.g. Ask for the nearest landmark"
            onChange={(e) => onChange({ helpText: e.target.value })}
            className="h-7 text-xs"
          />
        </div>

        {isPayment ? (
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Uses payment methods from{" "}
            <Link href="/dashboard/settings" className="font-medium text-foreground underline-offset-2 hover:underline">
              Settings
            </Link>
            : {paymentMethods.length ? paymentMethods.join(", ") : "none configured yet"}.
          </p>
        ) : field.type === "select" ? (
          <div className="grid gap-1 sm:col-span-2">
            <span className="text-xs text-muted-foreground">Choices</span>
            <OptionsEditor value={field.options} disabled={!canEdit} onChange={(options) => onChange({ options })} />
            {needsOptions ? <span className="text-xs text-destructive">Add at least one choice.</span> : null}
          </div>
        ) : null}

        {field.system ? (
          <div className="flex flex-wrap gap-1.5 sm:col-span-2">
            <Badge variant="secondary">Built-in</Badge>
            {isPhone ? (
              <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
                <Smartphone /> Auto-filled from WhatsApp
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function OptionsEditor({ value, disabled, onChange }: { value: string[]; disabled: boolean; onChange: (options: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const commit = (raw: string) => {
    const additions = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!additions.length) return;
    onChange([...new Set([...value, ...additions])].slice(0, 30));
    setDraft("");
  };
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1.5 rounded-lg border border-input px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
      {value.map((option) => (
        <span key={option} className="inline-flex items-center gap-1 rounded-md bg-muted py-0.5 pr-1 pl-2 text-xs font-medium">
          {option}
          {!disabled ? (
            <button
              type="button"
              aria-label={`Remove ${option}`}
              className="rounded text-muted-foreground hover:text-foreground"
              onClick={() => onChange(value.filter((o) => o !== option))}
            >
              <X className="size-3" />
            </button>
          ) : null}
        </span>
      ))}
      <input
        value={draft}
        disabled={disabled}
        maxLength={80}
        aria-label="Add a choice"
        placeholder={value.length ? "Add more…" : "Type a choice and press Enter (e.g. Small, Medium, Large)"}
        onChange={(e) => {
          if (e.target.value.includes(",")) commit(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        className="min-w-32 flex-1 bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

function Preview({ fields, paymentMethods, businessName }: { fields: EditField[]; paymentMethods: string[]; businessName: string }) {
  const active = fields.filter((f) => f.enabled && f.label.trim());
  const asked = active.filter((f) => !(f.system && f.key === "phone"));
  const required = asked.filter((f) => f.required);
  const optional = asked.filter((f) => !f.required);
  const choices = (f: EditField) => (f.system && f.key === "payment_method" ? paymentMethods : f.type === "select" ? f.options : []);
  const describe = (f: EditField) => {
    const list = choices(f);
    return list.length ? ` (${list.join(" / ")})` : f.type === "date" ? " (date)" : f.type === "time" ? " (time)" : "";
  };

  return (
    <SectionCard
      title="What the assistant will ask"
      description="A preview of the details collected at checkout. The assistant asks one or two at a time and skips anything the customer already said."
      className="xl:sticky xl:top-20"
      bodyClassName="p-0"
    >
      <div className="overflow-hidden rounded-b-xl">
        <div className="flex items-center gap-2.5 bg-[#075e54] px-4 py-2.5 text-white dark:bg-[#1f2c34]">
          <span className="grid size-8 place-items-center rounded-full bg-white/20 text-sm font-semibold">{businessName.slice(0, 1).toUpperCase()}</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{businessName}</p>
            <p className="text-[11px] text-white/70">online</p>
          </div>
        </div>
        <div className="grid gap-2 bg-[#efeae2] p-3 text-[13px] leading-snug text-[#111b21] dark:bg-[#0b141a] dark:text-[#e9edef]">
          <Bubble side="right">I&apos;d like to place an order please</Bubble>
          {required.length ? (
            <Bubble side="left">
              Great! To place your order, I just need:
              <ol className="mt-1 list-decimal pl-5">
                {required.map((f) => (
                  <li key={f.uid}>
                    <span className="font-semibold">{f.label}</span>
                    <span className="text-[#667781] dark:text-[#8696a0]">{describe(f)}</span>
                  </li>
                ))}
              </ol>
            </Bubble>
          ) : (
            <Bubble side="left">Great! I&apos;ll prepare your order summary now.</Bubble>
          )}
          {optional.length ? (
            <Bubble side="left">
              If you like, you can also tell me:
              <ul className="mt-1 list-disc pl-5">
                {optional.map((f) => (
                  <li key={f.uid}>
                    {f.label}
                    <span className="text-[#667781] dark:text-[#8696a0]">{describe(f)}</span>
                  </li>
                ))}
              </ul>
            </Bubble>
          ) : null}
          <p className="mx-auto mt-1 flex items-center gap-1.5 rounded-md bg-[#fff5c4] px-2 py-1 text-center text-[11px] text-[#54656f] dark:bg-[#182229] dark:text-[#8696a0]">
            <Smartphone className="size-3" /> Phone number is taken from WhatsApp automatically
          </p>
        </div>
      </div>
    </SectionCard>
  );
}

function Bubble({ side, children }: { side: "left" | "right"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-lg px-2.5 py-1.5 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]",
        side === "right" ? "ml-auto rounded-tr-none bg-[#d9fdd3] dark:bg-[#005c4b]" : "mr-auto rounded-tl-none bg-white dark:bg-[#202c33]",
      )}
    >
      {children}
    </div>
  );
}
