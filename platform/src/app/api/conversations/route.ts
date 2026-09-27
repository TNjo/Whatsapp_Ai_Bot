import { requireApiAuth } from "@/server/auth";
import { listConversations, type InboxFilter } from "@/server/admin/inbox";
import { json, route } from "@/server/http";

const FILTERS = new Set(["all", "human", "unread", "active", "resolved"]);

export const GET = route("conversations.list", async (request) => {
  const auth = await requireApiAuth(request);
  const url = new URL(request.url);
  const filter = FILTERS.has(url.searchParams.get("filter") ?? "") ? (url.searchParams.get("filter") as InboxFilter) : "all";
  const conversations = await listConversations(auth.business.id, {
    filter,
    q: url.searchParams.get("q") ?? "",
    includeTest: url.searchParams.get("test") === "1",
  });
  return json({ conversations });
});
