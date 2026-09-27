import { assertSameOrigin, destroySession } from "@/server/auth";
import { json, route } from "@/server/http";

export const POST = route("auth.logout", async (request) => {
  assertSameOrigin(request);
  await destroySession();
  return json({ ok: true });
});
