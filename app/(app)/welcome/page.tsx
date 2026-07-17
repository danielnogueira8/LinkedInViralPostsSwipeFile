import { scopedSupabase } from "@/lib/supabase-scoped";
import { visibleCategoriesOr } from "@/lib/categories";
import { assertNoQueryError } from "@/lib/query-error";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { WelcomeWizard, type WelcomeCategory } from "./welcome-wizard";
import { Toaster } from "@/components/ui/sonner";

export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const sb = await scopedSupabase();

  // If they've already been onboarded, don't re-show this. (Defensive — the
  // layout already redirects, but a direct URL hit shouldn't trap them here.)
  const { data: onboardedRow } = await sb
    .settings()
    .eq("key", "onboarded_at")
    .maybeSingle();
  if (onboardedRow) redirect("/dashboard");

  const [catRes, catAccountsRes] = await Promise.all([
    sb.raw
      .from("categories")
      .select("id, label, sort_order")
      .or(visibleCategoriesOr(sb.workspaceId))
      .order("sort_order"),
    sb.raw
      .from("accounts")
      .select("id, name, category_id")
      .not("category_id", "is", null)
      .order("name"),
  ]);
  // Surface a read failure rather than rendering an empty category picker that
  // blocks first-run setup. The (app) error boundary shows a recoverable retry.
  assertNoQueryError("onboarding categories", catRes, catAccountsRes);
  const { data: catRows } = catRes;
  const { data: catAccounts } = catAccountsRes;

  const categories: WelcomeCategory[] = (catRows ?? [])
    .map((c) => {
      const creators = (catAccounts ?? []).filter((a) => a.category_id === c.id);
      return {
        id: c.id as string,
        label: c.label as string,
        count: creators.length,
        sample: creators[0]?.name ?? null,
      };
    })
    .filter((c) => c.count > 0);

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <WelcomeWizard categories={categories} />
      <Toaster closeButton position="top-right" />
    </div>
  );
}
