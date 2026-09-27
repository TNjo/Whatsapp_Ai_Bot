"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { NativeSelect } from "@/components/app/controls";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ORDER_STATUSES, STATUS_LABEL } from "@/lib/order-status";

export function OrdersToolbar({ q, status, includeTest }: { q: string; status: string; includeTest: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(q);

  const go = (next: { q?: string; status?: string; test?: boolean }) => {
    const sp = new URLSearchParams();
    const merged = { q: value, status, test: includeTest, ...next };
    if (merged.q) sp.set("q", merged.q);
    if (merged.status) sp.set("status", merged.status);
    if (merged.test) sp.set("test", "1");
    router.push(`/dashboard/orders?${sp.toString()}`);
  };

  useEffect(() => {
    if (value === q) return;
    const timer = setTimeout(() => go({ q: value }), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-64">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Order #, name or phone" className="pl-8" />
      </div>
      <NativeSelect className="w-40" value={status} onChange={(e) => go({ status: e.target.value })} aria-label="Status">
        <option value="PENDING">Pending</option>
        <option value="OPEN">In progress</option>
        <option value="ALL">All statuses</option>
        {ORDER_STATUSES.filter((s) => s !== "PENDING").map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </NativeSelect>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Switch checked={includeTest} onCheckedChange={(checked) => go({ test: checked })} size="sm" />
        Test orders
      </label>
    </div>
  );
}
