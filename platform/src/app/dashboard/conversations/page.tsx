import type { Metadata } from "next";
import { requirePageAuth } from "@/server/auth";
import { listConversations } from "@/server/admin/inbox";
import { Inbox } from "./inbox";

export const metadata: Metadata = { title: "Conversations" };

export default async function ConversationsPage(props: PageProps<"/dashboard/conversations">) {
  const auth = await requirePageAuth();
  const params = await props.searchParams;
  const selected = typeof params.c === "string" ? params.c : null;
  const conversations = await listConversations(auth.business.id);
  return (
    <Inbox
      timeZone={auth.business.timezone}
      currency={auth.business.currency}
      initialSelected={selected ?? conversations[0]?.id ?? null}
      initialList={conversations.map((c) => ({
        ...c,
        lastMessageAt: c.lastMessageAt.toISOString(),
        lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
      }))}
    />
  );
}
