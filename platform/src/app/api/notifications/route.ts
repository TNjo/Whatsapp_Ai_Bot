import { requireApiAuth } from "@/server/auth";
import { json, route } from "@/server/http";
import { listNotifications, shellCounts } from "@/server/queries/shell";

export const GET = route("notifications.list", async (request) => {
  const auth = await requireApiAuth(request);
  const [items, counts] = await Promise.all([listNotifications(auth.business.id), shellCounts(auth.business.id)]);
  return json({ notifications: items, counts });
});
