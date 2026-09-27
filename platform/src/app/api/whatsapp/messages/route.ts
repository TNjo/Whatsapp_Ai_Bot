import { z } from "zod";
import { requireApiAuth } from "@/server/auth";
import { saveStatusMessages, statusMessagesView } from "@/server/admin/whatsapp";
import { cleanText, json, readJson, route } from "@/server/http";

export const GET = route("status_messages.get", async (request) => {
  const auth = await requireApiAuth(request);
  return json({ messages: await statusMessagesView(auth.business.id) });
});

const key = z.enum(["order_confirmed", "order_processing", "order_ready", "order_dispatched", "order_delivered", "order_completed", "order_rejected", "order_cancelled"]);
const Body = z.object({ messages: z.partialRecord(key, cleanText(1000)) });

export const PUT = route("status_messages.save", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  const body = await readJson(request, Body);
  return json({ messages: await saveStatusMessages(auth.business.id, body.messages, auth.actor) });
});
