import { AppShell } from "@/components/app/app-shell";
import { requirePageAuth } from "@/server/auth";
import { shellCounts } from "@/server/queries/shell";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const auth = await requirePageAuth();
  const counts = await shellCounts(auth.business.id);
  return (
    <AppShell user={{ name: auth.user.name, email: auth.user.email }} business={{ name: auth.business.name }} role={auth.role} counts={counts}>
      {children}
    </AppShell>
  );
}
