import { SideNav } from "./nav";
import { MobileNav } from "./mobile-nav";
import { UsagePill } from "./usage-pill";
import { FirstRunChecklist } from "./first-run-checklist";
import { DashboardClientChrome } from "./client-chrome";
import { DashboardContentFrame } from "./content-frame";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { resolvePersonalWorkspaceForUser } from "@/lib/personal-workspace";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");

  const personalWorkspaceId = await resolvePersonalWorkspaceForUser(userId);
  if (orgId !== personalWorkspaceId) redirect("/select-workspace");

  // First-time onboarding gate. Welcome lives outside this layout (/welcome)
  // so we can redirect freely without re-entering. Existing users who already
  // have tracked creators are auto-marked so they never see the wizard.
  const sb = supabaseAdmin();
  const [onboardedRes] = await Promise.all([
    sb
      .from("settings")
      .select("key")
      .eq("workspace_id", orgId)
      .eq("key", "onboarded_at")
      .maybeSingle(),
  ]);

  if (!onboardedRes.data) {
    const { count: trackedCount } = await sb
      .from("workspace_accounts")
      .select("account_id", { count: "exact", head: true })
      .eq("workspace_id", orgId);

    if ((trackedCount ?? 0) > 0) {
      await sb.from("settings").upsert(
        {
          workspace_id: orgId,
          key: "onboarded_at",
          value: { at: new Date().toISOString(), backfilled: true },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,key" },
      );
    } else {
      redirect("/welcome");
    }
  }

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* Sidebar shares the page background (no distinct rail / border line) —
          the reference draws the user card + active nav item as white bordered
          boxes sitting on the shared surface. */}
      <aside className="hidden lg:flex w-64 shrink-0 bg-sidebar flex-col sticky top-0 h-screen p-3">
        <div className="flex-1 overflow-y-auto">
          <SideNav />
        </div>
        {/* First-run setup checklist — sits between the nav and the user card.
            Self-hides once dismissed or all steps are complete. */}
        <div className="pt-3">
          <FirstRunChecklist />
        </div>
        {/* Boxed workspace/user header — white bordered card — now sits above
            the monthly-credits pill at the bottom, not above the nav. */}
        <div className="pt-2 flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 shadow-soft">
          <Image
            src="/swipeInIcon.png"
            alt="SwipeIn"
            width={36}
            height={36}
            priority
            className="h-9 w-9 rounded-lg shrink-0"
          />
          <UserButton
            showName
            appearance={{
              elements: {
                rootBox: "min-w-0 flex-1",
                userButtonTrigger:
                  "w-full rounded-md hover:bg-accent/60 text-sm focus:shadow-none",
                userButtonBox: "flex-row-reverse w-full justify-end gap-2",
                userButtonOuterIdentifier: "text-sm font-medium truncate",
              },
            }}
          />
        </div>
        <div className="pt-2">
          <UsagePill />
        </div>
      </aside>
      <main className="flex-1 min-w-0 pb-16 lg:pb-0">
        {/* Mobile top bar with logo + user button */}
        <div className="lg:hidden sticky top-0 z-30 h-14 flex items-center justify-between px-4 bg-sidebar/95 backdrop-blur border-b border-border">
          <Image
            src="/swipeInIcon.png"
            alt="SwipeIn"
            width={28}
            height={28}
            priority
            className="h-7 w-7 rounded-md shrink-0"
          />
          <div className="flex items-center gap-1">
            <UsagePill />
            <UserButton
              appearance={{
                elements: {
                  userButtonTrigger: "rounded-full focus:shadow-none",
                },
              }}
            />
          </div>
        </div>
        <DashboardContentFrame>{children}</DashboardContentFrame>
      </main>
      <MobileNav />
      <DashboardClientChrome />
    </div>
  );
}
