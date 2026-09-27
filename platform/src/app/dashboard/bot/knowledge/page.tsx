import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, FileUp } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/app/common";
import { buttonVariants } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import { requirePageAuth } from "@/server/auth";
import { getBusinessFacts, listKnowledge } from "@/server/admin/bot";
import { BotTabs } from "../bot-tabs";
import { KnowledgeManager } from "./knowledge-manager";

export const metadata: Metadata = { title: "Bot knowledge" };

export default async function BotKnowledgePage() {
  const auth = await requirePageAuth();
  const [knowledge, facts] = await Promise.all([listKnowledge(auth.business.id), getBusinessFacts(auth.business.id)]);

  const info: { label: string; value: string }[] = [
    { label: "About", value: facts.description },
    { label: "Opening hours", value: facts.openingHours },
    { label: "Delivery", value: facts.deliveryInfo },
    { label: "Delivery fee", value: facts.deliveryFee ? formatMoney(facts.deliveryFee, facts.currency) : "" },
    { label: "Payment methods", value: facts.paymentMethods.join(", ") },
    { label: "Return policy", value: facts.returnPolicy },
    { label: "Exchange policy", value: facts.exchangePolicy },
  ];

  return (
    <>
      <PageHeader
        title="AI assistant"
        description="What the assistant knows beyond your catalogue: answers to common questions and notes about your business."
      />
      <BotTabs />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <KnowledgeManager
          faqs={knowledge.faqs.map((f) => ({ ...f, updatedAt: f.updatedAt.toISOString() }))}
          notes={knowledge.notes.map((n) => ({ ...n, updatedAt: n.updatedAt.toISOString() }))}
        />

        <div className="grid gap-6">
          <SectionCard
            title="Business information"
            description="The assistant already knows these details from your business profile."
            actions={
              <Link href="/dashboard/settings" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Edit <ArrowUpRight className="size-3.5" />
              </Link>
            }
          >
            <dl className="grid gap-3 text-sm">
              {info.map((item) => (
                <div key={item.label}>
                  <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
                  <dd className={item.value ? "mt-0.5 line-clamp-3 whitespace-pre-line" : "mt-0.5 text-muted-foreground/70 italic"}>
                    {item.value || "Not set"}
                  </dd>
                </div>
              ))}
            </dl>
          </SectionCard>

          <div className="flex gap-3 rounded-xl border border-dashed p-4 text-sm">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <FileUp className="size-4" />
            </span>
            <div>
              <p className="font-medium">Documents — coming soon</p>
              <p className="mt-0.5 text-muted-foreground">
                Uploading PDFs and price lists for the assistant to search is on the way. Until then, paste the important parts into a knowledge note.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
