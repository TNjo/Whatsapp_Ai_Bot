"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api-client";
import { STATUS_LABEL, STATUS_TRANSITIONS, type OrderStatus } from "@/lib/order-status";
import { cn } from "@/lib/utils";
import { Field } from "./controls";

type Notification = { notification: "sent" | "template" | "failed" | "skipped"; detail?: string };

function reportResult(orderNumber: string, status: OrderStatus, result: Notification) {
  const label = `${orderNumber} → ${STATUS_LABEL[status]}`;
  if (result.notification === "sent") toast.success(label, { description: "Customer notified on WhatsApp." });
  else if (result.notification === "template") toast.success(label, { description: "Customer notified with an approved template." });
  else if (result.notification === "failed") toast.warning(label, { description: result.detail ?? "The customer could not be notified." });
  else toast.success(label);
}

export async function changeStatus(orderId: string, orderNumber: string, status: OrderStatus, extra: { note?: string; trackingNumber?: string; notifyCustomer?: boolean } = {}) {
  const result = await api<{ notification: Notification }>(`/api/orders/${orderId}/status`, { body: { status, ...extra } });
  reportResult(orderNumber, status, result.notification);
}

/** Inline Confirm / Reject for pending orders (spec §23). */
export function QuickOrderActions({ orderId, orderNumber, size = "sm" }: { orderId: string; orderNumber: string; size?: "sm" | "default" }) {
  const router = useRouter();
  const [busy, setBusy] = useState<OrderStatus | null>(null);
  const run = async (status: OrderStatus) => {
    setBusy(status);
    try {
      await changeStatus(orderId, orderNumber, status);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <Button size={size} onClick={() => run("CONFIRMED")} disabled={busy !== null}>
        {busy === "CONFIRMED" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        Confirm
      </Button>
      <Button size={size} variant="outline" onClick={() => run("REJECTED")} disabled={busy !== null} className="text-rose-600 hover:text-rose-700 dark:text-rose-400">
        {busy === "REJECTED" ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
        Reject
      </Button>
    </div>
  );
}

/** Full status changer with note, tracking number and notify toggle. */
export function StatusChangeDialog({
  orderId,
  orderNumber,
  current,
  trackingNumber,
}: {
  orderId: string;
  orderNumber: string;
  current: OrderStatus;
  trackingNumber: string;
}) {
  const router = useRouter();
  const next = STATUS_TRANSITIONS[current];
  const [target, setTarget] = useState<OrderStatus | null>(null);
  const [note, setNote] = useState("");
  const [tracking, setTracking] = useState(trackingNumber);
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);

  if (!next.length) return null;

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await changeStatus(orderId, orderNumber, target, {
        note: note || undefined,
        trackingNumber: target === "DISPATCHED" ? tracking : undefined,
        notifyCustomer: notify,
      });
      setTarget(null);
      setNote("");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {next.map((status) => {
          const negative = status === "CANCELLED" || status === "REJECTED";
          return (
            <Button
              key={status}
              variant={negative ? "outline" : status === next[0] ? "default" : "secondary"}
              className={cn(negative && "text-rose-600 hover:text-rose-700 dark:text-rose-400")}
              onClick={() => setTarget(status)}
            >
              {negative ? <X className="size-4" /> : <ChevronRight className="size-4" />}
              {status === "CONFIRMED" ? "Confirm order" : `Mark ${STATUS_LABEL[status].toLowerCase()}`}
            </Button>
          );
        })}
      </div>
      <Dialog open={target !== null} onOpenChange={(open) => !open && !busy && setTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {orderNumber}: {STATUS_LABEL[current]} → {target ? STATUS_LABEL[target] : ""}
            </DialogTitle>
            <DialogDescription>The change is recorded in the order history.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            {target === "DISPATCHED" ? (
              <Field label="Tracking number" htmlFor="tracking" hint="Included in the customer's dispatch message.">
                <Input id="tracking" value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="TRK123456" />
              </Field>
            ) : null}
            <Field label="Note (internal, optional)" htmlFor="status-note">
              <Textarea id="status-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <label className="flex items-center justify-between gap-4 rounded-lg border p-3">
              <span>
                <span className="block text-sm font-medium">Notify customer on WhatsApp</span>
                <span className="block text-xs text-muted-foreground">Uses your status message, or an approved template outside the 24-hour window.</span>
              </span>
              <Switch checked={notify} onCheckedChange={setNotify} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy} variant={target === "CANCELLED" || target === "REJECTED" ? "destructive" : "default"}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {target ? `Mark ${STATUS_LABEL[target].toLowerCase()}` : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
