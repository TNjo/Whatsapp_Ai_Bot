import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { notifications } from "@/db/schema";
import { requireApiAuth } from "@/server/auth";
import { json, readJson, route } from "@/server/http";

const Body = z.object({ ids: z.array(z.string().uuid()).max(200).optional(), all: z.boolean().optional() });

export const POST = route("notifications.read", async (request) => {
  const auth = await requireApiAuth(request);
  const body = await readJson(request, Body);
  const db = await getDb();
  const scope = and(eq(notifications.businessId, auth.business.id), isNull(notifications.readAt));
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(body.all ? scope : and(scope, inArray(notifications.id, body.ids ?? [])));
  return json({ ok: true });
});
