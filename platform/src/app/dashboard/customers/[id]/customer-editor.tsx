"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Mail, MapPin, Pencil, User } from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/app/common";
import { Field } from "@/components/app/controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api-client";

type Details = { displayName: string; email: string; address: string; city: string };

export function CustomerDetailsCard({ customerId, initial, profileName }: { customerId: string; initial: Details; profileName: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const body = { displayName: form.displayName, email: form.email, address: form.address, city: form.city };
    setSaving(true);
    try {
      await api(`/api/customers/${customerId}`, { method: "PATCH", body });
      toast.success("Customer details saved");
      setEditing(false);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Details"
      actions={
        editing ? null : (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" /> Edit
          </Button>
        )
      }
    >
      {editing ? (
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Display name" htmlFor="cust-name" hint={profileName ? `WhatsApp profile name: ${profileName}` : undefined}>
            <Input id="cust-name" name="displayName" defaultValue={initial.displayName} placeholder={profileName || "Customer name"} maxLength={120} />
          </Field>
          <Field label="Email" htmlFor="cust-email">
            <Input id="cust-email" name="email" type="email" defaultValue={initial.email} placeholder="name@example.com" maxLength={200} />
          </Field>
          <Field label="Address" htmlFor="cust-address">
            <Textarea id="cust-address" name="address" rows={2} defaultValue={initial.address} maxLength={500} />
          </Field>
          <Field label="City" htmlFor="cust-city">
            <Input id="cust-city" name="city" defaultValue={initial.city} maxLength={120} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </form>
      ) : (
        <dl className="grid gap-3 text-sm">
          <DetailRow icon={User} label="Display name" value={initial.displayName || profileName} />
          <DetailRow icon={Mail} label="Email" value={initial.email} />
          <DetailRow icon={MapPin} label="Address" value={[initial.address, initial.city].filter(Boolean).join(", ")} />
        </dl>
      )}
    </SectionCard>
  );
}

function DetailRow({ icon: Icon, label, value }: { icon: typeof User; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className={value ? "font-medium break-words whitespace-pre-line" : "text-muted-foreground italic"}>{value || "Not provided"}</dd>
      </div>
    </div>
  );
}

export function CustomerNotesCard({ customerId, initial }: { customerId: string; initial: string }) {
  const router = useRouter();
  const [notes, setNotes] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = notes !== saved;

  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/customers/${customerId}`, { method: "PATCH", body: { notes } });
      setSaved(notes);
      toast.success("Notes saved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard title="Customer notes" description="Only visible to your team.">
      <div className="grid gap-3">
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          maxLength={5000}
          placeholder="e.g. Prefers evening delivery. Regular since 2024."
          aria-label="Customer notes"
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save notes
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
