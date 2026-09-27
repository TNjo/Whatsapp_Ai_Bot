import { requireApiAuth } from "@/server/auth";
import { addStaffMember, listMembers, MemberInput } from "@/server/admin/business-settings";
import { json, readJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";

export const GET = route("business.members.list", async (request) => {
  const auth = await requireApiAuth(request);
  return json({ members: await listMembers(auth.business.id) });
});

export const POST = route("business.members.create", async (request) => {
  const auth = await requireApiAuth(request, "owner");
  await rateLimit(`members:${auth.business.id}`, 20, 3600);
  const input = await readJson(request, MemberInput);
  return json({ member: await addStaffMember(auth.business.id, input, auth.actor) }, { status: 201 });
});
