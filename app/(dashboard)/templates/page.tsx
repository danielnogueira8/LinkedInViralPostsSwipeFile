import { supabaseAdmin } from "@/lib/supabase";
import { getTemplateThresholds } from "@/lib/viral";
import { TemplateRow } from "./row";
import { Card, CardContent } from "@/components/ui/card";
import { FileText } from "lucide-react";
import { BackfillButton } from "./backfill-button";
import Link from "next/link";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SP = { type?: string };

const POST_TYPES = new Set(["regular", "lead_magnet"]);

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const postType = sp.type && POST_TYPES.has(sp.type) ? sp.type : null;
  const sb = supabaseAdmin();
  const tplThresholds = await getTemplateThresholds();

  let tplQ = sb
    .from("templates")
    .select("*, posts!inner(id, text, post_url, reactions, comments, posted_at, post_type, accounts(name, niche))")
    .order("generated_at", { ascending: false })
    .limit(100);
  if (postType) tplQ = tplQ.eq("posts.post_type", postType);

  const [{ data: templates }, { data: eligiblePosts }, { data: existingTplPostIds }] = await Promise.all([
    tplQ,
    sb.from("posts")
      .select("id")
      .eq("is_viral", true)
      .not("text", "is", null)
      .or(`reactions.gte.${tplThresholds.min_reactions},comments.gte.${tplThresholds.min_comments}`),
    sb.from("templates").select("post_id"),
  ]);
  const have = new Set((existingTplPostIds ?? []).map((t) => t.post_id));
  const missing = (eligiblePosts ?? []).filter((p) => !have.has(p.id)).length;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Templates</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {templates?.length ?? 0} templates from viral posts.
            {missing > 0 && ` · ${missing} viral post${missing === 1 ? "" : "s"} still need templating.`}
          </p>
        </div>
        <BackfillButton missing={missing} />
        {/* The button auto-hides when there's nothing missing AND no active run */}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TypePill href="/templates" active={!postType}>All</TypePill>
        <TypePill href="/templates?type=regular" active={postType === "regular"}>Regular</TypePill>
        <TypePill href="/templates?type=lead_magnet" active={postType === "lead_magnet"}>Lead magnet</TypePill>
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
        "inline-flex items-center text-xs px-3 py-1.5 rounded-full transition-colors font-medium",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-card border border-border/70 text-muted-foreground hover:text-foreground hover:border-primary/30",
      )}
    >
      {children}
    </Link>
  );
}
