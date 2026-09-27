import { z } from "zod";
import { requireApiAuth } from "@/server/auth";
import { resetTestChat, sendTestMessage, testChat } from "@/server/admin/bot-test";
import { cleanText, json, readJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export const GET = route("bot.test.get", async (request) => {
  const auth = await requireApiAuth(request);
  return json(await testChat(auth));
});

const Body = z
  .object({ text: cleanText(2000).optional(), replyId: z.string().max(256).optional(), replyTitle: cleanText(100).optional() })
  .refine((b) => Boolean(b.text) || Boolean(b.replyId), "Type a message");

/** Sends a message as a test customer and waits for the bot's reply. */
export const POST = route("bot.test.send", async (request) => {
  const auth = await requireApiAuth(request);
  await rateLimit(`bot-test:${auth.user.id}`, 60, 600);
  const body = await readJson(request, Body);
  return json(await sendTestMessage(auth, body));
});

export const DELETE = route("bot.test.reset", async (request) => {
  const auth = await requireApiAuth(request);
  return json(await resetTestChat(auth));
});
