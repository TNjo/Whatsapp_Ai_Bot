"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, HelpCircle, Loader2, NotebookPen, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, SectionCard } from "@/components/app/common";
import { ConfirmButton, Field } from "@/components/app/controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type Faq = { id: string; question: string; answer: string; enabled: boolean; sortOrder: number; updatedAt: string };
type Note = { id: string; title: string; content: string; enabled: boolean; updatedAt: string };

type Editing = { kind: "faq"; item: Faq | null } | { kind: "note"; item: Note | null } | null;

export function KnowledgeManager({ faqs, notes }: { faqs: Faq[]; notes: Note[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await action();
      if (success) toast.success(success);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const patchFaq = (faq: Faq, body: Record<string, unknown>, success?: string) =>
    run(`faq:${faq.id}`, () => api(`/api/bot/knowledge/faqs/${faq.id}`, { method: "PATCH", body }), success);
  const patchNote = (note: Note, body: Record<string, unknown>, success?: string) =>
    run(`note:${note.id}`, () => api(`/api/bot/knowledge/notes/${note.id}`, { method: "PATCH", body }), success);

  const deleteFaq = async (faq: Faq) => {
    try {
      await api(`/api/bot/knowledge/faqs/${faq.id}`, { method: "DELETE" });
      toast.success("FAQ deleted");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const deleteNote = async (note: Note) => {
    try {
      await api(`/api/bot/knowledge/notes/${note.id}`, { method: "DELETE" });
      toast.success("Note deleted");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="grid min-w-0 gap-6">
      <SectionCard
        title="Frequently asked questions"
        description="Questions customers often ask, with the exact answer you want the assistant to give. Order matters: put the most common first."
        bodyClassName="p-0"
        actions={
          faqs.length ? (
            <Button variant="outline" size="sm" onClick={() => setEditing({ kind: "faq", item: null })}>
              <Plus className="size-3.5" /> Add FAQ
            </Button>
          ) : null
        }
      >
        {faqs.length ? (
          <ul className="divide-y">
            {faqs.map((faq, index) => (
              <li key={faq.id} className={cn("flex items-start gap-3 px-5 py-4", busy === `faq:${faq.id}` && "opacity-60")}>
                <div className="flex flex-col">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Move up"
                    disabled={index === 0 || busy !== null}
                    onClick={() => patchFaq(faq, { move: "up" })}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Move down"
                    disabled={index === faqs.length - 1 || busy !== null}
                    onClick={() => patchFaq(faq, { move: "down" })}
                  >
                    <ChevronDown />
                  </Button>
                </div>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing({ kind: "faq", item: faq })}>
                  <p className={cn("font-medium", !faq.enabled && "text-muted-foreground")}>
                    {faq.question}
                    {!faq.enabled ? (
                      <Badge variant="secondary" className="ml-2 align-middle">
                        Off
                      </Badge>
                    ) : null}
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm whitespace-pre-line text-muted-foreground">{faq.answer}</p>
                </button>
                <RowActions
                  enabled={faq.enabled}
                  disabled={busy !== null}
                  onToggle={(enabled) => patchFaq(faq, { enabled }, enabled ? "FAQ enabled" : "FAQ turned off")}
                  onEdit={() => setEditing({ kind: "faq", item: faq })}
                  deleteTitle="Delete this FAQ?"
                  onDelete={() => deleteFaq(faq)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            className="m-5"
            icon={HelpCircle}
            title="No FAQs yet"
            description="Add questions like “Do you deliver to Kandy?” so the assistant answers them the way you would."
            action={
              <Button onClick={() => setEditing({ kind: "faq", item: null })}>
                <Plus className="size-4" /> Add your first FAQ
              </Button>
            }
          />
        )}
      </SectionCard>

      <SectionCard
        title="Knowledge notes"
        description="Longer background information: how you make your products, care instructions, sizing guides, anything customers ask about."
        bodyClassName="p-0"
        actions={
          notes.length ? (
            <Button variant="outline" size="sm" onClick={() => setEditing({ kind: "note", item: null })}>
              <Plus className="size-3.5" /> Add note
            </Button>
          ) : null
        }
      >
        {notes.length ? (
          <ul className="divide-y">
            {notes.map((note) => (
              <li key={note.id} className={cn("flex items-start gap-3 px-5 py-4", busy === `note:${note.id}` && "opacity-60")}>
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                  <NotebookPen className="size-4" />
                </span>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing({ kind: "note", item: note })}>
                  <p className={cn("font-medium", !note.enabled && "text-muted-foreground")}>
                    {note.title}
                    {!note.enabled ? (
                      <Badge variant="secondary" className="ml-2 align-middle">
                        Off
                      </Badge>
                    ) : null}
                  </p>
                  <p className="mt-1 line-clamp-2 text-sm whitespace-pre-line text-muted-foreground">{note.content}</p>
                  <p className="mt-1 text-xs text-muted-foreground/80">{note.content.length.toLocaleString()} characters</p>
                </button>
                <RowActions
                  enabled={note.enabled}
                  disabled={busy !== null}
                  onToggle={(enabled) => patchNote(note, { enabled }, enabled ? "Note enabled" : "Note turned off")}
                  onEdit={() => setEditing({ kind: "note", item: note })}
                  deleteTitle={`Delete “${note.title}”?`}
                  onDelete={() => deleteNote(note)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            className="m-5"
            icon={NotebookPen}
            title="No notes yet"
            description="Write down things the assistant should know, for example “All cakes are egg-free and need 2 days' notice.”"
            action={
              <Button variant="outline" onClick={() => setEditing({ kind: "note", item: null })}>
                <Plus className="size-4" /> Add a note
              </Button>
            }
          />
        )}
        <p className="border-t px-5 py-3 text-xs text-muted-foreground">
          The assistant reads enabled notes in order until about 8,000 characters. Keep notes focused and to the point.
        </p>
      </SectionCard>

      <KnowledgeDialog
        key={editing ? `${editing.kind}:${editing.item?.id ?? "new"}` : "none"}
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function RowActions({
  enabled,
  disabled,
  onToggle,
  onEdit,
  deleteTitle,
  onDelete,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  deleteTitle: string;
  onDelete: () => Promise<void>;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Switch checked={enabled} disabled={disabled} onCheckedChange={onToggle} aria-label={enabled ? "Turn off" : "Turn on"} className="mr-2" />
      <Button variant="ghost" size="icon-sm" aria-label="Edit" onClick={onEdit}>
        <Pencil className="size-4" />
      </Button>
      <ConfirmButton
        variant="ghost"
        size="icon-sm"
        aria-label="Delete"
        className="text-muted-foreground hover:text-destructive"
        title={deleteTitle}
        description="The assistant will no longer use this information."
        confirmLabel="Delete"
        destructive
        onConfirm={onDelete}
      >
        <Trash2 className="size-4" />
      </ConfirmButton>
    </div>
  );
}

function KnowledgeDialog({ editing, onClose, onSaved }: { editing: Editing; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const isFaq = editing?.kind === "faq";
  const faq = editing?.kind === "faq" ? editing.item : null;
  const note = editing?.kind === "note" ? editing.item : null;
  const existing = faq ?? note;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    const base = isFaq ? "/api/bot/knowledge/faqs" : "/api/bot/knowledge/notes";
    const body = isFaq ? { question: form.question, answer: form.answer } : { title: form.title, content: form.content };
    setSaving(true);
    try {
      if (existing) await api(`${base}/${existing.id}`, { method: "PATCH", body });
      else await api(base, { body });
      toast.success(`${isFaq ? "FAQ" : "Note"} ${existing ? "updated" : "added"}`);
      onSaved();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={isFaq ? "sm:max-w-lg" : "sm:max-w-2xl"}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{isFaq ? (faq ? "Edit FAQ" : "Add FAQ") : note ? "Edit note" : "Add knowledge note"}</DialogTitle>
            <DialogDescription>
              {isFaq
                ? "The assistant uses your answer as the source of truth for this question."
                : "Plain text works best. The assistant uses this as background information when answering."}
            </DialogDescription>
          </DialogHeader>
          {isFaq ? (
            <>
              <Field label="Question" htmlFor="faq-question">
                <Input id="faq-question" name="question" required maxLength={300} defaultValue={faq?.question} placeholder="Do you deliver outside Colombo?" />
              </Field>
              <Field label="Answer" htmlFor="faq-answer">
                <Textarea
                  id="faq-answer"
                  name="answer"
                  required
                  rows={5}
                  maxLength={2000}
                  defaultValue={faq?.answer}
                  placeholder="Yes — we deliver island-wide within 2–4 working days."
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Title" htmlFor="note-title">
                <Input id="note-title" name="title" required maxLength={160} defaultValue={note?.title} placeholder="Cake sizes and servings" />
              </Field>
              <Field label="Content" htmlFor="note-content" hint="Up to 8,000 characters.">
                <Textarea
                  id="note-content"
                  name="content"
                  required
                  rows={12}
                  maxLength={8000}
                  className="max-h-[50vh]"
                  defaultValue={note?.content}
                  placeholder={"1 kg cake — serves 8–10\n2 kg cake — serves 16–20"}
                />
              </Field>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {existing ? "Save changes" : isFaq ? "Add FAQ" : "Add note"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
