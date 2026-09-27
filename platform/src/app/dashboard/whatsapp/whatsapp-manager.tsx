"use client";

import Link from "next/link";
import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  MessageCircle,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  Smartphone,
  Unplug,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/app/common";
import { ConfirmButton, Field } from "@/components/app/controls";
import { useRealtime } from "@/components/app/realtime";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api-client";
import { formatPhone, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TemplatesTab, type Template } from "./templates-tab";
import { MessagesTab, type StatusMessage } from "./messages-tab";

type Health = { key: string; label: string; ok: boolean; detail: string };
type Overview = {
  status: "disconnected" | "connecting" | "connected" | "error";
  setup: {
    embeddedSignupAvailable: boolean;
    appId: string | null;
    configId: string | null;
    graphVersion: string;
    webhookUrl: string;
    webhookVerifyTokenSet: boolean;
    appSecretSet: boolean;
    serverCredentialsAvailable: boolean;
  };
  connection: {
    connectedVia: "embedded_signup" | "manual" | null;
    wabaId: string | null;
    wabaName: string | null;
    phoneNumberId: string | null;
    displayPhoneNumber: string;
    verifiedName: string;
    qualityRating: string | null;
    health: Health[];
    lastHealthCheckAt: string | null;
    lastWebhookEventAt: string | null;
    lastError: string | null;
    connectedAt: string | null;
  } | null;
  stats: { messages: number; orders: number };
  bot: { aiEnabled: boolean; humanHandoffEnabled: boolean; botName: string };
};

declare global {
  interface Window {
    fbAsyncInit?: () => void;
    FB?: {
      init: (options: Record<string, unknown>) => void;
      login: (callback: (response: { authResponse?: { code?: string } | null; status?: string }) => void, options: Record<string, unknown>) => void;
    };
  }
}

const TABS = [
  { key: "connection", label: "Connection" },
  { key: "templates", label: "Templates" },
  { key: "messages", label: "Status messages" },
] as const;

export function WhatsAppManager({
  tab,
  isOwner,
  businessName,
  overview,
  templates,
  statusMessages,
}: {
  tab: "connection" | "templates" | "messages";
  isOwner: boolean;
  businessName: string;
  overview: Overview;
  templates: Template[];
  statusMessages: StatusMessage[];
}) {
  const router = useRouter();
  useRealtime((event) => {
    if (event.type === "whatsapp.updated") router.refresh();
  });

  return (
    <>
      <PageHeader title="WhatsApp" description="Your WhatsApp Business connection, message templates and automatic customer messages." />
      <nav className="mb-6 flex gap-1 border-b">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "connection" ? "/dashboard/whatsapp" : `/dashboard/whatsapp?tab=${t.key}`}
            className={cn(
              "-mb-px border-b-2 border-transparent px-3 pb-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
              tab === t.key && "border-primary text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "connection" ? <ConnectionTab overview={overview} isOwner={isOwner} businessName={businessName} /> : null}
      {tab === "templates" ? <TemplatesTab templates={templates} isOwner={isOwner} connected={overview.status === "connected"} /> : null}
      {tab === "messages" ? <MessagesTab messages={statusMessages} isOwner={isOwner} /> : null}
    </>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs">
        <span className="min-w-0 flex-1 truncate">{value}</span>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard.writeText(value);
            toast.success("Copied");
          }}
        >
          <Copy className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

type Step = { label: string; state: "done" | "active" | "todo" };

function ConnectingSteps({ steps }: { steps: Step[] }) {
  return (
    <ol className="mx-auto flex w-full max-w-xs flex-col gap-3 text-left">
      {steps.map((step) => (
        <li key={step.label} className="flex items-center gap-3 text-sm">
          {step.state === "done" ? (
            <CheckCircle2 className="size-5 text-emerald-500" />
          ) : step.state === "active" ? (
            <Loader2 className="size-5 animate-spin text-primary" />
          ) : (
            <Circle className="size-5 text-muted-foreground/40" />
          )}
          <span className={cn(step.state === "todo" && "text-muted-foreground")}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

function ConnectionTab({ overview, isOwner, businessName }: { overview: Overview; isOwner: boolean; businessName: string }) {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [showManual, setShowManual] = useState(!overview.setup.embeddedSignupAvailable);
  const [sdkReady, setSdkReady] = useState(false);
  const signup = useRef<{ phoneNumberId?: string; wabaId?: string; code?: string }>({});
  const c = overview.connection;
  const connected = overview.status === "connected" && c;

  const finishing = useRef(false);
  const maybeFinish = async () => {
    const { code, phoneNumberId, wabaId } = signup.current;
    if (!code || !phoneNumberId || !wabaId || finishing.current) return;
    finishing.current = true;
    setSteps([
      { label: "Account selected", state: "done" },
      { label: "Phone number selected", state: "done" },
      { label: "Verifying connection", state: "active" },
    ]);
    try {
      await api("/api/whatsapp/connect", { body: { mode: "embedded", code, phoneNumberId, wabaId } });
      toast.success("WhatsApp connected");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      finishing.current = false;
      signup.current = {};
      setSteps(null);
    }
  };

  // Embedded Signup session info arrives via postMessage from facebook.com.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!/^https:\/\/([a-z0-9-]+\.)*facebook\.com$/.test(event.origin)) return;
      let data: { type?: string; event?: string; data?: { phone_number_id?: string; waba_id?: string } };
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (data.event === "CANCEL") {
        setSteps(null);
        toast.info("WhatsApp connection was cancelled.");
        return;
      }
      if (data.data?.phone_number_id) signup.current.phoneNumberId = data.data.phone_number_id;
      if (data.data?.waba_id) signup.current.wabaId = data.data.waba_id;
      setSteps([
        { label: "Account selected", state: "done" },
        { label: "Phone number selected", state: signup.current.phoneNumberId ? "done" : "active" },
        { label: "Verifying connection", state: signup.current.code ? "active" : "todo" },
      ]);
      void maybeFinish();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const launchSignup = () => {
    if (!window.FB || !overview.setup.configId) {
      toast.error("Meta's sign-in is still loading. Try again in a moment.");
      return;
    }
    signup.current = {};
    setSteps([
      { label: "Account selected", state: "active" },
      { label: "Phone number selected", state: "todo" },
      { label: "Verifying connection", state: "todo" },
    ]);
    window.FB.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          setSteps(null);
          if (response.status !== "connected") toast.info("WhatsApp connection was not completed.");
          return;
        }
        signup.current.code = code;
        void maybeFinish();
        // If Meta didn't send the session info, ask for the IDs manually.
        setTimeout(() => {
          if (signup.current.code && (!signup.current.phoneNumberId || !signup.current.wabaId)) {
            setSteps(null);
            setShowManual(true);
            toast.error("Meta didn't return the phone number details. Enter the IDs below to finish.");
          }
        }, 8000);
      },
      {
        config_id: overview.setup.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      },
    );
  };

  const recheck = async () => {
    setChecking(true);
    try {
      await api("/api/whatsapp/health", { body: {} });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const sdk = overview.setup.embeddedSignupAvailable ? (
    <Script
      src="https://connect.facebook.net/en_US/sdk.js"
      strategy="afterInteractive"
      crossOrigin="anonymous"
      onLoad={() => {
        window.FB?.init({ appId: overview.setup.appId, autoLogAppEvents: true, xfbml: false, version: overview.setup.graphVersion });
        setSdkReady(true);
      }}
    />
  ) : null;

  if (steps) {
    return (
      <>
        {sdk}
        <div className="mx-auto max-w-lg rounded-2xl border bg-card p-8 text-center shadow-xs">
          <span className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary">
            <Loader2 className="size-6 animate-spin" />
          </span>
          <h2 className="mb-6 text-xl font-semibold">Connecting WhatsApp…</h2>
          <ConnectingSteps steps={steps} />
        </div>
      </>
    );
  }

  if (!connected) {
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {sdk}
        <div className="flex flex-col gap-6">
          <div className="rounded-2xl border bg-card p-8 text-center shadow-xs">
            <span className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <Smartphone className="size-7" />
            </span>
            <h2 className="text-xl font-semibold">Connect Your WhatsApp Business</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Connect your WhatsApp Business account to start receiving and responding to customer messages automatically.
            </p>
            {overview.status === "error" && c?.lastError ? (
              <p className="mx-auto mt-4 flex max-w-md items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-left text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {c.lastError}
              </p>
            ) : null}
            <div className="mt-6 flex flex-col items-center gap-3">
              {overview.setup.embeddedSignupAvailable ? (
                <Button size="lg" className="h-11 px-6" onClick={launchSignup} disabled={!isOwner || !sdkReady}>
                  {!sdkReady ? <Loader2 className="size-4 animate-spin" /> : <MessageCircle className="size-4 fill-current" />}
                  Connect WhatsApp
                </Button>
              ) : (
                <p className="max-w-md text-xs text-muted-foreground">
                  One-click connection needs META_APP_ID, META_APP_SECRET and META_EMBEDDED_SIGNUP_CONFIG_ID on the server. You can still connect with a
                  System User access token below.
                </p>
              )}
              {!isOwner ? <p className="text-xs text-muted-foreground">Only the business owner can connect WhatsApp.</p> : null}
              {overview.setup.embeddedSignupAvailable ? (
                <button type="button" className="text-sm text-muted-foreground underline-offset-4 hover:underline" onClick={() => setShowManual((v) => !v)}>
                  {showManual ? "Hide advanced options" : "Connect with an access token instead"}
                </button>
              ) : null}
            </div>
          </div>
          {showManual && isOwner ? <ManualConnect serverAvailable={overview.setup.serverCredentialsAvailable} /> : null}
        </div>
        <SetupChecklist setup={overview.setup} />
      </div>
    );
  }

  const healthy = c.health.length > 0 && c.health.every((h) => h.ok);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex flex-col gap-6">
        <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
          <div className="flex flex-col gap-5 bg-gradient-to-br from-emerald-50 to-transparent p-6 sm:flex-row sm:items-center dark:from-emerald-500/10">
            <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-emerald-500 text-white shadow-sm">
              <Check className="size-7" strokeWidth={3} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">WhatsApp Connected</p>
              <h2 className="truncate text-xl font-semibold">{c.verifiedName || businessName}</h2>
              <p className="text-sm text-muted-foreground">{c.displayPhoneNumber ? formatPhone(c.displayPhoneNumber) : "—"}</p>
            </div>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 self-start rounded-full px-3 py-1 text-sm font-medium sm:self-center",
                overview.bot.aiEnabled ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-muted text-muted-foreground",
              )}
            >
              <span className={cn("size-2 rounded-full", overview.bot.aiEnabled ? "bg-emerald-500" : "bg-zinc-400")} />
              Bot {overview.bot.aiEnabled ? "active" : "paused"}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-px border-t bg-border sm:grid-cols-4">
            {[
              { label: "Business account", value: c.wabaName || c.wabaId || "—" },
              { label: "Status", value: healthy ? "● Active" : "Needs attention" },
              { label: "Messages", value: overview.stats.messages.toLocaleString() },
              { label: "Orders", value: overview.stats.orders.toLocaleString() },
            ].map((item) => (
              <div key={item.label} className="bg-card px-5 py-3">
                <dt className="text-xs text-muted-foreground">{item.label}</dt>
                <dd className={cn("truncate text-sm font-semibold", item.label === "Status" && (healthy ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600"))}>
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-2 border-t p-4">
            <Link href="/dashboard/conversations" className={buttonVariants()}>
              <MessageCircle className="size-4" /> Open conversations
            </Link>
            <Link href="/dashboard/bot" className={buttonVariants({ variant: "outline" })}>
              <Bot className="size-4" /> Bot settings
            </Link>
            <Button variant="outline" onClick={recheck} disabled={checking}>
              {checking ? <Loader2 className="size-4 animate-spin" /> : <Settings2 className="size-4" />} Manage connection
            </Button>
            {isOwner ? (
              <ConfirmButton
                variant="ghost"
                className="ml-auto text-rose-600 hover:text-rose-700"
                title="Disconnect WhatsApp?"
                description="The assistant stops receiving and replying to messages until you connect again. Conversations and orders are kept."
                confirmLabel="Disconnect"
                destructive
                onConfirm={async () => {
                  try {
                    await api("/api/whatsapp/disconnect", { body: {} });
                    toast.success("WhatsApp disconnected");
                    router.refresh();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                <Unplug className="size-4" /> Disconnect
              </ConfirmButton>
            ) : null}
          </div>
        </div>

        <SectionCard
          title="Connection health"
          description={c.lastHealthCheckAt ? `Checked ${relativeTime(c.lastHealthCheckAt)}` : "Not checked yet"}
          actions={
            <Button variant="outline" size="sm" onClick={recheck} disabled={checking}>
              {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Check again
            </Button>
          }
          bodyClassName="p-0"
        >
          <ul className="divide-y">
            {c.health.map((check) => (
              <li key={check.key} className="flex items-start gap-3 px-5 py-3">
                {check.ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 size-5 shrink-0 text-rose-500" />}
                <div className="min-w-0">
                  <p className="text-sm font-medium">{check.label}</p>
                  <p className="text-sm break-words text-muted-foreground">{check.detail}</p>
                </div>
              </li>
            ))}
            {!c.health.length ? <li className="px-5 py-4 text-sm text-muted-foreground">Run a check to verify the connection.</li> : null}
          </ul>
        </SectionCard>
      </div>
      <div className="flex flex-col gap-6">
        <SectionCard title="Connection details">
          <div className="grid gap-3">
            <CopyValue label="Phone number ID" value={c.phoneNumberId ?? "—"} />
            <CopyValue label="WhatsApp Business Account ID" value={c.wabaId ?? "—"} />
            <p className="text-xs text-muted-foreground">
              Connected {c.connectedAt ? relativeTime(c.connectedAt) : ""} via {c.connectedVia === "embedded_signup" ? "Meta Embedded Signup" : "access token"}
              {c.qualityRating ? ` · Quality: ${c.qualityRating}` : ""}
              {c.lastWebhookEventAt ? ` · Last webhook ${relativeTime(c.lastWebhookEventAt)}` : ""}
            </p>
          </div>
        </SectionCard>
        <SetupChecklist setup={overview.setup} compact />
      </div>
    </div>
  );
}

function ManualConnect({ serverAvailable }: { serverAvailable: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"manual" | "server" | null>(null);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    setBusy("manual");
    try {
      await api("/api/whatsapp/connect", { body: { mode: "manual", ...form } });
      toast.success("WhatsApp connected");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const useServer = async () => {
    setBusy("server");
    try {
      await api("/api/whatsapp/connect", { body: { mode: "server" } });
      toast.success("WhatsApp connected");
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <SectionCard title="Connect with an access token" description="Use a permanent System User token from Meta Business Settings with whatsapp_business_messaging and whatsapp_business_management.">
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Access token" htmlFor="wa-token" hint="Stored encrypted on the server. It is never shown again.">
          <Input id="wa-token" name="accessToken" type="password" autoComplete="off" required placeholder="EAAG…" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone number ID" htmlFor="wa-phone">
            <Input id="wa-phone" name="phoneNumberId" inputMode="numeric" required placeholder="1234567890" />
          </Field>
          <Field label="WhatsApp Business Account ID" htmlFor="wa-waba">
            <Input id="wa-waba" name="wabaId" inputMode="numeric" required placeholder="1234567890" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy !== null}>
            {busy === "manual" ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} Verify & connect
          </Button>
          {serverAvailable ? (
            <Button type="button" variant="outline" onClick={useServer} disabled={busy !== null}>
              {busy === "server" ? <Loader2 className="size-4 animate-spin" /> : <Server className="size-4" />} Use server credentials
            </Button>
          ) : null}
        </div>
      </form>
    </SectionCard>
  );
}

function SetupChecklist({ setup, compact }: { setup: Overview["setup"]; compact?: boolean }) {
  const items = [
    { ok: setup.appSecretSet, label: "App secret configured", detail: "META_APP_SECRET verifies that webhooks really come from Meta." },
    { ok: setup.webhookVerifyTokenSet, label: "Webhook verify token configured", detail: "META_WEBHOOK_VERIFY_TOKEN — paste the same value in the Meta app." },
    { ok: setup.embeddedSignupAvailable, label: "Embedded Signup configured", detail: "META_APP_ID + META_EMBEDDED_SIGNUP_CONFIG_ID enable one-click connect." },
  ];
  return (
    <SectionCard title="Meta app setup" description={compact ? undefined : "One-time setup in your Meta developer app."}>
      <div className="grid gap-4">
        <CopyValue label="Webhook callback URL" value={setup.webhookUrl} />
        <p className="text-xs text-muted-foreground">
          In the Meta app go to WhatsApp → Configuration, set this callback URL with your verify token, and subscribe to the <code>messages</code> field.
        </p>
        <ul className="grid gap-2.5">
          {items.map((item) => (
            <li key={item.label} className="flex gap-2.5 text-sm">
              {item.ok ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />}
              <span>
                <span className="font-medium">{item.label}</span>
                {!item.ok ? <span className="block text-xs text-muted-foreground">{item.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
        <a
          href="https://developers.facebook.com/docs/whatsapp/embedded-signup"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Meta Embedded Signup guide <ExternalLink className="size-3" />
        </a>
      </div>
    </SectionCard>
  );
}
