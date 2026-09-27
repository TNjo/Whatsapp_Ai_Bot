import { requireApiAuth } from "@/server/auth";
import { createNote, NoteInput } from "@/server/admin/bot";
import { json, readJson, route } from "@/server/http";

export const POST = route("bot.notes.create", async (request) => {
  const auth = await requireApiAuth(request);
  const input = await readJson(request, NoteInput);
  return json({ note: await createNote(auth.business.id, input, auth.actor) }, { status: 201 });
});
