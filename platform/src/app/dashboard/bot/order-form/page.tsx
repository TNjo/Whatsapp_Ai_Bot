import type { Metadata } from "next";
import { PageHeader } from "@/components/app/common";
import { requirePageAuth } from "@/server/auth";
import { getOrderFormView } from "@/server/admin/bot";
import { BotTabs } from "../bot-tabs";
import { OrderFormEditor } from "./order-form-editor";

export const metadata: Metadata = { title: "Order form" };

export default async function OrderFormPage() {
  const auth = await requirePageAuth();
  const form = await getOrderFormView(auth.business.id);
  return (
    <>
      <PageHeader
        title="AI assistant"
        description="The details the assistant collects from customers before placing an order. Add fields like size, colour or delivery date."
      />
      <BotTabs />
      <OrderFormEditor
        initial={form.fields}
        paymentMethods={form.paymentMethods}
        businessName={auth.business.name}
        canEdit={auth.role === "owner"}
      />
    </>
  );
}
