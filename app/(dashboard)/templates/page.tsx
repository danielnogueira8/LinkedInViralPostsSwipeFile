import { supabaseAdmin } from "@/lib/supabase";
import { getTemplateThresholds } from "@/lib/viral";
import { TemplateRow } from "./row";
import { Card, CardContent } from "@/components/ui/card";
import { FileText } from "lucide-react";
import { BackfillButton } from "./backfill-button";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const sb = supabaseAdmin();
  const tplThresholds = await getTemplateThresholds();
  const [{ data: templates }, { data: eligiblePosts }, { data: existingTplPostIds }] = await Promise.all([
    sb.from("templates").select("*, posts(id, text, post_url, reactions, comments, posted_at, accounts(name, niche))").order("generated_at", { ascending: false }).limit(100),
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
