import type { Metadata } from "next";
import { PageHeader } from "@/components/app/common";
import { requirePageAuth } from "@/server/auth";
import { testChat } from "@/server/admin/bot-test";
import { loadBotContext } from "@/server/bot/settings";
import { BotTabs } from "../bot-tabs";
import { TestBot } from "./test-bot";

export const metadata: Metadata = { title: "Test bot" };

export default async function TestBotPage() {
  const auth = await requirePageAuth();
  const [chat, bot] = await Promise.all([testChat(auth), loadBotContext(auth.business.id)]);
  return (
    <>
      <PageHeader
        title="AI assistant"
        description="Chat with your assistant exactly as a customer would. It uses your real products, services, FAQs, instructions and order rules — nothing is sent on WhatsApp."
      />
      <BotTabs />
      <TestBot
        initial={JSON.parse(JSON.stringify(chat))}
        timeZone={auth.business.timezone}
        botName={bot.settings.botName}
        aiReady={Boolean(bot.aiConfig)}
        aiEnabled={bot.settings.aiEnabled}
        aiLabel={bot.aiConfig ? `${bot.aiConfig.provider} · ${bot.aiConfig.model}` : null}
        testCreatesOrders={bot.settings.testModeCreatesOrders}
        productCount={null}
      />
    </>
  );
}
