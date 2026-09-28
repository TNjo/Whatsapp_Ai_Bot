import "server-only";
import { newId, store } from "@/db";
import type { NotificationType } from "@/db/schema";
import { publish } from "./events";
import { log } from "./logger";

export async function notify(
  businessId: string,
  input: { type: NotificationType; title: string; body?: string; link?: string | null },
) {
  try {
    const s = await store();
    const id = newId();
    const row = { type: input.type, title: input.title, body: input.body ?? "", link: input.link ?? null, readAt: null, createdAt: new Date() };
    await s.notifications(businessId).doc(id).set(row);
    publish(businessId, { type: "notification.created", notificationId: id, title: row.title, body: row.body, link: row.link, kind: row.type });
    return { id, ...row };
  } catch (err) {
    log.error("notification.failed", { businessId, type: input.type, err });
    return null;
  }
}
