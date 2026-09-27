import { Bot, Cog, History, User } from "lucide-react";
import { EmptyState, SectionCard } from "@/components/app/common";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

type Log = {
  id: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: Date;
};

/** "order.status_changed" → "Order status changed" */
function describeAction(action: string) {
  const text = action.replace(/[._]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A short, human-readable summary of the metadata (never the raw JSON dump). */
function summarize(metadata: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    let text: string;
    if (Array.isArray(value)) text = value.filter((v) => typeof v !== "object").join(", ");
    else if (typeof value === "object") continue;
    else text = String(value);
    if (!text) continue;
    parts.push(`${key}: ${text.length > 60 ? `${text.slice(0, 57)}…` : text}`);
    if (parts.length === 3) break;
  }
  return parts.join(" · ");
}

function ActorIcon({ actor }: { actor: string }) {
  const Icon = actor === "ai" ? Bot : actor === "system" ? Cog : User;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}

export function ActivityLog({ logs, timeZone }: { logs: Log[]; timeZone: string }) {
  if (!logs.length) {
    return <EmptyState icon={History} title="No activity yet" description="Changes you and your team make will be recorded here." />;
  }
  return (
    <SectionCard
      title="Activity log"
      description={`The last ${logs.length} action${logs.length === 1 ? "" : "s"} in this business — who did what, and when.`}
      bodyClassName="p-0"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">Time</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Action</TableHead>
            <TableHead className="hidden pr-5 md:table-cell">Entity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.map((log) => {
            const summary = summarize(log.metadata);
            return (
              <TableRow key={log.id}>
                <TableCell className="pl-5 align-top whitespace-nowrap text-muted-foreground">
                  <time dateTime={log.createdAt.toISOString()} title={log.createdAt.toISOString()}>
                    {formatDateTime(log.createdAt, timeZone)}
                  </time>
                </TableCell>
                <TableCell className="align-top">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <ActorIcon actor={log.actor} />
                    {log.actor === "ai" ? "Assistant" : log.actor === "system" ? "System" : log.actor}
                  </span>
                  {log.ip ? <p className="text-xs text-muted-foreground tabular-nums">{log.ip}</p> : null}
                </TableCell>
                <TableCell className="max-w-md align-top whitespace-normal">
                  <p>{describeAction(log.action)}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{log.action}</p>
                  {summary ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{summary}</p> : null}
                </TableCell>
                <TableCell className="hidden pr-5 align-top md:table-cell">
                  {log.entityType ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Badge variant="secondary" className="font-normal capitalize">
                        {log.entityType.replace(/_/g, " ")}
                      </Badge>
                      {log.entityId ? (
                        <span className="font-mono text-xs text-muted-foreground" title={log.entityId}>
                          {log.entityId.slice(0, 8)}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SectionCard>
  );
}
