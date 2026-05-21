import { scopedSupabase } from "@/lib/supabase-scoped";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { WelcomeWizard, type WelcomeCategory } from "./welcome-wizard";
import { Toaster } from "@/components/ui/sonner";

export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");
  if (!orgId) redirect("/dashboard");

  const sb = await scopedSupabase();

  // If they've already been onboarded, don't re-show this. (Defensive — the
  // layout already redirects, but a direct URL hit shouldn't trap them here.)
  const { data: onboardedRow } = await sb
    .settings()
    .eq("key", "onboarded_at")
    .maybeSingle();
  if (onboardedRow) redirect("/dashboard");

  const [{ data: catRows }, { data: catAccounts }] = await Promise.all([
    sb.raw.from("categories").select("id, label, sort_order").order("sort_order"),
    sb.raw
      .from("accounts")
      .select("id, name, category_id")
      .not("category_id", "is", null)
      .order("name"),
  ]);

  const categories: WelcomeCategory[] = (catRows ?? []).map((c) => {
    const creators = (catAccounts ?? []).filter((a) => a.category_id === c.id);
    return {
      id: c.id as string,
      label: c.label as string,
      count: creators.length,
      sample: creators[0]?.name ?? null,
    };
  });

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <WelcomeWizard categories={categories} />
      <Toaster richColors closeButton position="top-right" />
    </div>
  );
}
