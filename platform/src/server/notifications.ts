import "server-only";
import { getDb } from "@/db";
import { notifications, type NotificationType } from "@/db/schema";
import { publish } from "./events";
import { log } from "./logger";

export async function notify(
  businessId: string,
  input: { type: NotificationType; title: string; body?: string; link?: string | null },
) {
  try {
    const db = await getDb();
    const [row] = await db
      .insert(notifications)
      .values({ businessId, type: input.type, title: input.title, body: input.body ?? "", link: input.link ?? null })
      .returning();
    publish(businessId, {
      type: "notification.created",
      notificationId: row.id,
      title: row.title,
      body: row.body,
      link: row.link,
      kind: row.type,
    });
    return row;
  } catch (err) {
    log.error("notification.failed", { businessId, type: input.type, err });
    return null;
  }
}
