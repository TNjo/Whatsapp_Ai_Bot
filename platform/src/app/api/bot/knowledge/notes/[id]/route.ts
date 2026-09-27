import { requireApiAuth } from "@/server/auth";
import { deleteNote, NoteInput, updateNote } from "@/server/admin/bot";
import { json, readPatch, route } from "@/server/http";

export const PATCH = route("bot.notes.update", async (request, ctx: RouteContext<"/api/bot/knowledge/notes/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  const input = await readPatch(request, NoteInput);
  return json({ note: await updateNote(auth.business.id, id, input, auth.actor) });
});

export const DELETE = route("bot.notes.delete", async (request, ctx: RouteContext<"/api/bot/knowledge/notes/[id]">) => {
  const auth = await requireApiAuth(request);
  const { id } = await ctx.params;
  await deleteNote(auth.business.id, id, auth.actor);
  return json({ ok: true });
});
