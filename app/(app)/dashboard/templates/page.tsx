import { scopedSupabase, trackedAccountIds } from "@/lib/supabase-scoped";
import { assertNoQueryError } from "@/lib/query-error";
import { getTemplateThresholds } from "@/lib/viral";
import { TemplateRow } from "./row";
import { Card, CardContent } from "@/components/ui/card";
import { FileText } from "lucide-react";
import { BackfillButton } from "./backfill-button";
import Link from "next/link";
import { cn } from "@/lib/utils";

// No `force-dynamic` — the page is already dynamic via auth(), and dropping
// the directive lets Next's client-side Router Cache make back-nav feel instant.

type SP = { type?: string };

const POST_TYPES = new Set(["regular", "lead_magnet"]);

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const postType = sp.type && POST_TYPES.has(sp.type) ? sp.type : null;
  const sb = await scopedSupabase();
  const accountIds = await trackedAccountIds(sb.workspaceId);
  const tplThresholds = await getTemplateThresholds(sb.workspaceId);

  // Guard: workspace tracks no accounts → nothing to show.
  const idFilter = accountIds.length ? accountIds : ["00000000-0000-0000-0000-000000000000"];

  let tplQ = sb.raw
    .from("templates")
    .select("id, template_text, generated_at, model, posts!inner(id, text, post_url, reactions, comments, posted_at, post_type, account_id, accounts(name, niche))")
    .in("posts.account_id", idFilter)
    .order("generated_at", { ascending: false })
    .limit(100);
  if (postType) tplQ = tplQ.eq("posts.post_type", postType);

  const [templatesRes, eligibleRes, existingTplRes] = await Promise.all([
    tplQ,
    sb.raw.from("posts")
      .select("id")
      .in("account_id", idFilter)
      .eq("is_viral", true)
      .not("text", "is", null)
      .or(`reactions.gte.${tplThresholds.min_reactions},comments.gte.${tplThresholds.min_comments}`),
    sb.raw.from("templates")
      .select("post_id, posts!inner(account_id)")
      .in("posts.account_id", idFilter),
  ]);
  // Surface a transient read failure rather than showing "No templates yet"
  // or — worse — a wrong "N still need templating" count and a miscalibrated
  // backfill button when only the eligible/existing reads fail.
  assertNoQueryError("templates", templatesRes, eligibleRes, existingTplRes);
  const { data: rawTemplates } = templatesRes;
  const { data: eligiblePosts } = eligibleRes;
  const { data: existingTplPostIds } = existingTplRes;
  const templates = (rawTemplates ?? []).map((t) => {
    const firstPost = Array.isArray(t.posts) ? t.posts[0] ?? null : t.posts;
    const normalizedPost = firstPost
      ? { ...firstPost, accounts: Array.isArray(firstPost.accounts) ? firstPost.accounts[0] ?? null : firstPost.accounts }
      : null;
    return { ...t, posts: normalizedPost };
  });
  const have = new Set((existingTplPostIds ?? []).map((t) => t.post_id));
  const missing = (eligiblePosts ?? []).filter((p) => !have.has(p.id)).length;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-4xl font-display tracking-tight">Templates</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {templates?.length ?? 0} templates from viral posts.
            {missing > 0 && ` · ${missing} viral post${missing === 1 ? "" : "s"} still need templating.`}
          </p>
        </div>
        <BackfillButton missing={missing} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TypePill href="/dashboard/templates" active={!postType}>All</TypePill>
        <TypePill href="/dashboard/templates?type=regular" active={postType === "regular"}>Regular</TypePill>
        <TypePill href="/dashboard/templates?type=lead_magnet" active={postType === "lead_magnet"}>Lead magnet</TypePill>
      </div>

      {templates && templates.length > 0 ? (
        <div className="space-y-4">
          {templates.map((t) => <TemplateRow key={t.id} row={t} />)}
        </div>
      ) : (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <div className="h-10 w-10 rounded-full bg-muted grid place-items-center mx-auto"><FileText className="h-5 w-5 text-muted-foreground" /></div>
            <div className="text-sm font-medium">No templates yet</div>
            <div className="text-xs text-muted-foreground">
              {missing > 0
                ? `${missing} viral posts are waiting. Click "Generate missing" above.`
                : "Templates are auto-generated when posts go viral."}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TypePill({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center text-xs px-3 py-1.5 rounded-full transition-all font-medium whitespace-nowrap",
        active
          ? "bg-foreground text-background shadow-soft"
          : "text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
    >
      {children}
    </Link>
  );
}
