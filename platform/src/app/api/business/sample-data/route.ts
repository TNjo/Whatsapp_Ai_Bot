import { requireApiAuth } from "@/server/auth";
import { json, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { loadSampleData } from "@/server/sample-data";

export const POST = route("business.sample_data", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  await rateLimit(`sample-data:${auth.business.id}`, 10, 3600);
  const { added } = await loadSampleData(auth.business.id, auth.actor);
  return json({ added });
});
