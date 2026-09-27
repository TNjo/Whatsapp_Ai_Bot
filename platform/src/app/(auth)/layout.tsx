import { redirect } from "next/navigation";
import { CheckCircle2, MessageCircle, ShieldCheck, Sparkles } from "lucide-react";
import { getAuth } from "@/server/auth";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await getAuth()) redirect("/dashboard");
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-[#06241a] p-10 text-emerald-50 lg:flex">
        <div
          aria-hidden
          className="absolute inset-0 opacity-70"
          style={{
            background:
              "radial-gradient(800px 480px at 0% 0%, rgba(52,211,153,.35), transparent 60%), radial-gradient(700px 500px at 110% 110%, rgba(99,102,241,.3), transparent 60%)",
          }}
        />
        <div className="relative flex items-center gap-2.5 text-lg font-semibold">
          <span className="grid size-9 place-items-center rounded-lg bg-emerald-500 text-emerald-950">
            <MessageCircle className="size-5 fill-current" />
          </span>
          Chatdesk
        </div>
        <div className="relative max-w-lg">
          <h2 className="text-4xl leading-tight font-semibold tracking-tight text-white">Sell on WhatsApp while your assistant does the typing.</h2>
          <p className="mt-4 text-emerald-100/80">
            Connect your WhatsApp Business number. Your AI assistant answers questions from your real catalog, collects orders, and keeps
            customers updated as you confirm and ship.
          </p>
          <div className="mt-8 flex max-w-sm flex-col gap-2 text-sm">
            <div className="self-start rounded-2xl rounded-bl-sm bg-white/10 px-3.5 py-2 backdrop-blur">Do you have black shirts in large?</div>
            <div className="self-end rounded-2xl rounded-br-sm bg-emerald-100 px-3.5 py-2 text-emerald-950">
              <span className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                <Sparkles className="size-3" /> Assistant
              </span>
              Yes! Classic Black T-Shirt — Rs. 2,500, size L in stock. Want me to add 1 to your order?
            </div>
          </div>
        </div>
        <ul className="relative flex flex-wrap gap-x-6 gap-y-2 text-sm text-emerald-100/80">
          <li className="flex items-center gap-2"><ShieldCheck className="size-4 text-emerald-400" /> Official WhatsApp Cloud API</li>
          <li className="flex items-center gap-2"><CheckCircle2 className="size-4 text-emerald-400" /> Orders only after customer confirmation</li>
        </ul>
      </aside>
      <main className="flex items-center justify-center px-6 py-12">{children}</main>
    </div>
  );
}
