import "server-only";
import { getDb, type DbOrTx } from "@/db";
import { auditLogs } from "@/db/schema";
import { log, redact } from "./logger";

export type AuditActor = { userId?: string | null; name: string; ip?: string | null };

/** Records who did what. Failures are logged, never thrown into the caller's flow. */
export async function audit(
  businessId: string | null,
  actor: AuditActor,
  action: string,
  entity: { type?: string; id?: string | null } = {},
  metadata: Record<string, unknown> = {},
  tx?: DbOrTx,
) {
  try {
    const db = tx ?? (await getDb());
    await db.insert(auditLogs).values({
      businessId,
      userId: actor.userId ?? null,
      actor: actor.name,
      action,
      entityType: entity.type ?? "",
      entityId: entity.id ?? null,
      metadata: redact(metadata) as Record<string, unknown>,
      ip: actor.ip ?? null,
    });
  } catch (err) {
    log.error("audit.write_failed", { action, err });
  }
}

export const SYSTEM_ACTOR: AuditActor = { name: "system" };
export const AI_ACTOR: AuditActor = { name: "ai" };
