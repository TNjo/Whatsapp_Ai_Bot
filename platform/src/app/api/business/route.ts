import { requireApiAuth } from "@/server/auth";
import { BusinessInput, getBusinessProfile, updateBusinessProfile } from "@/server/admin/business-settings";
import { json, readPatch, route } from "@/server/http";

export const GET = route("business.get", async (request) => {
  const auth = await requireApiAuth(request);
  return json({ business: await getBusinessProfile(auth.business.id), role: auth.role });
});

/** Partial update: only the fields sent are changed. */
export const PUT = route("business.update", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  const input = await readPatch(request, BusinessInput);
  return json({ business: await updateBusinessProfile(auth.business.id, input, auth.actor) });
});
