"use client";

import { useEffect } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Sticky "Unsaved changes" bar; also warns before leaving the page with unsaved edits. */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  error,
  message = "Unsaved changes",
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** Shown in the bar (instead of a toast, which would cover the Save button). */
  error?: string | null;
  message?: string;
}) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!dirty) return null;
  return (
    <div className="sticky bottom-4 z-20 mt-6 flex animate-in items-center justify-between gap-3 rounded-xl border bg-background/95 px-4 py-3 shadow-lg backdrop-blur fade-in slide-in-from-bottom-2 supports-backdrop-filter:bg-background/80">
      {error ? (
        <p role="alert" className="flex min-w-0 items-start gap-2 text-sm font-medium text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="line-clamp-2">{error}</span>
        </p>
      ) : (
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium whitespace-nowrap">
          <span className="size-2 rounded-full bg-amber-500" aria-hidden />
          {message}
        </p>
      )}
      <div className="flex shrink-0 gap-1 sm:gap-2">
        <Button type="button" variant="ghost" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button type="button" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          Save changes
        </Button>
      </div>
    </div>
  );
}
