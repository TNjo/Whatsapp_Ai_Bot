import type { Metadata } from "next";
import { requirePageAuth } from "@/server/auth";
import { listTemplates, statusMessagesView, whatsappOverview } from "@/server/admin/whatsapp";
import { WhatsAppManager } from "./whatsapp-manager";

export const metadata: Metadata = { title: "WhatsApp" };

export default async function WhatsAppPage(props: PageProps<"/dashboard/whatsapp">) {
  const auth = await requirePageAuth();
  const params = await props.searchParams;
  const tab = params.tab === "templates" || params.tab === "messages" ? params.tab : "connection";
  const [overview, templates, messages] = await Promise.all([
    whatsappOverview(auth.business.id),
    listTemplates(auth.business.id),
    statusMessagesView(auth.business.id),
  ]);
  return (
    <WhatsAppManager
      tab={tab}
      isOwner={auth.role === "owner"}
      businessName={auth.business.name}
      overview={JSON.parse(JSON.stringify(overview))}
      templates={JSON.parse(JSON.stringify(templates))}
      statusMessages={messages}
    />
  );
}
