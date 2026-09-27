import type { Metadata } from "next";
import Link from "next/link";
import { Building2, History, Users } from "lucide-react";
import { PageHeader } from "@/components/app/common";
import { cn } from "@/lib/utils";
import { requirePageAuth } from "@/server/auth";
import { getBusinessProfile, listAuditLogs, listMembers } from "@/server/admin/business-settings";
import { ActivityLog } from "./activity-log";
import { BusinessProfileForm } from "./business-profile-form";
import { TeamManager } from "./team-manager";

export const metadata: Metadata = { title: "Settings" };

const TABS = [
  { key: "profile", label: "Business profile", icon: Building2 },
  { key: "team", label: "Team", icon: Users },
  { key: "activity", label: "Activity log", icon: History },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function timezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["Asia/Colombo", "UTC"];
  }
}

export default async function SettingsPage(props: PageProps<"/dashboard/settings">) {
  const auth = await requirePageAuth();
  const searchParams = await props.searchParams;
  const tab: TabKey = TABS.some((t) => t.key === searchParams.tab) ? (searchParams.tab as TabKey) : "profile";
  const isOwner = auth.role === "owner";

  return (
    <>
      <PageHeader title="Settings" description="Your business details, the people who can sign in, and a record of every change." />

      <nav aria-label="Settings sections" className="mb-6 overflow-x-auto">
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px] text-muted-foreground">
          {TABS.map(({ key, label, icon: Icon }) => (
            <Link
              key={key}
              href={key === "profile" ? "/dashboard/settings" : `/dashboard/settings?tab=${key}`}
              aria-current={tab === key ? "page" : undefined}
              scroll={false}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors",
                tab === key ? "bg-background text-foreground shadow-sm dark:bg-input/30" : "hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </div>
      </nav>

      {tab === "profile" ? <ProfileTab businessId={auth.business.id} canEdit={isOwner} /> : null}
      {tab === "team" ? <TeamTab businessId={auth.business.id} canManage={isOwner} currentUserId={auth.user.id} /> : null}
      {tab === "activity" ? <ActivityTab businessId={auth.business.id} showIp={isOwner} timeZone={auth.business.timezone} /> : null}
    </>
  );
}

async function ProfileTab({ businessId, canEdit }: { businessId: string; canEdit: boolean }) {
  const profile = await getBusinessProfile(businessId);
  const { updatedAt, ...rest } = profile;
  return <BusinessProfileForm key={updatedAt.toISOString()} profile={rest} canEdit={canEdit} timezones={timezones()} />;
}

async function TeamTab({ businessId, canManage, currentUserId }: { businessId: string; canManage: boolean; currentUserId: string }) {
  const members = await listMembers(businessId);
  return (
    <TeamManager
      canManage={canManage}
      currentUserId={currentUserId}
      members={members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() }))}
    />
  );
}

async function ActivityTab({ businessId, showIp, timeZone }: { businessId: string; showIp: boolean; timeZone: string }) {
  const logs = await listAuditLogs(businessId, 100);
  return <ActivityLog logs={logs.map((l) => ({ ...l, ip: showIp ? l.ip : null }))} timeZone={timeZone} />;
}
