import { requireApiAuth } from "@/server/auth";
import { BotSettingsInput, getBotSettingsView, updateBotSettings } from "@/server/admin/bot";
import { json, readPatch, route } from "@/server/http";

export const GET = route("bot.settings.get", async (request) => {
  const auth = await requireApiAuth(request);
  return json({ settings: await getBotSettingsView(auth.business.id) });
});

/** Partial update: only the keys sent are changed. `aiApiKey` is write-only; empty keeps the saved key. */
export const PUT = route("bot.settings.update", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  const input = await readPatch(request, BotSettingsInput);
  return json({ settings: await updateBotSettings(auth.business.id, input, auth.actor) });
});
