"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/app/common";
import { Field } from "@/components/app/controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api-client";

export function OrderNotes({ orderId, internalNotes, trackingNumber }: { orderId: string; internalNotes: string; trackingNumber: string }) {
  const router = useRouter();
  const [notes, setNotes] = useState(internalNotes);
  const [tracking, setTracking] = useState(trackingNumber);
  const [saving, setSaving] = useState(false);
  const dirty = notes !== internalNotes || tracking !== trackingNumber;

  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/orders/${orderId}`, { method: "PATCH", body: { internalNotes: notes, trackingNumber: tracking } });
      toast.success("Saved");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard title="Internal" description="Only your team sees these.">
      <div className="grid gap-4">
        <Field label="Tracking number" htmlFor="order-tracking">
          <Input id="order-tracking" value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="e.g. TRK123456" />
        </Field>
        <Field label="Internal notes" htmlFor="order-notes">
          <Textarea id="order-notes" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. gift wrap, packed by Nimal" />
        </Field>
        <Button onClick={save} disabled={!dirty || saving} className="justify-self-end">
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </SectionCard>
  );
}
