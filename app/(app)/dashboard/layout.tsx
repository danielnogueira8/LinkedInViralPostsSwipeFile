import { Toaster } from "@/components/ui/sonner";
import { SideNav } from "./nav";
import { MobileNav } from "./mobile-nav";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

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

  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="hidden lg:flex w-60 shrink-0 bg-sidebar border-r border-border/60 flex-col sticky top-0 h-screen">
        <div className="h-16 flex items-center gap-2.5 px-5">
          <Image
            src="/swipefileLogo.png"
            alt="Swipe File"
            width={32}
            height={32}
            priority
            className="h-8 w-8 rounded-lg shrink-0"
          />
          <div>
            <div className="font-display text-lg leading-tight tracking-tight">Swipe File</div>
            <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">LinkedIn intel</div>
          </div>
        </div>
        <div className="px-3 pt-1 flex-1 overflow-y-auto">
          <SideNav />
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
          <div className="flex items-center gap-2">
            <Image
              src="/swipefileLogo.png"
              alt="Swipe File"
              width={28}
              height={28}
              priority
              className="h-7 w-7 rounded-md shrink-0"
            />
            <div className="font-display text-base leading-none tracking-tight">Swipe File</div>
          </div>
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
      <MobileNav />
      <Toaster richColors closeButton position="top-right" />
    </div>
  );
}
