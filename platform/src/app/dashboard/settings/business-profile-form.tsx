"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, ImagePlus, Info, Loader2, Lock, PackagePlus, Plus, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/app/common";
import { ConfirmButton, Field } from "@/components/app/controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api-client";
import { toMajor } from "@/lib/format";

type Profile = {
  id: string;
  name: string;
  logoUrl: string | null;
  description: string;
  phone: string;
  email: string;
  address: string;
  website: string;
  whatsappNumber: string;
  openingHours: string;
  deliveryInfo: string;
  deliveryFee: number;
  paymentMethods: string[];
  bankDetails: string;
  returnPolicy: string;
  exchangePolicy: string;
  currency: string;
  timezone: string;
  lowStockThreshold: number;
};

const SUGGESTED_METHODS = ["Cash on Delivery", "Bank Transfer", "Card Payment", "Online Payment"];

export function BusinessProfileForm({ profile, canEdit, timezones }: { profile: Profile; canEdit: boolean; timezones: string[] }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [methods, setMethods] = useState(profile.paymentMethods);
  const [newMethod, setNewMethod] = useState("");

  const addMethod = (value: string) => {
    const method = value.trim().slice(0, 60);
    if (!method) return;
    if (methods.some((m) => m.toLowerCase() === method.toLowerCase())) {
      toast.info(`“${method}” is already listed`);
      return;
    }
    setMethods((list) => [...list, method]);
    setNewMethod("");
    setDirty(true);
  };

  const removeMethod = (method: string) => {
    setMethods((list) => list.filter((m) => m !== method));
    setDirty(true);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!methods.length) {
      toast.error("Add at least one payment method");
      return;
    }
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const body = {
      name: form.name,
      description: form.description,
      phone: form.phone,
      email: form.email,
      address: form.address,
      website: form.website,
      whatsappNumber: form.whatsappNumber,
      openingHours: form.openingHours,
      deliveryInfo: form.deliveryInfo,
      deliveryFee: form.deliveryFee || "0",
      paymentMethods: methods,
      bankDetails: form.bankDetails,
      returnPolicy: form.returnPolicy,
      exchangePolicy: form.exchangePolicy,
      currency: form.currency,
      timezone: form.timezone,
      lowStockThreshold: form.lowStockThreshold || "0",
    };
    setSaving(true);
    try {
      await api("/api/business", { method: "PUT", body });
      toast.success("Business profile saved");
      setDirty(false);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const missingSuggestions = SUGGESTED_METHODS.filter((s) => !methods.some((m) => m.toLowerCase() === s.toLowerCase()));

  return (
    <div className="grid gap-6">
      <div className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
        <Sparkles className="mt-0.5 size-4 shrink-0" />
        <p>Your assistant uses this information when answering customers — keep it accurate and up to date.</p>
      </div>

      {!canEdit ? (
        <div className="flex items-start gap-3 rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <p>You have view-only access. Only the business owner can change these settings.</p>
        </div>
      ) : null}

      <LogoCard logoUrl={profile.logoUrl} name={profile.name} canEdit={canEdit} />

      <form onSubmit={submit} onChange={() => setDirty(true)} className="grid gap-6">
        <fieldset disabled={!canEdit || saving} className="grid min-w-0 gap-6">
          <SectionCard title="Business details" description="How customers find and contact you.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Business name" htmlFor="biz-name" className="sm:col-span-2">
                <Input id="biz-name" name="name" required minLength={2} maxLength={80} defaultValue={profile.name} />
              </Field>
              <Field label="Description" htmlFor="biz-description" className="sm:col-span-2" hint="What you sell, in a sentence or two.">
                <Textarea id="biz-description" name="description" rows={3} maxLength={2000} defaultValue={profile.description} />
              </Field>
              <Field label="Phone" htmlFor="biz-phone">
                <Input id="biz-phone" name="phone" type="tel" maxLength={40} defaultValue={profile.phone} placeholder="+94 77 123 4567" />
              </Field>
              <Field label="WhatsApp number" htmlFor="biz-whatsapp">
                <Input id="biz-whatsapp" name="whatsappNumber" type="tel" maxLength={40} defaultValue={profile.whatsappNumber} placeholder="+94 77 123 4567" />
              </Field>
              <Field label="Email" htmlFor="biz-email">
                <Input id="biz-email" name="email" type="email" maxLength={200} defaultValue={profile.email} placeholder="hello@yourshop.lk" />
              </Field>
              <Field label="Website" htmlFor="biz-website">
                <Input id="biz-website" name="website" maxLength={200} defaultValue={profile.website} placeholder="yourshop.lk" />
              </Field>
              <Field label="Address" htmlFor="biz-address" className="sm:col-span-2">
                <Textarea id="biz-address" name="address" rows={2} maxLength={500} defaultValue={profile.address} />
              </Field>
            </div>
          </SectionCard>

          <SectionCard title="Hours & delivery" description="Answers to “Are you open?” and “How much is delivery?”">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Opening hours" htmlFor="biz-hours" hint="e.g. Mon–Sat 9 AM – 7 PM, closed on Sundays and Poya days">
                <Textarea id="biz-hours" name="openingHours" rows={4} maxLength={1000} defaultValue={profile.openingHours} />
              </Field>
              <Field label="Delivery information" htmlFor="biz-delivery" hint="Areas you deliver to, delivery times, courier used…">
                <Textarea id="biz-delivery" name="deliveryInfo" rows={4} maxLength={2000} defaultValue={profile.deliveryInfo} />
              </Field>
              <Field label={`Delivery fee (${profile.currency})`} htmlFor="biz-fee" hint="Added to every order. Use 0 for free delivery.">
                <Input id="biz-fee" name="deliveryFee" type="number" min={0} step="0.01" defaultValue={toMajor(profile.deliveryFee)} />
              </Field>
            </div>
          </SectionCard>

          <SectionCard title="Payments" description="The options customers can choose when they place an order.">
            <div className="grid gap-4">
              <Field label="Payment methods" htmlFor="biz-method-new">
                <div className="flex flex-wrap gap-2">
                  {methods.map((method) => (
                    <Badge key={method} variant="secondary" className="h-7 gap-1 pr-1 pl-2.5 text-sm font-normal">
                      {method}
                      {canEdit ? (
                        <button
                          type="button"
                          onClick={() => removeMethod(method)}
                          className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
                          aria-label={`Remove ${method}`}
                        >
                          <X className="size-3" />
                        </button>
                      ) : null}
                    </Badge>
                  ))}
                  {!methods.length ? <p className="text-sm text-muted-foreground">No payment methods yet — add at least one.</p> : null}
                </div>
                {canEdit ? (
                  <>
                    <div className="flex max-w-md gap-2">
                      <Input
                        id="biz-method-new"
                        value={newMethod}
                        maxLength={60}
                        placeholder="Add a payment method"
                        onChange={(e) => setNewMethod(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addMethod(newMethod);
                          }
                        }}
                      />
                      <Button type="button" variant="outline" onClick={() => addMethod(newMethod)} disabled={!newMethod.trim()}>
                        <Plus className="size-4" /> Add
                      </Button>
                    </div>
                    {missingSuggestions.length ? (
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        Suggestions:
                        {missingSuggestions.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => addMethod(s)}
                            className="rounded-full border px-2 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
                          >
                            + {s}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </Field>
              <Field label="Bank details" htmlFor="biz-bank" hint="Shown to customers who choose bank transfer.">
                <Textarea
                  id="biz-bank"
                  name="bankDetails"
                  rows={4}
                  maxLength={2000}
                  defaultValue={profile.bankDetails}
                  placeholder={"Bank: Commercial Bank\nAccount name: Your Shop (Pvt) Ltd\nAccount number: 1234567890\nBranch: Colombo 03"}
                />
              </Field>
            </div>
          </SectionCard>

          <SectionCard title="Policies" description="Quoted when customers ask about returns or exchanges.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Return policy" htmlFor="biz-returns">
                <Textarea id="biz-returns" name="returnPolicy" rows={4} maxLength={3000} defaultValue={profile.returnPolicy} />
              </Field>
              <Field label="Exchange policy" htmlFor="biz-exchange">
                <Textarea id="biz-exchange" name="exchangePolicy" rows={4} maxLength={3000} defaultValue={profile.exchangePolicy} />
              </Field>
            </div>
          </SectionCard>

          <SectionCard title="Regional & inventory">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Currency" htmlFor="biz-currency" hint="3-letter code, e.g. LKR">
                <Input
                  id="biz-currency"
                  name="currency"
                  required
                  minLength={3}
                  maxLength={3}
                  pattern="[A-Za-z]{3}"
                  className="uppercase"
                  defaultValue={profile.currency}
                />
              </Field>
              <Field label="Timezone" htmlFor="biz-timezone" hint="Used for dates and opening hours">
                <Input id="biz-timezone" name="timezone" required list="biz-timezones" maxLength={64} defaultValue={profile.timezone} />
                <datalist id="biz-timezones">
                  {timezones.map((tz) => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </Field>
              <Field label="Low stock alert" htmlFor="biz-low-stock" hint="Notify when stock falls to this level">
                <Input id="biz-low-stock" name="lowStockThreshold" type="number" min={0} step={1} required defaultValue={profile.lowStockThreshold} />
              </Field>
            </div>
          </SectionCard>
        </fieldset>

        {canEdit ? (
          <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-3 border-t bg-background/95 px-1 py-3 backdrop-blur supports-backdrop-filter:bg-background/80">
            {dirty ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <Info className="size-4" /> Unsaved changes
              </span>
            ) : null}
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Save changes
            </Button>
          </div>
        ) : null}
      </form>

      {canEdit ? <SampleDataCard /> : null}
    </div>
  );
}

function LogoCard({ logoUrl, name, canEdit }: { logoUrl: string | null; name: string; canEdit: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);

  const upload = async (file: File) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast.error("Use a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Images must be 5 MB or smaller.");
      return;
    }
    setBusy("upload");
    try {
      const body = new FormData();
      body.append("file", file);
      const { url } = await api<{ url: string }>("/api/uploads", { body });
      await api("/api/business", { method: "PUT", body: { logoUrl: url } });
      toast.success("Logo updated");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await api("/api/business", { method: "PUT", body: { logoUrl: null } });
      toast.success("Logo removed");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionCard title="Logo" description="Shown on your dashboard. PNG, JPEG or WebP, up to 5 MB.">
      <div className="flex flex-wrap items-center gap-4">
        <div className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-xl border bg-muted text-muted-foreground">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={`${name} logo`} className="size-full object-contain" />
          ) : (
            <Building2 className="size-7" />
          )}
        </div>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => input.current?.click()}>
              {busy === "upload" ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
              {logoUrl ? "Replace logo" : "Upload logo"}
            </Button>
            {logoUrl ? (
              <Button type="button" variant="ghost" className="text-destructive" disabled={busy !== null} onClick={remove}>
                {busy === "remove" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

function SampleDataCard() {
  const router = useRouter();

  const load = async () => {
    try {
      const { added } = await api<{ added: boolean }>("/api/business/sample-data", { method: "POST" });
      if (added) {
        toast.success("Sample products loaded");
        router.refresh();
      } else {
        toast.info("You already have products");
      }
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <SectionCard title="Load sample catalog" description="Try the assistant end to end before adding your own products.">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-sm text-muted-foreground">
          Adds a small clothing catalog with sizes, colours and stock, a sample service and two FAQs. It also fills in sample opening hours, delivery
          details and policies. Only runs while you have no products.
        </p>
        <ConfirmButton
          type="button"
          variant="outline"
          className="shrink-0"
          title="Load the sample catalog?"
          description="Sample products, a service and FAQs will be added. Your description, opening hours, delivery information, delivery fee and return/exchange policies will be replaced with sample text."
          confirmLabel="Load sample catalog"
          onConfirm={load}
        >
          <PackagePlus className="size-4" />
          Load sample catalog
        </ConfirmButton>
      </div>
    </SectionCard>
  );
}
