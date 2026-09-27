import { getAuth } from "@/server/auth";
import { json, route } from "@/server/http";

export const GET = route("auth.me", async () => {
  const auth = await getAuth();
  if (!auth) return json({ user: null }, { status: 401 });
  return json({ user: auth.user, business: auth.business, role: auth.role });
});
