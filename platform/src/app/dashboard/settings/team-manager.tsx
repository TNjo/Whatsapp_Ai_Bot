"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Crown, KeyRound, Loader2, Lock, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { NameAvatar, SectionCard } from "@/components/app/common";
import { ConfirmButton, Field } from "@/components/app/controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api-client";

type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: "owner" | "staff";
  joinedAt: string;
};

export function TeamManager({ members, canManage, currentUserId }: { members: Member[]; canManage: boolean; currentUserId: string }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  const remove = async (member: Member) => {
    try {
      await api(`/api/business/members/${member.id}`, { method: "DELETE" });
      toast.success(`${member.name} removed from the team`);
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="grid gap-6">
      {!canManage ? (
        <div className="flex items-start gap-3 rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <p>Only the business owner can add or remove team members.</p>
        </div>
      ) : null}

      <SectionCard
        title="Team members"
        description="Staff can handle conversations, orders, customers and the catalog. Only the owner can change business settings and the team."
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <UserPlus className="size-4" /> Add staff
            </Button>
          ) : null
        }
        bodyClassName="p-0"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-5">Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="hidden sm:table-cell">Joined</TableHead>
              {canManage ? <TableHead className="w-24 pr-5" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const isSelf = member.userId === currentUserId;
              return (
                <TableRow key={member.id}>
                  <TableCell className="pl-5">
                    <div className="flex items-center gap-3">
                      <NameAvatar name={member.name} className="size-8" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {member.name}
                          {isSelf ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span> : null}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {member.role === "owner" ? (
                      <Badge className="gap-1 border-0 bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                        <Crown className="size-3" /> Owner
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Staff</Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell" suppressHydrationWarning>
                    {new Date(member.joinedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </TableCell>
                  {canManage ? (
                    <TableCell className="pr-5 text-right">
                      {member.role === "staff" && !isSelf ? (
                        <ConfirmButton
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          title={`Remove ${member.name}?`}
                          description="They will be signed out immediately and can no longer access this business. Their past actions stay in the activity log."
                          confirmLabel="Remove"
                          destructive
                          onConfirm={() => remove(member)}
                        >
                          Remove
                        </ConfirmButton>
                      ) : null}
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {members.length === 1 && canManage ? (
          <p className="border-t px-5 py-4 text-sm text-muted-foreground">
            It&apos;s just you for now. Add staff so your team can reply to customers and manage orders.
          </p>
        ) : null}
      </SectionCard>

      <AddStaffDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          router.refresh();
        }}
      />
    </div>
  );
}

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function AddStaffDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [saving, setSaving] = useState(false);
  const [password, setPassword] = useState("");

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    setSaving(true);
    try {
      await api("/api/business/members", { body: { name: form.name, email: form.email, password } });
      toast.success(`${form.name} added. Share the email and temporary password with them.`);
      setPassword("");
      onAdded();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add staff member</DialogTitle>
            <DialogDescription>They sign in with this email and temporary password. Ask them to keep it private.</DialogDescription>
          </DialogHeader>
          <Field label="Name" htmlFor="staff-name">
            <Input id="staff-name" name="name" required minLength={2} maxLength={80} autoComplete="off" placeholder="Nimali Perera" />
          </Field>
          <Field label="Email" htmlFor="staff-email">
            <Input id="staff-email" name="email" type="email" required maxLength={200} autoComplete="off" placeholder="nimali@yourshop.lk" />
          </Field>
          <Field label="Temporary password" htmlFor="staff-password" hint="At least 8 characters.">
            <div className="flex gap-2">
              <Input
                id="staff-password"
                type="text"
                required
                minLength={8}
                maxLength={200}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono"
              />
              <Button type="button" variant="outline" onClick={() => setPassword(generatePassword())}>
                <KeyRound className="size-4" /> Generate
              </Button>
            </div>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Add staff member
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
