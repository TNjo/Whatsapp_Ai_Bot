import { requireApiAuth } from "@/server/auth";
import { listAuditLogs } from "@/server/admin/business-settings";
import { json, route } from "@/server/http";

/** Last 100 audit entries. IP addresses are only shown to the owner. */
export const GET = route("business.audit", async (request) => {
  const auth = await requireApiAuth(request);
  const rows = await listAuditLogs(auth.business.id, 100);
  return json({ logs: auth.role === "owner" ? rows : rows.map((row) => ({ ...row, ip: null })) });
});
