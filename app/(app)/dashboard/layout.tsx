import { Toaster } from "@/components/ui/sonner";
import { SideNav } from "./nav";
import { MobileNav } from "./mobile-nav";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { verifiedPrimaryEmail } from "@/lib/shared-bookmarks";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");

  // Path A: single workspace per user, hidden from UI. Every account auto-gets
  // a personal org so the dashboard always has a workspace_id to scope queries.
  //
  // Critical: we must NOT trust a stale/inherited active orgId. Clerk caches
  // the last active organization on the session token, so a user signing in
  // on a browser where another account was active can inherit THAT account's
  // org — which would scope their queries to someone else's workspace (this is
  // exactly the "my test account saw my main account's bookmarks" bug). So we
  // verify the active orgId is one this user actually belongs to; if it isn't
  // (or there's no active org), we resolve their OWN personal org and force a
  // re-selection.
  {
    const client = await clerkClient();
    const memberships = await client.users.getOrganizationMembershipList({ userId });
    const ownOrgIds = new Set(memberships.data.map((m) => m.organization.id));
    const activeIsOwn = !!orgId && ownOrgIds.has(orgId);

    if (!activeIsOwn) {
      // Find this user's own personal org, or create one. Personal orgs are
      // those this user created (createdBy === userId).
      let ownOrgId =
        memberships.data.find((m) => m.organization.createdBy === userId)?.organization.id ??
        memberships.data[0]?.organization.id ??
        null;

      if (!ownOrgId) {
        const user = await client.users.getUser(userId);
        const emailLocal =
          user.emailAddresses
            ?.find((e) => e.id === user.primaryEmailAddressId)
            ?.emailAddress?.split("@")[0] ??
          user.emailAddresses?.[0]?.emailAddress?.split("@")[0] ??
          userId.slice(-6);
        // Unique-ish name so personal orgs are distinguishable in the Clerk
        // admin view (previously every "Daniel" got "Daniel's workspace").
        const name = user.firstName
          ? `${user.firstName}'s workspace (${emailLocal})`
          : `${emailLocal}'s workspace`;
        const created = await client.organizations.createOrganization({
          name,
          createdBy: userId,
        });
        ownOrgId = created.id;
      }

      // Force the session's active org to the user's own. setActive is
      // client-side only, so we route through a server action page that calls
      // it, then returns here with the correct orgId on the token.
      redirect(`/select-workspace?org=${encodeURIComponent(ownOrgId)}`);
    }
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
  //
  // The two counts run in parallel (were sequential). We keep them as
  // separate .eq() queries rather than folding into a .or() string so
  // the email value never gets interpolated into a PostgREST filter
  // expression (emails can contain characters that are structural in
  // .or() grammar).
  let pendingSharedBookmarks = 0;
  {
    const user = await currentUser();
    // Count pending-by-email invites only against a VERIFIED primary email,
    // matching the resolution logic — an unverified address must not surface
    // (or later claim) someone else's invite. Already lowercased.
    const email = verifiedPrimaryEmail(user);
    const [byUidRes, byEmailRes] = await Promise.all([
      sb
        .from("shared_bookmarks")
        .select("id", { count: "exact", head: true })
        .eq("recipient_user_id", userId)
        .eq("status", "pending"),
      email
        ? sb
            .from("shared_bookmarks")
            .select("id", { count: "exact", head: true })
            .eq("recipient_email", email)
            .eq("status", "pending")
            .is("recipient_user_id", null)
        : Promise.resolve({ count: 0 }),
    ]);
    pendingSharedBookmarks = (byUidRes.count ?? 0) + (byEmailRes.count ?? 0);
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
            src="/swipeInIcon.png"
            alt="SwipeIn"
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
            src="/swipeInIcon.png"
            alt="SwipeIn"
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
