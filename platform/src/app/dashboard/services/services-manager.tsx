"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, Loader2, MoreHorizontal, Plus, Scissors, Search } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageHeader } from "@/components/app/common";
import { ConfirmButton, Field, NativeSelect } from "@/components/app/controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api-client";
import { formatMoney, toMajor } from "@/lib/format";

type Service = {
  id: string;
  name: string;
  description: string;
  price: number;
  durationMinutes: number | null;
  availability: string;
  status: "active" | "disabled";
  category: string | null;
  updatedAt: string;
};

export function ServicesManager({ initial, categories, currency }: { initial: Service[]; categories: string[]; currency: string }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const services = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? initial.filter((s) => `${s.name} ${s.description} ${s.category ?? ""}`.toLowerCase().includes(q)) : initial;
  }, [initial, query]);

  const toggle = async (service: Service) => {
    try {
      await api(`/api/services/${service.id}`, { method: "PATCH", body: { status: service.status === "active" ? "disabled" : "active" } });
      toast.success(service.status === "active" ? "Service disabled" : "Service enabled");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async (service: Service) => {
    try {
      await api(`/api/services/${service.id}`, { method: "DELETE" });
      toast.success("Service deleted");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Services"
        description="Bookable services the assistant can explain and take requests for. Use products, services, or both."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus className="size-4" /> Add service
          </Button>
        }
      />

      {initial.length === 0 ? (
        <EmptyState
          icon={Scissors}
          title="No services yet"
          description="Add a service like “Haircut — Rs. 1,500, 45 minutes” and the assistant will answer questions about it."
          action={
            <Button onClick={() => setEditing("new")}>
              <Plus className="size-4" /> Add your first service
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-xs">
          <div className="flex items-center gap-2 border-b p-3">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search services" className="pl-8" />
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Service</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.map((service) => (
                <TableRow key={service.id} className="cursor-pointer" onClick={() => setEditing(service)}>
                  <TableCell className="pl-4">
                    <p className="font-medium">{service.name}</p>
                    {service.description ? <p className="line-clamp-1 max-w-md text-xs text-muted-foreground">{service.description}</p> : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{service.category ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(service.price, currency)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {service.durationMinutes ? (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3.5" /> {service.durationMinutes} min
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {service.status === "active" ? (
                      <Badge className="border-0 bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">Active</Badge>
                    ) : (
                      <Badge variant="secondary">Disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(service)}>Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toggle(service)}>{service.status === "active" ? "Disable" : "Enable"}</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
              {!services.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No services match “{query}”.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}

      <ServiceDialog
        key={editing === "new" ? "new" : (editing?.id ?? "none")}
        service={editing}
        categories={categories}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
        onDelete={remove}
      />
    </>
  );
}

function ServiceDialog({
  service,
  categories,
  onClose,
  onSaved,
  onDelete,
}: {
  service: Service | "new" | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
  onDelete: (service: Service) => Promise<void>;
}) {
  const existing = service && service !== "new" ? service : null;
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const body = {
      name: form.name,
      description: form.description,
      category: form.category,
      price: form.price,
      durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : null,
      availability: form.availability,
      status: form.status,
    };
    setSaving(true);
    try {
      if (existing) await api(`/api/services/${existing.id}`, { method: "PATCH", body });
      else await api("/api/services", { body });
      toast.success(existing ? "Service updated" : "Service added");
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={service !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{existing ? "Edit service" : "Add service"}</DialogTitle>
            <DialogDescription>The assistant quotes these details exactly as written.</DialogDescription>
          </DialogHeader>
          <Field label="Name" htmlFor="svc-name">
            <Input id="svc-name" name="name" required defaultValue={existing?.name} placeholder="Haircut" />
          </Field>
          <Field label="Description" htmlFor="svc-desc">
            <Textarea id="svc-desc" name="description" rows={3} defaultValue={existing?.description} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Price" htmlFor="svc-price">
              <Input id="svc-price" name="price" type="number" min={0} step="0.01" required defaultValue={toMajor(existing?.price)} />
            </Field>
            <Field label="Duration (minutes)" htmlFor="svc-duration">
              <Input id="svc-duration" name="durationMinutes" type="number" min={0} defaultValue={existing?.durationMinutes ?? ""} />
            </Field>
            <Field label="Category" htmlFor="svc-category">
              <Input id="svc-category" name="category" list="service-categories" defaultValue={existing?.category ?? ""} placeholder="Hair" />
              <datalist id="service-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="Status" htmlFor="svc-status">
              <NativeSelect id="svc-status" name="status" defaultValue={existing?.status ?? "active"}>
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </NativeSelect>
            </Field>
          </div>
          <Field label="Availability" htmlFor="svc-availability" hint="e.g. “Mon–Sat, 9 AM – 6 PM”">
            <Input id="svc-availability" name="availability" defaultValue={existing?.availability} />
          </Field>
          <DialogFooter className="gap-2 sm:justify-between">
            {existing ? (
              <ConfirmButton
                type="button"
                variant="ghost"
                className="text-destructive"
                title={`Delete ${existing.name}?`}
                description="The assistant will stop offering this service. Past orders keep their details."
                confirmLabel="Delete"
                destructive
                onConfirm={async () => {
                  await onDelete(existing);
                  onClose();
                }}
              >
                Delete
              </ConfirmButton>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                {existing ? "Save changes" : "Add service"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
