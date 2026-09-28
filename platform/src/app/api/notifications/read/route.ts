import { z } from "zod";
import { fromDocs, store } from "@/db";
import type { Notification } from "@/db/schema";
import { requireApiAuth } from "@/server/auth";
import { json, readJson, route } from "@/server/http";

const Body = z.object({ ids: z.array(z.string().min(1).max(64)).max(200).optional(), all: z.boolean().optional() });

export const POST = route("notifications.read", async (request) => {
  const auth = await requireApiAuth(request);
  const body = await readJson(request, Body);
  const s = await store();
  const col = s.notifications(auth.business.id);
  const refs = body.all
    ? fromDocs<Notification>(await col.where("readAt", "==", null).limit(500).get()).map((n) => col.doc(n.id))
    : (body.ids ?? []).map((id) => col.doc(id));
  const snaps = refs.length ? await s.db.getAll(...refs) : [];
  const batch = s.db.batch();
  const now = new Date();
  for (const snap of snaps) if (snap.exists) batch.update(snap.ref, { readAt: now });
  await batch.commit();
  return json({ ok: true });
});
