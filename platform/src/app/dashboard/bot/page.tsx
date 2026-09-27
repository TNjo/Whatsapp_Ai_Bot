import type { Metadata } from "next";
import { PageHeader } from "@/components/app/common";
import { requirePageAuth } from "@/server/auth";
import { DEFAULT_RULE_IDS, getBotSettingsView, providerOptions } from "@/server/admin/bot";
import { BotSettingsForm } from "./bot-settings-form";
import { BotTabs } from "./bot-tabs";

export const metadata: Metadata = { title: "Bot settings" };

export default async function BotSettingsPage() {
  const auth = await requirePageAuth();
  const settings = await getBotSettingsView(auth.business.id);
  return (
    <>
      <PageHeader
        title="AI assistant"
        description="How your WhatsApp assistant introduces itself, the rules it follows and the AI model that powers it."
      />
      <BotTabs />
      <BotSettingsForm
        initial={settings}
        providers={providerOptions()}
        defaultRuleIds={DEFAULT_RULE_IDS}
        canEdit={auth.role === "owner"}
      />
    </>
  );
}
