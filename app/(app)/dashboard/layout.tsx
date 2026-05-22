import { Toaster } from "@/components/ui/sonner";
import { SideNav } from "./nav";
import { MobileNav } from "./mobile-nav";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");

  // Path A: single workspace per user, hidden from UI. Every account auto-gets
  // a personal org so the dashboard always has a workspace_id to scope queries.
  // The redirect is only paid on the very first dashboard load after signup —
  // it refreshes the session JWT so orgId becomes available.
  if (!orgId) {
    const client = await clerkClient();
    const memberships = await client.users.getOrganizationMembershipList({ userId });
    if (memberships.totalCount === 0) {
      const user = await client.users.getUser(userId);
      const name = user.firstName ? `${user.firstName}'s workspace` : "My workspace";
      await client.organizations.createOrganization({ name, createdBy: userId });
    }
    redirect("/dashboard");
  }

  // First-time onboarding gate. Welcome lives outside this layout (/welcome)
  // so we can redirect freely without re-entering. Existing users who already
  // have tracked creators are auto-marked so they never see the wizard.
  const sb = supabaseAdmin();
  const { data: onboarded } = await sb
    .from("settings")
    .select("key")
    .eq("workspace_id", orgId)
    .eq("key", "onboarded_at")
    .maybeSingle();

  if (!onboarded) {
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

  // Pending shared-bookmark invites: count for the sidebar badge. We
  // count both user-id matches AND pending-by-email rows so a freshly
  // signed-up recipient sees the badge before the page-level resolve
  // runs. The bookmarks page does the resolve on first visit.
  let pendingSharedBookmarks = 0;
  {
    const user = await currentUser();
    const email =
      user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? null;
    const { count: byUid } = await sb
      .from("shared_bookmarks")
      .select("id", { count: "exact", head: true })
      .eq("recipient_user_id", userId)
      .eq("status", "pending");
    let byEmail = 0;
    if (email) {
      const { count } = await sb
        .from("shared_bookmarks")
        .select("id", { count: "exact", head: true })
        .eq("recipient_email", email.toLowerCase())
        .eq("status", "pending")
        .is("recipient_user_id", null);
      byEmail = count ?? 0;
    }
    pendingSharedBookmarks = (byUid ?? 0) + byEmail;
  }
  const navBadges: Record<string, number> = {};
  if (pendingSharedBookmarks > 0) {
    navBadges["/dashboard/bookmarks"] = pendingSharedBookmarks;
  }

  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="hidden lg:flex w-60 shrink-0 bg-sidebar border-r border-border/60 flex-col sticky top-0 h-screen">
        <div className="h-20 flex items-center gap-2.5 px-5">
          <Image
            src="/lavaIconTransparent.png"
            alt="L.A.V.A"
            width={48}
            height={48}
            priority
            className="h-12 w-12 rounded-lg shrink-0"
          />
        </div>
        <div className="px-3 pt-1 flex-1 overflow-y-auto">
          <SideNav badges={navBadges} />
        </div>
        <div className="px-3 py-3 border-t border-border/60">
          <UserButton
            showName
            appearance={{
              elements: {
                userButtonTrigger:
                  "w-full px-3 py-2 rounded-lg hover:bg-accent/60 text-sm focus:shadow-none",
                userButtonBox: "flex-row-reverse w-full justify-end gap-2",
                userButtonOuterIdentifier: "text-sm",
              },
            }}
          />
        </div>
      </aside>
      <main className="flex-1 min-w-0 pb-16 lg:pb-0">
        {/* Mobile top bar with logo + user button */}
        <div className="lg:hidden sticky top-0 z-30 h-14 flex items-center justify-between px-4 bg-sidebar/95 backdrop-blur border-b border-border/60">
          <Image
            src="/lavaIconTransparent.png"
            alt="L.A.V.A"
            width={28}
            height={28}
            priority
            className="h-7 w-7 rounded-md shrink-0"
          />
          <UserButton
            appearance={{
              elements: {
                userButtonTrigger: "rounded-full focus:shadow-none",
              },
            }}
          />
        </div>
        <div className="max-w-[1400px] mx-auto px-4 sm:px-8 lg:px-10 py-4 sm:py-8 lg:py-10">
          {children}
        </div>
      </main>
      <MobileNav badges={navBadges} />
      <Toaster richColors closeButton position="top-right" />
    </div>
  );
}
